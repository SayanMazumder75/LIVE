import { useCallback, useEffect, useRef, useState } from "react";
import TranscriptPanel from "./components/TranscriptPanel.jsx";
import FloatingMicWidget from "./components/FloatingMicWidget.jsx";
import { useTranscriptSocket } from "./hooks/useTranscriptSocket.js";
import { useMixedAudio } from "./hooks/useMixedAudio.js";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:8001";

// How often (ms) to ship a buffered PCM chunk to Groq Whisper in
// Hindi mode. Whisper is "fast batch" not streaming, so we trade a
// little latency for accuracy: 4 s gives Whisper enough context to
// handle code-switching without cutting words mid-syllable too often,
// while still feeling roughly live.
const HINDI_CHUNK_MS = 4000;
// Drop chunks shorter than ~0.3 s (Whisper struggles on tiny clips
// and tends to hallucinate).
const HINDI_MIN_BYTES = 16000 * 2 * 0.3;
// Silence threshold for the chunk's normalized RMS (0..1). Below this,
// the chunk isn't sent to Whisper at all — same gate that keeps the
// app from burning Groq quota on silent stretches and getting
// silence-induced hallucinations back. Override at build time with
// VITE_HINDI_SILENCE_RMS if needed.
const HINDI_SILENCE_RMS = (() => {
  const raw = import.meta.env.VITE_HINDI_SILENCE_RMS;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0.01;
})();

// Two language modes:
//
//   "en" — AssemblyAI Universal-Streaming. Audio is forwarded
//          continuously over the WS as binary PCM and AAI emits
//          transcripts.
//
//   "hi" — Groq Whisper, batched. Audio is buffered into ~4 s
//          chunks; each non-silent chunk is shipped via the
//          existing {type:"hindi_chunk"} control message; the server
//          calls Whisper for STT and the existing Translator for
//          Hindi → English. The UI rendering shape (Hindi line + an
//          English translation underneath) is identical to what the
//          old browser-Web-Speech path produced.
//
// In both modes the audio source is the new mixed stream: system
// audio (always) plus the optional microphone (toggled from the
// floating widget). Backend is the same — it just sees PCM coming
// from the browser, doesn't know or care that mic was added.
const LANGS = {
  en: { label: "English" },
  hi: { label: "Hindi" },
};

function computePcm16Rms(arrayBuffer) {
  const view = new Int16Array(arrayBuffer);
  if (view.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < view.length; i++) {
    const v = view[i] / 32768;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / view.length);
}

