import { useCallback, useEffect, useRef, useState } from "react";
import TranscriptPanel from "./components/TranscriptPanel.jsx";
import { useTranscriptSocket } from "./hooks/useTranscriptSocket.js";
import { useMicrophone } from "./hooks/useMicrophone.js";
import { useSystemAudio } from "./hooks/useSystemAudio.js";
import { useSpeechRecognition } from "./hooks/useSpeechRecognition.js";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:8001";

// How often (ms) to ship a buffered PCM chunk to Groq Whisper in
// Hindi + System Audio mode. Whisper is "fast batch" not streaming, so
// we trade a little latency for accuracy: 4 s gives Whisper enough
// context to handle code-switching and avoids cutting words mid-syllable
// too often, while still feeling roughly live.
const HINDI_CHUNK_MS = 4000;
// Drop chunks shorter than ~0.3 s of audio (16 kHz mono int16 = 32 B/ms)
// — Whisper struggles on tiny clips and they often produce hallucinations.
const HINDI_MIN_BYTES = 16000 * 2 * 0.3;

// Two language modes:
//
//   "en" — uses the existing AssemblyAI Universal-Streaming pipeline.
//          Audio captured by useMicrophone or useSystemAudio -> sent
//          over WS as binary PCM -> AAI -> server emits transcript /
//          translation frames.
//
//   "hi" — Hindi. Two sub-modes depending on the audio source:
//
//          - Hindi + Microphone: uses the browser's Web Speech API
//            (`hi-IN`). Recognition happens locally; finals are
//            appended via addLocalFinal and shipped to the server with
//            `{type:"translate"}` so Groq does the Hindi -> English
//            translation step.
//
//          - Hindi + System Audio: the Web Speech API can't ingest a
//            getDisplayMedia stream, so we capture system audio
//            (YouTube tab, Meet call, etc.) into the same PCM
//            pipeline as English mode and ship buffered ~4 s chunks
//            to the server with `{type:"hindi_chunk"}`. The server
//            calls Groq Whisper (Hindi STT) and then Groq Llama
//            (Hindi -> English translation) and emits the same
//            transcript + translation frames the UI already knows
//            how to render.
const LANGS = {
  en: { label: "English", recogLang: null /* AAI */ },
  hi: { label: "Hindi", recogLang: "hi-IN" /* browser */ },
};

// Two audio sources. Both are now valid in both languages.
const SOURCES = {
  mic: { label: "Microphone" },
  system: { label: "System Audio" },
};

