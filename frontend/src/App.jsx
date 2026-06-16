import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TranscriptPanel from "./components/TranscriptPanel.jsx";
import FloatingMicWidget from "./components/FloatingMicWidget.jsx";
import SessionHistory from "./components/SessionHistory.jsx";
import { useTranscriptSocket } from "./hooks/useTranscriptSocket.js";
import { useMixedAudio } from "./hooks/useMixedAudio.js";
import { useSessionPersistence } from "./hooks/useSessionPersistence.js";
import InsightsPanel from "./components/InsightsPanel.jsx";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:8001";
// Session persistence (MongoDB) — same shape as the old MeetMind
// project's HTTP API. Override with VITE_HTTP_URL when the backend
// HTTP server runs on a different host/port from localhost:8000.
const HTTP_URL = import.meta.env.VITE_HTTP_URL || "http://localhost:8000";

const HINDI_CHUNK_MS = 4000;
const HINDI_MIN_BYTES = 16000 * 2 * 0.3;
const HINDI_SILENCE_RMS = (() => {
  const raw = import.meta.env.VITE_HINDI_SILENCE_RMS;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0.01;
})();

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

  const sysSocket = useTranscriptSocket(WS_URL);
  const micSocket = useTranscriptSocket(WS_URL);

  // ── Session persistence (MongoDB, ported from MeetMind server.js) ────
  // Lifecycle: startSession() runs on Start Translation; every new
  // finalized line in `mergedFinals` is pushed via /push; the
  // SessionHistory drawer lists past sessions and loads them on demand.
  // Persistence is best-effort — failures don't interrupt the live
  // pipeline.
  const persistence = useSessionPersistence(HTTP_URL);
  const [historyOpen, setHistoryOpen] = useState(false);

  const langRef = useRef(language);
  useEffect(() => { langRef.current = language; }, [language]);

  // ── Hindi system-audio buffer (unchanged) ─────────────────────────────
  const hindiSysBufRef = useRef([]);

  const flushHindiSysChunk = useCallback(() => {
    const chunks = hindiSysBufRef.current;
    if (chunks.length === 0) return;
    hindiSysBufRef.current = [];

    const totalBytes = chunks.reduce((s, c) => s + c.byteLength, 0);
    if (totalBytes < HINDI_MIN_BYTES) return;

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const c of chunks) {
      combined.set(new Uint8Array(c), offset);
      offset += c.byteLength;
    }

    const rms = computePcm16Rms(combined.buffer);
    if (rms < HINDI_SILENCE_RMS) {
      console.info(`[hindi-sys] skipping silent chunk (rms=${rms.toFixed(4)} < ${HINDI_SILENCE_RMS})`);
      return;
    }

    const id = `hi-sys-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    sysSocket.requestHindiChunk(id, combined.buffer);
  }, [sysSocket.requestHindiChunk]);

  // ── Hindi mic-audio buffer (TASK 2: same pipeline as sys, routes to micSocket) ──
  const hindiMicBufRef = useRef([]);

  const flushHindiMicChunk = useCallback(() => {
    const chunks = hindiMicBufRef.current;
    if (chunks.length === 0) return;
    hindiMicBufRef.current = [];

    const totalBytes = chunks.reduce((s, c) => s + c.byteLength, 0);
    if (totalBytes < HINDI_MIN_BYTES) return;   // same min-bytes gate

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const c of chunks) {
      combined.set(new Uint8Array(c), offset);
      offset += c.byteLength;
    }

    const rms = computePcm16Rms(combined.buffer);  // same RMS gate
    if (rms < HINDI_SILENCE_RMS) {
      console.info(`[hindi-mic] skipping silent chunk (rms=${rms.toFixed(4)} < ${HINDI_SILENCE_RMS})`);
      return;
    }

    const id = `hi-mic-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    micSocket.requestHindiChunk(id, combined.buffer); // same requestHindiChunk → same backend Whisper path
  }, [micSocket.requestHindiChunk]);

  // ── Audio pipeline callbacks ───────────────────────────────────────────
  const handleSystemAudio = useCallback(
    (buffer) => {
      if (langRef.current === "hi") {
        hindiSysBufRef.current.push(buffer);
      } else {
        sysSocket.sendAudio(buffer);
      }
    },
    [sysSocket.sendAudio]
  );

  const handleMicAudio = useCallback(
    (buffer) => {
      if (langRef.current === "hi") {
        hindiMicBufRef.current.push(buffer); // TASK 2: buffer for Whisper, not dropped
      } else {
        micSocket.sendAudio(buffer);
      }
    },
    [micSocket.sendAudio]
  );

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
  } = useMixedAudio(handleSystemAudio, handleMicAudio);

  // ── mode helpers ──────────────────────────────────────────────────────
  const wsConnected = sysSocket.status === "connected";
  const translating = systemActive;
  const isHindi = language === "hi";

  // ── start / stop translation ──────────────────────────────────────────
  const handleStartTranslation = useCallback(async () => {
    if (!wsConnected) return;
    // Create a new MongoDB session (best-effort — silently no-ops when
    // the backend has no MONGO_URI). Mirrors the old project's
    // POST /start-session at the start of every recording.
    persistence.startSession();
    if (language === "en") {
      sysSocket.startSession();
    }
    const ok = await startSystem();
    if (!ok && language === "en") {
      sysSocket.stopSession();
    }
  }, [wsConnected, language, sysSocket.startSession, startSystem, sysSocket.stopSession, persistence.startSession]);

  const handleStopTranslation = useCallback(async () => {
    await stopSystem();
    sysSocket.stopSession();
    micSocket.stopSession();
  }, [stopSystem, sysSocket.stopSession, micSocket.stopSession]);

  // ── mic toggle ────────────────────────────────────────────────────────
  const handleToggleMic = useCallback(async () => {
    if (micActive) {
      await disableMic();
      micSocket.stopSession();
    } else {
      const ok = await enableMic(micDeviceId || undefined);
      if (ok && language === "en") {
        micSocket.startSession();
      }
    }
  }, [micActive, micDeviceId, enableMic, disableMic, language,
      micSocket.startSession, micSocket.stopSession]);

  const handleWidgetClose = useCallback(() => {
    if (micActive) {
      disableMic();
      micSocket.stopSession();
    }
  }, [micActive, disableMic, micSocket.stopSession]);

  // ── effects: keep state coherent ─────────────────────────────────────
  const wasTranslatingRef = useRef(false);
  useEffect(() => {
    if (systemActive) {
      wasTranslatingRef.current = true;
      return;
    }
    if (wasTranslatingRef.current) {
      wasTranslatingRef.current = false;
      flushHindiSysChunk();
      hindiSysBufRef.current = [];
      flushHindiMicChunk();         // TASK 2: flush mic tail on stop
      hindiMicBufRef.current = [];
      sysSocket.stopSession();
      micSocket.stopSession();
    }
  }, [systemActive, flushHindiSysChunk, flushHindiMicChunk,
      sysSocket.stopSession, micSocket.stopSession]);

  // Sys Hindi flush interval (unchanged)
  useEffect(() => {
    if (!(isHindi && systemActive)) return;
    const t = setInterval(flushHindiSysChunk, HINDI_CHUNK_MS);
    return () => {
      clearInterval(t);
      flushHindiSysChunk();
      hindiSysBufRef.current = [];
    };
  }, [isHindi, systemActive, flushHindiSysChunk]);

  // TASK 2: Mic Hindi flush interval — identical timer, tied to micActive
  useEffect(() => {
    if (!(isHindi && micActive)) return;
    const t = setInterval(flushHindiMicChunk, HINDI_CHUNK_MS);
    return () => {
      clearInterval(t);
      flushHindiMicChunk();
      hindiMicBufRef.current = [];
    };
  }, [isHindi, micActive, flushHindiMicChunk]);

  useEffect(() => {
    if (!wsConnected && systemActive) {
      stopSystem();
    }
  }, [wsConnected, systemActive, stopSystem]);

  useEffect(() => {
    if (systemActive) stopSystem();
    hindiSysBufRef.current = [];
    hindiMicBufRef.current = []; // TASK 2: clear mic buf on lang switch too
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  // ── merge finals ──────────────────────────────────────────────────────
  const mergedFinals = useMemo(() => {
    const sysFinals = sysSocket.finals.map((l) => ({ ...l, source: "system" }));
    const micFinals = micSocket.finals.map((l) => ({ ...l, source: "mic" }));
    return [...sysFinals, ...micFinals].sort(
      (a, b) => (a.createdAt || 0) - (b.createdAt || 0)
    );
  }, [sysSocket.finals, micSocket.finals]);

  // ── persist finalized lines to MongoDB ────────────────────────────────
  // Mirrors the old project's per-flush `Session.findOneAndUpdate`
  // append. The hook itself dedupes by id + translation-id, so this
  // effect can run on every render of mergedFinals without producing
  // duplicate /push calls. Interim transcripts are NOT in
  // `mergedFinals` (the WebSocket layer keeps those in `interim` only),
  // so this naturally stores finalized lines only — same invariant as
  // the old project's flushBuffer.
  useEffect(() => {
    persistence.flushFinals(mergedFinals);
  }, [mergedFinals, persistence.flushFinals]);

  const interim = micActive && micSocket.interim
    ? micSocket.interim
    : sysSocket.interim;

  const clearTranscripts = useCallback(() => {
    sysSocket.clearTranscripts();
    micSocket.clearTranscripts();
    // Detach from the in-progress MongoDB session so future finals
    // start a fresh push-id ledger; the saved session record itself
    // remains in MongoDB (visible in the History drawer).
    persistence.resetSession();
  }, [sysSocket.clearTranscripts, micSocket.clearTranscripts, persistence.resetSession]);

  const sessionStatus = sysSocket.sessionStatus;
  const errorMessage =
    sysSocket.error || micSocket.error || audioError || persistence.error;

  const micOptions = (() => {
    const items = micDevices.map((d, i) => ({
      id: d.deviceId,
      label: d.label || `Microphone ${i + 1}`,
    }));
    return [{ id: "", label: "Default microphone" }, ...items];
  })();

  const panelSubtitle = (() => {
    const langLabel = LANGS[language].label;
    const provider = isHindi ? "Whisper" : "AssemblyAI";
    if (!translating) return `${langLabel} (${provider})`;
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
                <option key={code} value={code}>{label}</option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={`inline-block h-2.5 w-2.5 rounded-full ${wsConnected ? "bg-emerald-500" : "bg-red-500"}`}
            />
            <span className="text-slate-200">
              Status:{" "}
              <span className={wsConnected ? "text-emerald-400" : "text-red-400"}>
                {wsConnected ? "Connected" : "Disconnected"}
              </span>
            </span>
          </div>
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            title={
              persistence.persistenceEnabled
                ? "Browse saved sessions"
                : "Backend has no MONGO_URI — sessions are not being saved"
            }
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 transition-colors"
          >
            History
            {persistence.sessionId ? (
              <span className="ml-1.5 text-xs text-emerald-400">●</span>
            ) : null}
          </button>
        </div>
      </header>

      <main className="flex-1 min-h-0 p-6 flex flex-col gap-4">
        <label className="flex items-center gap-2 text-sm flex-wrap">
          <span className="text-slate-300">Microphone</span>
          <select
            value={micDeviceId}
            onChange={(e) => setMicDeviceId(e.target.value)}
            className="bg-slate-800 border border-slate-600 rounded-md px-2 py-1 text-white max-w-xs truncate"
            title="Used when the floating mic widget turns the mic on"
          >
            {micOptions.map((d) => (
              <option key={d.id || "__default__"} value={d.id}>{d.label}</option>
            ))}
          </select>
          <span className="text-xs text-slate-500">
            (used when you turn the mic ON in the floating widget)
          </span>
        </label>

        <div className="flex items-center justify-between flex-wrap gap-3">
          <h2 className="text-lg font-medium text-slate-300">
            Live Transcript{" "}
            <span className="text-slate-500 text-sm font-normal">· {panelSubtitle}</span>
          </h2>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={clearTranscripts}
              disabled={mergedFinals.length === 0 && !interim}
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

        {!persistence.persistenceEnabled && persistence.persistenceReason ? (
          <div className="px-4 py-2 rounded-md bg-amber-950/40 border border-amber-700 text-amber-200 text-sm">
            <div className="font-medium mb-1">
              Session history is off — transcripts won't be saved to MongoDB.
            </div>
            <div className="text-amber-100/90">{persistence.persistenceReason}</div>
            <div className="mt-1 text-xs text-amber-300/80">
              Live transcription still works. Edit{" "}
              <code className="text-amber-100">backend/.env</code> and restart
              the backend (<code className="text-amber-100">python main.py</code>)
              to enable saving.
            </div>
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
            Captions appear about every {HINDI_CHUNK_MS / 1000} seconds (Whisper batches Hindi audio in chunks).
          </div>
        ) : null}

        <div className="flex-1 min-h-0">
          <TranscriptPanel finals={mergedFinals} interim={interim} />
        </div>

        <div className="mt-4">
          <InsightsPanel finals={mergedFinals} />
        </div>
      </main>

      <SessionHistory
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        listSessions={persistence.listSessions}
        loadSession={persistence.loadSession}
        currentSessionId={persistence.sessionId}
      />
    </div>
  );
}