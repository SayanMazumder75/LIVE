import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TranscriptPanel from "./components/TranscriptPanel.jsx";
import FloatingMicWidget from "./components/FloatingMicWidget.jsx";
import { useTranscriptSocket } from "./hooks/useTranscriptSocket.js";
import { useMixedAudio } from "./hooks/useMixedAudio.js";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:8001";

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
  const langRef = useRef(language);
  useEffect(() => {
    langRef.current = language;
  }, [language]);

  // ── Two independent socket instances ────────────────────────────────────
  // Each connection → its own AAI session → its own finals array.
  // sysSocket stamps source:"system", micSocket stamps source:"mic".

  const sysSocket = useTranscriptSocket(WS_URL, "system");
  const micSocket = useTranscriptSocket(WS_URL, "mic");

  // ── Hindi system-audio buffer (drives sysSocket) ────────────────────────
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
      console.info(
        `[hindi-sys] skipping silent chunk (rms=${rms.toFixed(4)} < ${HINDI_SILENCE_RMS})`
      );
      return;
    }

    const id = `hi-sys-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    sysSocket.requestHindiChunk(id, combined.buffer);
  }, [sysSocket.requestHindiChunk]);

  // ── Hindi mic-audio buffer (drives micSocket) ───────────────────────────
  // In Hindi + Mic mode the browser's Web Speech API does the STT locally,
  // so the mic audio never needs Whisper. But if you ever want to route mic
  // PCM through Whisper for Hindi too, the buffer + flush is wired here.
  // For now the mic socket in Hindi mode uses the Web Speech / requestTranslation
  // path (same as before), so this is a no-op placeholder.
  //
  // NOTE: Hindi + Mic via Web Speech API still calls micSocket.addLocalFinal
  // and micSocket.requestTranslation from FloatingMicWidget / its parent —
  // that path is unchanged; it never goes through the audio pipeline.

  // ── Audio pipeline callbacks ────────────────────────────────────────────

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
      // Mic audio always goes to micSocket as raw PCM (English mode).
      // Hindi + Mic uses Web Speech API, so the audio worklet is idle
      // in that mode (the mic track runs but no stream is sent because
      // micSocket.startSession() is not called for Hindi).
      micSocket.sendAudio(buffer);
    },
    [micSocket.sendAudio]
  );

  // ── Audio capture ────────────────────────────────────────────────────────

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

  // ── Derived state ────────────────────────────────────────────────────────

  const wsConnected = sysSocket.status === "connected";
  const translating = systemActive;
  const isHindi = language === "hi";

  // Merge finals from both sockets into one append-ordered list.
  // We use a simple concat + stable sort by the array index (insertion
  // order) so the UI reflects when lines arrived relative to each other.
  // Since both arrays are already in insertion order and React batches
  // state updates, we interleave by keeping both arrays separate in
  // TranscriptPanel if needed — but for now a flat concat is correct
  // because each socket's array is already time-ordered and the combined
  // stream is shown newest-at-bottom.
  const mergedFinals = useMemo(
    () => [...sysSocket.finals, ...micSocket.finals].sort((a, b) => {
      // Both ids encode creation time in their prefix.
      // Primary sort: numeric prefix extracted from the id string.
      // Fallback: original array position (stable).
      const tsA = parseInt(a.id.replace(/\D.*/, ""), 10) || 0;
      const tsB = parseInt(b.id.replace(/\D.*/, ""), 10) || 0;
      return tsA - tsB;
    }),
    [sysSocket.finals, micSocket.finals]
  );

  // Per-source interims. Each socket already owns its own interim
  // state stamped with its source identity at emission time; we forward
  // them to TranscriptPanel separately instead of collapsing them into
  // one string. That way mic interim renders on the RIGHT (mic-styled)
  // and sys interim renders on the LEFT (sys-styled) — fixing the
  // "transcript appears as System and only later moves to Microphone"
  // bug. The source is decided BEFORE rendering: the moment the
  // micSocket / sysSocket onmessage handler stamps the line, not after.
  const sysInterim = sysSocket.interim;
  const micInterim = micSocket.interim;
  const anyInterim = Boolean(sysInterim || micInterim);

  // ── Session lifecycle ────────────────────────────────────────────────────

  const handleStartTranslation = useCallback(async () => {
    if (!wsConnected) return;

    if (language === "en") {
      // Start AAI sessions on BOTH sockets so system and mic each get
      // their own independent stream.
      sysSocket.startSession();
      micSocket.startSession();
    }
    // Hindi: sessions are not pre-opened; sysSocket uses hindi_chunk
    // and micSocket uses Web Speech / requestTranslation on demand.

    const ok = await startSystem();
    if (!ok && language === "en") {
      sysSocket.stopSession();
      micSocket.stopSession();
    }
  }, [
    wsConnected,
    language,
    sysSocket.startSession,
    sysSocket.stopSession,
    micSocket.startSession,
    micSocket.stopSession,
    startSystem,
  ]);

  const handleStopTranslation = useCallback(async () => {
    await stopSystem();
    sysSocket.stopSession();
    micSocket.stopSession();
  }, [stopSystem, sysSocket.stopSession, micSocket.stopSession]);

  const handleToggleMic = useCallback(async () => {
    if (micActive) {
      await disableMic();
    } else {
      await enableMic(micDeviceId || undefined);
    }
  }, [micActive, micDeviceId, enableMic, disableMic]);

  const handleWidgetClose = useCallback(() => {
    if (micActive) disableMic();
  }, [micActive, disableMic]);

  const clearTranscripts = useCallback(() => {
    sysSocket.clearTranscripts();
    micSocket.clearTranscripts();
  }, [sysSocket.clearTranscripts, micSocket.clearTranscripts]);

  // ── Hindi system-audio flush intervals ──────────────────────────────────

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
      sysSocket.stopSession();
      micSocket.stopSession();
    }
  }, [systemActive, flushHindiSysChunk, sysSocket.stopSession, micSocket.stopSession]);

  useEffect(() => {
    if (!(isHindi && systemActive)) return;
    const t = setInterval(flushHindiSysChunk, HINDI_CHUNK_MS);
    return () => {
      clearInterval(t);
      flushHindiSysChunk();
      hindiSysBufRef.current = [];
    };
  }, [isHindi, systemActive, flushHindiSysChunk]);

  // Stop everything when WS drops.
  useEffect(() => {
    if (!wsConnected && systemActive) {
      stopSystem();
    }
  }, [wsConnected, systemActive, stopSystem]);

  // Stop and clear Hindi buffers on language switch.
  useEffect(() => {
    if (systemActive) stopSystem();
    hindiSysBufRef.current = [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  // ── UI helpers ───────────────────────────────────────────────────────────

  const errorMessage =
    sysSocket.error || micSocket.error || audioError || null;

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

  // Session-ready check: for English we need BOTH sockets ready before
  // suppressing the "Connecting…" banner. In Hindi mode sessions aren't
  // pre-opened so we skip the check.
  const bothReady =
    sysSocket.sessionStatus === "ready" &&
    (micActive ? micSocket.sessionStatus === "ready" : true);

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
              disabled={mergedFinals.length === 0 && !anyInterim}
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

        {translating && !isHindi && !bothReady ? (
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
          <TranscriptPanel
            finals={mergedFinals}
            sysInterim={sysInterim}
            micInterim={micInterim}
          />
        </div>
      </main>
    </div>
  );
}