import { useCallback, useEffect } from "react";
import TranscriptPanel from "./components/TranscriptPanel.jsx";
import { useTranscriptSocket } from "./hooks/useTranscriptSocket.js";
import { useMicrophone } from "./hooks/useMicrophone.js";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:8001";

export default function App() {
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
  } = useTranscriptSocket(WS_URL);

  // Push every PCM chunk produced by the worklet straight to the server.
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

  const wsConnected = status === "connected";

  const handleStart = useCallback(async () => {
    if (!wsConnected) return;
    startSession();
    await startMic();
  }, [wsConnected, startSession, startMic]);

  const handleStop = useCallback(async () => {
    await stopMic();
    stopSession();
  }, [stopMic, stopSession]);

  // If the server connection drops while recording, release the mic so
  // we don't keep capturing audio that has nowhere to go.
  useEffect(() => {
    if (!wsConnected && micActive) {
      stopMic();
    }
  }, [wsConnected, micActive, stopMic]);

  const errorMessage = serverError || micError;

  return (
    <div
      className="min-h-screen w-full flex flex-col"
      style={{ backgroundColor: "#0f172a", color: "#ffffff" }}
    >
      <header className="px-6 py-4 border-b border-slate-700 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">AI Transcriber</h1>
        <div className="flex items-center gap-2 text-sm">
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
      </header>

      <main className="flex-1 min-h-0 p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h2 className="text-lg font-medium text-slate-300">Live Transcript</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={clearTranscripts}
              disabled={finals.length === 0 && !interim}
              className="px-3 py-2 rounded-md text-sm font-medium bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors"
            >
              Clear
            </button>
            {micActive ? (
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
                disabled={!wsConnected}
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

        {micActive && sessionStatus !== "ready" ? (
          <div className="px-4 py-2 rounded-md bg-slate-800 border border-slate-700 text-slate-300 text-sm">
            Connecting to AssemblyAI…
          </div>
        ) : null}

        <div className="flex-1 min-h-0">
          <TranscriptPanel finals={finals} interim={interim} />
        </div>
      </main>
    </div>
  );
}
