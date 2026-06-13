import { useCallback, useEffect, useState } from "react";
import TranscriptPanel from "./components/TranscriptPanel.jsx";
import { useTranscriptSocket } from "./hooks/useTranscriptSocket.js";
import { useMicrophone } from "./hooks/useMicrophone.js";
import { useSpeechRecognition } from "./hooks/useSpeechRecognition.js";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:8001";

// Two language modes:
//
//   "en" — uses the existing AssemblyAI Universal-Streaming pipeline.
//          Audio captured by useMicrophone -> sent over WS as binary
//          PCM -> AAI -> server emits transcript / translation frames.
//
//   "hi" — uses the browser's built-in Web Speech API. AAI's streaming
//          model doesn't support Hindi yet, so the recognition happens
//          locally; finals are appended via addLocalFinal and shipped
//          to the server with `{type:"translate"}` so Gemini can do
//          the Hindi -> English translation.
const LANGS = {
  en: { label: "English", recogLang: null /* AAI */ },
  hi: { label: "Hindi", recogLang: "hi-IN" /* browser */ },
};

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
    addLocalFinal,
    setLocalInterim,
    requestTranslation,
  } = useTranscriptSocket(WS_URL);

  // ---- English / AAI mic path (unchanged) ---------------------------------

  const handleAudio = useCallback(
    (buffer) => {
      sendAudio(buffer);
    },
    [sendAudio]
  );

  const {
    active: micActive,
    error: micError,
    start: startMic,
    stop: stopMic,
  } = useMicrophone(handleAudio);

  // ---- Hindi / browser SpeechRecognition path -----------------------------

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

  // ---- start / stop branching ---------------------------------------------

  const wsConnected = status === "connected";
  const isHindi = language === "hi";
  const recording = isHindi ? recogActive : micActive;

  const canStart = isHindi
    ? recogSupported // browser STT path doesn't need the WS to be up
    : wsConnected;

  const handleStart = useCallback(async () => {
    if (isHindi) {
      await startRecog();
    } else {
      if (!wsConnected) return;
      startSession();
      await startMic();
    }
  }, [isHindi, startRecog, wsConnected, startSession, startMic]);

  const handleStop = useCallback(async () => {
    if (isHindi) {
      stopRecog();
    } else {
      await stopMic();
      stopSession();
    }
  }, [isHindi, stopRecog, stopMic, stopSession]);

  // If the server connection drops while recording in English mode,
  // release the mic so we don't keep capturing audio that has nowhere
  // to go. Hindi mode is independent of the WS connection (only the
  // translation step is, and it gracefully no-ops while disconnected).
  useEffect(() => {
    if (!wsConnected && micActive) {
      stopMic();
    }
  }, [wsConnected, micActive, stopMic]);

  // Stop recording when the user switches language so we don't end up
  // with two recognition sources running at once.
  useEffect(() => {
    if (micActive) stopMic();
    if (recogActive) stopRecog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  const errorMessage = serverError || micError || recogError;

  const hindiUnsupportedNote =
    isHindi && !recogSupported
      ? "Your browser doesn't support speech recognition. Hindi mode works best in Chrome or Edge."
      : null;

  const hindiTranslationDisconnectedNote =
    isHindi && recogActive && !wsConnected
      ? "Recording locally — translations will resume when the server reconnects."
      : null;

  return (
    <div
      className="min-h-screen w-full flex flex-col"
      style={{ backgroundColor: "#0f172a", color: "#ffffff" }}
    >
      <header className="px-6 py-4 border-b border-slate-700 flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-semibold tracking-tight">AI Transcriber</h1>
        <div className="flex items-center gap-4 text-sm">
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
              · {LANGS[language].label}
              {isHindi ? " (browser STT)" : " (AssemblyAI)"}
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
                Stop Microphone
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStart}
                disabled={!canStart}
                className="px-4 py-2 rounded-md text-sm font-medium bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-400 disabled:cursor-not-allowed transition-colors"
              >
                Start Microphone
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

        {!isHindi && micActive && sessionStatus !== "ready" ? (
          <div className="px-4 py-2 rounded-md bg-slate-800 border border-slate-700 text-slate-300 text-sm">
            Connecting to AssemblyAI…
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
