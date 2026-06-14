import { useCallback, useEffect, useRef, useState } from "react";
import AppLogo from "./components/AppLogo.jsx";
import FloatingMicWidget from "./components/FloatingMicWidget.jsx";
import {
  ExternalIcon,
  MicIcon,
  PlayIcon,
  StopIcon,
  SystemAudioIcon,
} from "./components/Icons.jsx";
import ThemeToggle from "./components/ThemeToggle.jsx";
import TranscriptColumn from "./components/TranscriptColumn.jsx";
import { useMicrophone } from "./hooks/useMicrophone.js";
import { useSystemAudio } from "./hooks/useSystemAudio.js";
import { useTheme } from "./hooks/useTheme.js";
import { useTranscriptionPipeline } from "./hooks/useTranscriptionPipeline.js";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:8001";

const LANGS = {
  en: { label: "English" },
  hi: { label: "Hindi" },
};

export default function App() {
  const { theme, toggle: toggleTheme } = useTheme();
  const [language, setLanguage] = useState("en");

  // ---- mic device enumeration -------------------------------------------
  // Lives at the top level so the device dropdown stays in sync with
  // the OS even when the mic is off. Labels are populated only after
  // the user has granted mic permission at least once, so we re-query
  // on `devicechange` and after the mic actually starts.

  const [micDevices, setMicDevices] = useState([]);
  const [micDeviceId, setMicDeviceId] = useState("");

  const refreshMicDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setMicDevices(all.filter((d) => d.kind === "audioinput"));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refreshMicDevices();
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return undefined;
    const handler = () => refreshMicDevices();
    md.addEventListener("devicechange", handler);
    return () => md.removeEventListener("devicechange", handler);
  }, [refreshMicDevices]);

  // ---- two parallel transcription pipelines -----------------------------
  // Each pipeline owns its own WebSocket → its own AAI session (or its
  // own Hindi-chunk stream). The backend treats them as independent
  // clients, so it doesn't need any source-awareness.

  // Active flags drive the per-pipeline Hindi flush timer. We tie them
  // to the audio capture state below.
  const [systemActive, setSystemActive] = useState(false);
  const [micActive, setMicActive] = useState(false);

  const sysPipeline = useTranscriptionPipeline({
    wsUrl: WS_URL,
    language,
    active: systemActive,
    sourceTag: "sys",
  });
  const micPipeline = useTranscriptionPipeline({
    wsUrl: WS_URL,
    language,
    active: micActive,
    sourceTag: "mic",
  });

  // Audio sinks: route each capture's PCM into its own pipeline.
  const handleSystemAudio = useCallback(
    (buffer) => {
      sysPipeline.sendAudio(buffer);
    },
    [sysPipeline]
  );
  const handleMicAudio = useCallback(
    (buffer) => {
      micPipeline.sendAudio(buffer);
    },
    [micPipeline]
  );

  const sysAudio = useSystemAudio(handleSystemAudio);
  const micAudio = useMicrophone(handleMicAudio);

  // Mirror the hooks' active state so the pipeline timers run only
  // while audio is actually flowing.
  useEffect(() => {
    setSystemActive(sysAudio.active);
  }, [sysAudio.active]);
  useEffect(() => {
    setMicActive(micAudio.active);
  }, [micAudio.active]);

  // ---- start / stop ------------------------------------------------------

  const wsConnected =
    sysPipeline.status === "connected" && micPipeline.status === "connected";
  const someConnected =
    sysPipeline.status === "connected" || micPipeline.status === "connected";

  // System stops on its own when the user clicks the browser's "Stop
  // sharing" indicator. Tear the pipeline session down too in that
  // case so AAI quota isn't wasted listening to nothing.
  const wasTranslatingRef = useRef(false);
  useEffect(() => {
    if (systemActive) {
      wasTranslatingRef.current = true;
      return;
    }
    if (wasTranslatingRef.current) {
      wasTranslatingRef.current = false;
      sysPipeline.resetBuffer();
      sysPipeline.stopSession();
      // Closing the system source implicitly ends translation — also
      // shut the mic pipeline down so we don't leave the user
      // accidentally speaking into a dead session.
      if (micAudio.active) {
        micAudio.stop();
        micPipeline.resetBuffer();
        micPipeline.stopSession();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemActive]);

  const handleStartTranslation = useCallback(async () => {
    if (!someConnected) return;
    if (language === "en") {
      sysPipeline.startSession();
    }
    const ok = await sysAudio.start();
    if (!ok && language === "en") {
      // User cancelled the share picker — roll back the AAI session
      // we just opened so we don't pay for silence.
      sysPipeline.stopSession();
    }
  }, [someConnected, language, sysPipeline, sysAudio]);

  const handleStopTranslation = useCallback(async () => {
    await sysAudio.stop();
    if (micAudio.active) {
      await micAudio.stop();
    }
    sysPipeline.stopSession();
    micPipeline.stopSession();
  }, [sysAudio, micAudio, sysPipeline, micPipeline]);

  // ---- mic toggle (driven by the floating widget) -----------------------

  const handleToggleMic = useCallback(async () => {
    if (micAudio.active) {
      await micAudio.stop();
      micPipeline.stopSession();
      return;
    }
    if (!sysAudio.active) {
      // Mic only makes sense when there's already a translation
      // session — otherwise it produces transcripts in isolation.
      // Refuse the toggle.
      return;
    }
    if (language === "en") {
      micPipeline.startSession();
    }
    await micAudio.start(micDeviceId || undefined);
    // Permission grant typically populates real device labels — refresh.
    refreshMicDevices();
  }, [
    micAudio,
    sysAudio.active,
    language,
    micPipeline,
    micDeviceId,
    refreshMicDevices,
  ]);

  // Closing the floating widget should stop the mic per the prior
  // PR's spec; system audio keeps running.
  const handleWidgetClose = useCallback(() => {
    if (micAudio.active) {
      micAudio.stop();
      micPipeline.stopSession();
    }
  }, [micAudio, micPipeline]);

  // ---- side-effects for state coherence ----------------------------------

  // If a WS drops while a capture is running, release that capture so
  // we don't keep producing audio that has nowhere to go. Auto-reconnect
  // is in useTranscriptSocket; the user just clicks Start again.
  useEffect(() => {
    if (sysPipeline.status !== "connected" && sysAudio.active) {
      sysAudio.stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sysPipeline.status]);
  useEffect(() => {
    if (micPipeline.status !== "connected" && micAudio.active) {
      micAudio.stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micPipeline.status]);

  // Switching language stops everything so we never end in a half-state.
  useEffect(() => {
    if (sysAudio.active) sysAudio.stop();
    if (micAudio.active) micAudio.stop();
    sysPipeline.stopSession();
    micPipeline.stopSession();
    sysPipeline.resetBuffer();
    micPipeline.resetBuffer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  // Swapping mic device while mic is on — restart on the new device.
  useEffect(() => {
    if (!micAudio.active) return;
    (async () => {
      await micAudio.stop();
      micPipeline.stopSession();
      if (language === "en") micPipeline.startSession();
      await micAudio.start(micDeviceId || undefined);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micDeviceId]);

  const errorMessage =
    sysPipeline.error ||
    micPipeline.error ||
    sysAudio.error ||
    micAudio.error ||
    null;

  const translating = systemActive;

  // Mic device list with a "Default microphone" placeholder.
  const micOptions = (() => {
    const items = micDevices.map((d, i) => ({
      id: d.deviceId,
      label: d.label || `Microphone ${i + 1}`,
    }));
    return [{ id: "", label: "Default microphone" }, ...items];
  })();

  return (
    <div className="min-h-screen w-full flex flex-col bg-[color:var(--bg)] text-[color:var(--text)]">
      {/* Header */}
      <header className="border-b border-[color:var(--border)] bg-[color:var(--bg-elevated)]">
        <div className="mx-auto max-w-7xl flex items-center justify-between gap-4 px-6 py-3.5 flex-wrap">
          <div className="flex items-center gap-3">
            <AppLogo className="h-9 w-9" />
            <div>
              <h1 className="text-base font-semibold tracking-tight leading-tight">
                AI Translator
              </h1>
              <p className="text-xs text-[color:var(--text-muted)] leading-tight">
                Real-time speech translation
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm flex-wrap">
            <label className="flex items-center gap-2">
              <span className="text-[color:var(--text-muted)]">Language</span>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                disabled={translating}
                className="rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--surface)] px-2.5 py-1.5 text-[color:var(--text)] disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
              >
                {Object.entries(LANGS).map(([code, { label }]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <ConnectionPill connected={wsConnected} />
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>
        </div>
      </header>

      {/* Body */}
      <main className="flex-1 min-h-0 mx-auto max-w-7xl w-full px-6 py-6 flex flex-col gap-5">
        {/* Controls row */}
        <section className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--bg-elevated)] shadow-sm">
          <div className="flex items-center justify-between gap-4 px-5 py-4 flex-wrap">
            <div className="flex items-center gap-4 flex-wrap">
              <label className="flex items-center gap-2 text-sm">
                <span className="text-[color:var(--text-muted)]">
                  Microphone
                </span>
                <select
                  value={micDeviceId}
                  onChange={(e) => setMicDeviceId(e.target.value)}
                  className="max-w-[18rem] truncate rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--surface)] px-2.5 py-1.5 text-[color:var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
                  title="Used when you turn the mic ON in the floating widget"
                >
                  {micOptions.map((d) => (
                    <option key={d.id || "__default__"} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => {
                  sysPipeline.clearTranscripts();
                  micPipeline.clearTranscripts();
                }}
                disabled={
                  sysPipeline.finals.length === 0 &&
                  !sysPipeline.interim &&
                  micPipeline.finals.length === 0 &&
                  !micPipeline.interim
                }
                className="px-3.5 py-2 rounded-lg text-sm font-medium border border-[color:var(--border-strong)] bg-[color:var(--surface)] text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)] hover:text-[color:var(--text)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Clear
              </button>
              {translating ? (
                <button
                  type="button"
                  onClick={handleStopTranslation}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-red-600 hover:bg-red-500 text-white transition-colors shadow-sm"
                >
                  <StopIcon className="h-4 w-4" />
                  Stop Translation
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStartTranslation}
                  disabled={!someConnected}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-[color:var(--accent)] hover:bg-[color:var(--accent-hover)] text-white disabled:bg-[color:var(--surface-2)] disabled:text-[color:var(--text-subtle)] disabled:cursor-not-allowed transition-colors shadow-sm"
                >
                  <PlayIcon className="h-4 w-4" />
                  Start Translation
                </button>
              )}
              <FloatingMicWidget
                micActive={micAudio.active}
                onMicToggle={handleToggleMic}
                onClose={handleWidgetClose}
                translationActive={translating}
                wsConnected={someConnected}
                micError={micAudio.error}
              />
            </div>
          </div>

          {!translating ? (
            <div className="px-5 pb-4 -mt-1 text-sm text-[color:var(--text-muted)]">
              Click <span className="font-medium text-[color:var(--text)]">Start Translation</span> and pick a tab (or "Entire Screen") in the share picker. Tick{" "}
              <span className="font-medium text-[color:var(--text)]">Share tab audio</span> /{" "}
              <span className="font-medium text-[color:var(--text)]">Share system audio</span>. Open the mic widget to also capture your voice.
            </div>
          ) : null}
        </section>

        {errorMessage ? (
          <div className="rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-700 dark:text-red-200">
            {errorMessage}
          </div>
        ) : null}

        {translating && language === "hi" ? (
          <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-2)] px-4 py-2.5 text-sm text-[color:var(--text-muted)]">
            Captions appear about every {sysPipeline.chunkIntervalMs / 1000} seconds (Whisper batches Hindi audio in chunks).
          </div>
        ) : null}

        {/* Two-column transcript area */}
        <section className="flex-1 min-h-0 grid gap-4 grid-cols-1 lg:grid-cols-2">
          <TranscriptColumn
            icon={<SystemAudioIcon className="h-5 w-5" />}
            title="System Audio"
            subtitle={
              language === "hi"
                ? "Whisper · tab / screen capture"
                : "AssemblyAI · tab / screen capture"
            }
            accent="indigo"
            finals={sysPipeline.finals}
            interim={sysPipeline.interim}
            active={systemActive}
            placeholder={
              <>
                Captions from the shared tab or screen will appear here. Click{" "}
                <span className="font-medium text-[color:var(--text)]">
                  Start Translation
                </span>{" "}
                and pick a source.
              </>
            }
          />
          <TranscriptColumn
            icon={<MicIcon className="h-5 w-5" />}
            title="Microphone"
            subtitle={
              language === "hi"
                ? "Whisper · your voice"
                : "AssemblyAI · your voice"
            }
            accent="violet"
            finals={micPipeline.finals}
            interim={micPipeline.interim}
            active={micActive}
            placeholder={
              translating ? (
                <>
                  Open the floating mic widget and turn it{" "}
                  <span className="font-medium text-[color:var(--text)]">ON</span>{" "}
                  to capture your voice. The widget stays visible across tabs.
                </>
              ) : (
                <>
                  Start translation first, then open the mic widget to capture your voice.
                </>
              )
            }
          />
        </section>

        <footer className="text-center text-xs text-[color:var(--text-muted)] flex items-center justify-center gap-2 flex-wrap">
          <span>System Audio + Microphone are transcribed independently.</span>
          <span aria-hidden="true">·</span>
          <span>
            Backend keys: AssemblyAI (English) + Groq Whisper / Llama (Hindi).
          </span>
        </footer>
      </main>
    </div>
  );
}

/** Connection-status pill — green when both pipelines are happy. */
function ConnectionPill({ connected }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium ${
        connected
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300 ring-1 ring-emerald-200/60 dark:ring-emerald-400/20"
          : "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300 ring-1 ring-red-200/60 dark:ring-red-400/20"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          connected ? "bg-emerald-500" : "bg-red-500"
        } ${connected ? "" : "animate-pulse"}`}
        aria-hidden="true"
      />
      {connected ? "Connected" : "Reconnecting"}
    </span>
  );
}