export default function App() {
  const [language, setLanguage] = useState("en");
  const [audioSource, setAudioSource] = useState("mic");

  const {
    status,
    sessionStatus,
    finals,
    interim,
    error: serverError,
    startSession,
    stopSession,
    sendAudio,
    clearTranscripts,
    addLocalFinal,
    setLocalInterim,
    requestTranslation,
    requestHindiChunk,
  } = useTranscriptSocket(WS_URL);

  // ---- mode helpers --------------------------------------------------------

  const wsConnected = status === "connected";
  const isHindi = language === "hi";
  const isSystemAudio = audioSource === "system";
  const isHindiSystem = isHindi && isSystemAudio;

  // ---- Hindi + System Audio: buffered chunked path ------------------------
  // While this mode is active, every PCM chunk from useSystemAudio is
  // appended to a buffer instead of going straight onto the WS. A
  // periodic timer flushes the buffer to the server as one binary
  // payload + a {type:"hindi_chunk", id} JSON envelope.

  const hindiBufferRef = useRef([]);

  const flushHindiChunk = useCallback(() => {
    const chunks = hindiBufferRef.current;
    if (chunks.length === 0) return;
    hindiBufferRef.current = [];

    const totalBytes = chunks.reduce((s, c) => s + c.byteLength, 0);
    if (totalBytes < HINDI_MIN_BYTES) return;

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const c of chunks) {
      combined.set(new Uint8Array(c), offset);
      offset += c.byteLength;
    }
    const id = `hi-sys-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    requestHindiChunk(id, combined.buffer);
  }, [requestHindiChunk]);

  // ---- Audio chunk sink (shared by mic and system-audio paths) ------------
  // Both capture hooks call into this with the same PCM16 ArrayBuffer
  // shape; the host picks where the chunks go based on the current mode.
  // Crucially, the English paths (mic and system) and Hindi + Mic
  // remain byte-identical to before — they all hit `sendAudio(buffer)`.
  // Only Hindi + System Audio takes the buffered branch.

  // Track the current mode in a ref so the audio callback (which is
  // referenced from inside the AudioWorklet's onmessage closure) sees
  // the latest values without the worklet needing to be re-attached
  // every time the mode changes.
  const modeRef = useRef({ isHindiSystem });
  useEffect(() => {
    modeRef.current.isHindiSystem = isHindiSystem;
  }, [isHindiSystem]);

  const handleAudio = useCallback(
    (buffer) => {
      if (modeRef.current.isHindiSystem) {
        hindiBufferRef.current.push(buffer);
      } else {
        sendAudio(buffer);
      }
    },
    [sendAudio]
  );

  // ---- English / AAI mic path (UNCHANGED from previous releases) ----------

  const {
    active: micActive,
    error: micError,
    start: startMic,
    stop: stopMic,
  } = useMicrophone(handleAudio);

  // ---- System-audio capture (used by both English+System and Hindi+System)

  const {
    active: sysActive,
    error: sysError,
    start: startSys,
    stop: stopSys,
  } = useSystemAudio(handleAudio);

  // ---- Hindi / browser SpeechRecognition path (Hindi + Mic only) ----------

  const handleHindiFinal = useCallback(
    (text) => {
      const id = addLocalFinal(text);
      if (id) requestTranslation(id, text);
    },
    [addLocalFinal, requestTranslation]
  );

  const handleHindiInterim = useCallback(
    (text) => {
      setLocalInterim(text);
    },
    [setLocalInterim]
  );

  const {
    supported: recogSupported,
    active: recogActive,
    error: recogError,
    start: startRecog,
    stop: stopRecog,
  } = useSpeechRecognition({
    lang: LANGS[language].recogLang || "en-US",
    onFinal: handleHindiFinal,
    onInterim: handleHindiInterim,
  });

  // ---- recording state -----------------------------------------------------

  // What is "currently capturing"? The button label / disabled state
  // and the "stop everything" effects all key off this.
  const recording = isHindiSystem
    ? sysActive
    : isHindi
    ? recogActive
    : isSystemAudio
    ? sysActive
    : micActive;

  const canStart = isHindiSystem
    ? wsConnected // need WS to ship chunks to Whisper
    : isHindi
    ? recogSupported // browser STT path doesn't need WS to be up
    : wsConnected;

  // ---- start / stop branching ---------------------------------------------

  const handleStart = useCallback(async () => {
    if (isHindiSystem) {
      // NEW path. Order mirrors English+System: capture FIRST so a
      // cancelled share picker doesn't leave anything dangling. We do
      // NOT call startSession() — the AAI session is for the streaming
      // English flow; Hindi chunks are standalone Whisper requests
      // dispatched per chunk by `requestHindiChunk`.
      if (!wsConnected) return;
      const ok = await startSys();
      if (!ok) return;
      return;
    }
    if (isHindi) {
      // Hindi + Mic — UNCHANGED.
      await startRecog();
      return;
    }
    if (isSystemAudio) {
      // English + System — UNCHANGED.
      if (!wsConnected) return;
      const ok = await startSys();
      if (!ok) return;
      startSession();
      return;
    }
    // English + Mic — UNCHANGED order/logic from previous releases.
    if (!wsConnected) return;
    startSession();
    await startMic();
  }, [
    isHindiSystem,
    isHindi,
    isSystemAudio,
    startRecog,
    startSys,
    wsConnected,
    startSession,
    startMic,
  ]);

  const handleStop = useCallback(async () => {
    if (isHindiSystem) {
      // NEW path. Stop the system-audio capture; the chunk-flush
      // effect's cleanup will do a final flush of any buffered tail.
      await stopSys();
      return;
    }
    if (isHindi) {
      stopRecog();
      return;
    }
    if (isSystemAudio) {
      await stopSys();
      stopSession();
      return;
    }
    // Mic path — UNCHANGED.
    await stopMic();
    stopSession();
  }, [
    isHindiSystem,
    isHindi,
    isSystemAudio,
    stopRecog,
    stopSys,
    stopMic,
    stopSession,
  ]);

  // While Hindi+System is actively capturing, run a periodic flush
  // timer. The cleanup also does a final flush so the tail of the
  // recording isn't lost when the user clicks Stop.
  useEffect(() => {
    if (!(isHindiSystem && sysActive)) return;
    const timer = setInterval(flushHindiChunk, HINDI_CHUNK_MS);
    return () => {
      clearInterval(timer);
      flushHindiChunk();
      hindiBufferRef.current = [];
    };
  }, [isHindiSystem, sysActive, flushHindiChunk]);

  // If the server connection drops, release whichever WS-dependent
  // capture is running so we don't keep producing audio that has
  // nowhere to go. Hindi+Mic is independent of the WS — only the
  // translation step is, and it gracefully no-ops while disconnected.
  useEffect(() => {
    if (wsConnected) return;
    if (micActive) stopMic();
    if (sysActive) stopSys();
  }, [wsConnected, micActive, sysActive, stopMic, stopSys]);

  // Stop all captures when the user switches language or audio source
  // so we never end up with two sources running at once. Also clear
  // any leftover Hindi chunk buffer so a stale tail doesn't get sent
  // under the wrong mode after the switch.
  useEffect(() => {
    if (micActive) stopMic();
    if (sysActive) stopSys();
    if (recogActive) stopRecog();
    hindiBufferRef.current = [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, audioSource]);

  const errorMessage = serverError || micError || sysError || recogError;

  const hindiUnsupportedNote =
    isHindi && !isSystemAudio && !recogSupported
      ? "Your browser doesn't support speech recognition. Hindi mic mode works best in Chrome or Edge."
      : null;

  const hindiTranslationDisconnectedNote =
    isHindi && !isSystemAudio && recogActive && !wsConnected
      ? "Recording locally — translations will resume when the server reconnects."
      : null;

  // Tells the user *what* they need to tick in the share picker. Only
  // shown while system-audio mode is selected and not yet capturing.
  const systemAudioHint =
    isSystemAudio && !sysActive
      ? 'When the share picker opens, choose a Tab or Entire Screen and tick "Share tab audio" / "Share system audio".'
      : null;

  // Hindi+System has noticeably higher latency than the streaming
  // paths because Whisper batches per chunk. Tell the user once.
  const hindiSystemLatencyNote =
    isHindiSystem && sysActive
      ? "Captions appear about every " +
        HINDI_CHUNK_MS / 1000 +
        " seconds (Whisper batches Hindi audio in chunks)."
      : null;

  // Source-aware button label / panel subtitle.
  const buttonNoun = isSystemAudio ? "System Audio" : "Microphone";
  const panelSubtitle = isHindiSystem
    ? `${LANGS[language].label} (Whisper · ${SOURCES[audioSource].label})`
    : isHindi
    ? `${LANGS[language].label} (browser STT)`
    : `${LANGS[language].label} (AssemblyAI · ${SOURCES[audioSource].label})`;

  return (
    <div
      className="min-h-screen w-full flex flex-col"
      style={{ backgroundColor: "#0f172a", color: "#ffffff" }}
    >
      <header className="px-6 py-4 border-b border-slate-700 flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-semibold tracking-tight">AI Transcriber</h1>
        <div className="flex items-center gap-4 text-sm flex-wrap">
          <label className="flex items-center gap-2">
            <span className="text-slate-300">Language</span>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={recording}
              className="bg-slate-800 border border-slate-600 rounded-md px-2 py-1 text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {Object.entries(LANGS).map(([code, { label }]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-slate-300">Source</span>
            <select
              value={audioSource}
              onChange={(e) => setAudioSource(e.target.value)}
              disabled={recording}
              className="bg-slate-800 border border-slate-600 rounded-md px-2 py-1 text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {Object.entries(SOURCES).map(([code, { label }]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={`inline-block h-2.5 w-2.5 rounded-full ${
                wsConnected ? "bg-emerald-500" : "bg-red-500"
              }`}
            />
            <span className="text-slate-200">
              Status:{" "}
              <span
                className={wsConnected ? "text-emerald-400" : "text-red-400"}
              >
                {wsConnected ? "Connected" : "Disconnected"}
              </span>
            </span>
          </div>
        </div>
      </header>

      <main className="flex-1 min-h-0 p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h2 className="text-lg font-medium text-slate-300">
            Live Transcript{" "}
            <span className="text-slate-500 text-sm font-normal">
              · {panelSubtitle}
            </span>
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={clearTranscripts}
              disabled={finals.length === 0 && !interim}
              className="px-3 py-2 rounded-md text-sm font-medium bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors"
            >
              Clear
            </button>
            {recording ? (
              <button
                type="button"
                onClick={handleStop}
                className="px-4 py-2 rounded-md text-sm font-medium bg-red-600 hover:bg-red-500 transition-colors"
              >
                Stop {buttonNoun}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStart}
                disabled={!canStart}
                className="px-4 py-2 rounded-md text-sm font-medium bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-400 disabled:cursor-not-allowed transition-colors"
              >
                Start {buttonNoun}
              </button>
            )}
          </div>
        </div>

        {errorMessage ? (
          <div className="px-4 py-2 rounded-md bg-red-950/60 border border-red-800 text-red-200 text-sm">
            {errorMessage}
          </div>
        ) : null}

        {hindiUnsupportedNote ? (
          <div className="px-4 py-2 rounded-md bg-amber-950/60 border border-amber-800 text-amber-200 text-sm">
            {hindiUnsupportedNote}
          </div>
        ) : null}

        {systemAudioHint ? (
          <div className="px-4 py-2 rounded-md bg-slate-800 border border-slate-700 text-slate-300 text-sm">
            {systemAudioHint}
          </div>
        ) : null}

        {!isHindi && (micActive || sysActive) && sessionStatus !== "ready" ? (
          <div className="px-4 py-2 rounded-md bg-slate-800 border border-slate-700 text-slate-300 text-sm">
            Connecting to AssemblyAI…
          </div>
        ) : null}

        {hindiSystemLatencyNote ? (
          <div className="px-4 py-2 rounded-md bg-slate-800 border border-slate-700 text-slate-300 text-sm">
            {hindiSystemLatencyNote}
          </div>
        ) : null}

        {hindiTranslationDisconnectedNote ? (
          <div className="px-4 py-2 rounded-md bg-slate-800 border border-slate-700 text-slate-300 text-sm">
            {hindiTranslationDisconnectedNote}
          </div>
        ) : null}

        <div className="flex-1 min-h-0">
          <TranscriptPanel finals={finals} interim={interim} />
        </div>
      </main>
    </div>
  );
}