export default function App() {
  const [language, setLanguage] = useState("en");

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
    requestHindiChunk,
  } = useTranscriptSocket(WS_URL);

  // ---- Hindi chunk buffer (preserved from previous releases) -------------

  const hindiBufferRef = useRef([]);
  // Track the current language inside a ref so the audio sink, which
  // is bound into the AudioWorklet's onmessage handler at start time,
  // sees the latest value without us having to re-attach the worklet.
  const langRef = useRef(language);
  useEffect(() => {
    langRef.current = language;
  }, [language]);

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

    // Voice-activity gate. Whisper hallucinates short Hindi or English
    // credit-tail words on near-silent audio; if RMS is below the
    // threshold we drop the chunk before spending a Groq request.
    const rms = computePcm16Rms(combined.buffer);
    if (rms < HINDI_SILENCE_RMS) {
      // eslint-disable-next-line no-console
      console.info(
        `[hindi] skipping silent chunk (rms=${rms.toFixed(4)} < ${HINDI_SILENCE_RMS})`
      );
      return;
    }

    const id = `hi-sys-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    requestHindiChunk(id, combined.buffer);
  }, [requestHindiChunk]);

  // ---- audio sink: routes mixed PCM by language --------------------------

  const handleAudio = useCallback(
    (buffer) => {
      if (langRef.current === "hi") {
        hindiBufferRef.current.push(buffer);
      } else {
        sendAudio(buffer);
      }
    },
    [sendAudio]
  );

  // ---- the unified mic+system capture ------------------------------------

  const {
    systemActive,
    micActive,
    error: audioError,
    micDevices,
    micDeviceId,
    setMicDeviceId,
    startSystem,
    stopSystem,
    enableMic,
    disableMic,
  } = useMixedAudio(handleAudio);

  // ---- mode helpers ------------------------------------------------------

  const wsConnected = status === "connected";
  const translating = systemActive;
  const isHindi = language === "hi";

  // ---- start / stop translation ------------------------------------------

  const handleStartTranslation = useCallback(async () => {
    if (!wsConnected) return;
    // Open the AAI session BEFORE starting capture in English mode so
    // server-side state is ready by the time the first PCM chunk
    // arrives. (This mirrors the previous English+Mic flow byte for
    // byte; the only thing that changes is that the audio source is
    // now `useMixedAudio` instead of `useMicrophone`.)
    if (language === "en") {
      startSession();
    }
    const ok = await startSystem();
    if (!ok && language === "en") {
      // User cancelled the share picker or sharing failed — close
      // the session we just opened so we don't burn AAI quota
      // waiting for audio that's never going to arrive.
      stopSession();
    }
  }, [wsConnected, language, startSession, startSystem, stopSession]);

  const handleStopTranslation = useCallback(async () => {
    await stopSystem();
    // Always send stop — server happily ignores it when there's no
    // active session.
    stopSession();
  }, [stopSystem, stopSession]);

  // ---- mic toggle (driven by the floating widget) ------------------------

  const handleToggleMic = useCallback(async () => {
    if (micActive) {
      await disableMic();
    } else {
      await enableMic(micDeviceId || undefined);
    }
  }, [micActive, micDeviceId, enableMic, disableMic]);

  // Item 8: closing the floating widget should stop mic capture
  // (system audio keeps running). useMixedAudio.disableMic() is
  // idempotent.
  const handleWidgetClose = useCallback(() => {
    if (micActive) {
      disableMic();
    }
  }, [micActive, disableMic]);

  // ---- effects: keep state coherent --------------------------------------

  // When system audio stops on its own (user clicked the browser's
  // "Stop sharing" indicator, or the source tab was closed), make sure
  // we also tear down the AAI session. useMixedAudio's stopSystem
  // sets systemActive=false; this effect catches that transition.
  const wasTranslatingRef = useRef(false);
  useEffect(() => {
    if (systemActive) {
      wasTranslatingRef.current = true;
      return;
    }
    if (wasTranslatingRef.current) {
      wasTranslatingRef.current = false;
      // Final flush of any tail Hindi audio before resetting.
      flushHindiChunk();
      hindiBufferRef.current = [];
      stopSession();
    }
  }, [systemActive, flushHindiChunk, stopSession]);

  // Periodic Hindi chunk flush while translating in Hindi mode.
  useEffect(() => {
    if (!(isHindi && systemActive)) return;
    const t = setInterval(flushHindiChunk, HINDI_CHUNK_MS);
    return () => {
      clearInterval(t);
      flushHindiChunk();
      hindiBufferRef.current = [];
    };
  }, [isHindi, systemActive, flushHindiChunk]);

  // If the WS drops while translating, release the capture so we
  // don't keep producing audio that has nowhere to go. Auto-reconnect
  // is in useTranscriptSocket; the user just clicks Start again.
  useEffect(() => {
    if (!wsConnected && systemActive) {
      stopSystem();
    }
  }, [wsConnected, systemActive, stopSystem]);

  // Switching language mid-session: stop the capture so we never end
  // up in a half-translated state, and clear any queued Hindi tail.
  useEffect(() => {
    if (systemActive) stopSystem();
    hindiBufferRef.current = [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  // Switching mic device while mic is on is handled inside
  // useMixedAudio.setMicDeviceId — it disables and re-enables the mic
  // on the new device. When mic is off we just remember the choice.

  const errorMessage = serverError || audioError;

  // Microphone device labels are only populated once permission has
  // been granted at least once. Before that, we still show the entries
  // but with placeholder labels so the user can pick something.
  const micOptions = (() => {
    const items = micDevices.map((d, i) => ({
      id: d.deviceId,
      label: d.label || `Microphone ${i + 1}`,
    }));
    return [{ id: "", label: "Default microphone" }, ...items];
  })();

  // Status string under the transcript header.
  const panelSubtitle = (() => {
    const langLabel = LANGS[language].label;
    const provider = isHindi ? "Whisper" : "AssemblyAI";
    if (!translating) {
      return `${langLabel} (${provider})`;
    }
    const sources = micActive ? "System Audio + Microphone" : "System Audio";
    return `${langLabel} (${provider} · ${sources})`;
  })();

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
              disabled={translating}
              className="bg-slate-800 border border-slate-600 rounded-md px-2 py-1 text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {Object.entries(LANGS).map(([code, { label }]) => (
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
              <span className={wsConnected ? "text-emerald-400" : "text-red-400"}>
                {wsConnected ? "Connected" : "Disconnected"}
              </span>
            </span>
          </div>
        </div>
      </header>

      <main className="flex-1 min-h-0 p-6 flex flex-col gap-4">
        {/* Microphone device selector — choosing here only takes effect
            when the floating widget actually turns the mic on. */}
        <label className="flex items-center gap-2 text-sm flex-wrap">
          <span className="text-slate-300">Microphone</span>
          <select
            value={micDeviceId}
            onChange={(e) => setMicDeviceId(e.target.value)}
            className="bg-slate-800 border border-slate-600 rounded-md px-2 py-1 text-white max-w-xs truncate"
            title="Used when the floating mic widget turns the mic on"
          >
            {micOptions.map((d) => (
              <option key={d.id || "__default__"} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-slate-500">
            (used when you turn the mic ON in the floating widget)
          </span>
        </label>

        <div className="flex items-center justify-between flex-wrap gap-3">
          <h2 className="text-lg font-medium text-slate-300">
            Live Transcript{" "}
            <span className="text-slate-500 text-sm font-normal">
              · {panelSubtitle}
            </span>
          </h2>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={clearTranscripts}
              disabled={finals.length === 0 && !interim}
              className="px-3 py-2 rounded-md text-sm font-medium bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors"
            >
              Clear
            </button>
            {translating ? (
              <button
                type="button"
                onClick={handleStopTranslation}
                className="px-4 py-2 rounded-md text-sm font-medium bg-red-600 hover:bg-red-500 transition-colors"
              >
                Stop Translation
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStartTranslation}
                disabled={!wsConnected}
                className="px-4 py-2 rounded-md text-sm font-medium bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-400 disabled:cursor-not-allowed transition-colors"
              >
                Start Translation
              </button>
            )}
            <FloatingMicWidget
              micActive={micActive}
              onMicToggle={handleToggleMic}
              onClose={handleWidgetClose}
              translationActive={translating}
              wsConnected={wsConnected}
              micError={audioError}
            />
          </div>
        </div>

        {errorMessage ? (
          <div className="px-4 py-2 rounded-md bg-red-950/60 border border-red-800 text-red-200 text-sm">
            {errorMessage}
          </div>
        ) : null}

        {!translating ? (
          <div className="px-4 py-2 rounded-md bg-slate-800 border border-slate-700 text-slate-300 text-sm">
            Click <span className="font-medium">Start Translation</span> and pick a
            tab (or "Entire Screen") in the share picker. Tick{" "}
            <span className="font-medium">Share tab audio</span> /{" "}
            <span className="font-medium">Share system audio</span>. Then open the
            mic widget if you also want to capture your own voice.
          </div>
        ) : null}

        {translating && !isHindi && sessionStatus !== "ready" ? (
          <div className="px-4 py-2 rounded-md bg-slate-800 border border-slate-700 text-slate-300 text-sm">
            Connecting to AssemblyAI…
          </div>
        ) : null}

        {translating && isHindi ? (
          <div className="px-4 py-2 rounded-md bg-slate-800 border border-slate-700 text-slate-300 text-sm">
            Captions appear about every {HINDI_CHUNK_MS / 1000} seconds (Whisper
            batches Hindi audio in chunks).
          </div>
        ) : null}

        <div className="flex-1 min-h-0">
          <TranscriptPanel finals={finals} interim={interim} />
        </div>
      </main>
    </div>
  );
}
