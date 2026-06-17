import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useSessionPersistence
 * ---------------------
 * Thin client for the four session-storage routes ported from the old
 * MeetMind project's `server.js`:
 *
 *     POST /start-session            — create a new session, return id
 *     POST /push                     — append a finalized line of text
 *     GET  /transcripts              — list saved sessions (newest first)
 *     GET  /transcript/:session_id   — load one saved session's text
 *
 * The app uses this hook from `App.jsx` to:
 *   1. start a session when the user clicks Start Translation,
 *   2. push every finalized transcript line to /push as it lands,
 *   3. list / load past sessions in the SessionHistory sidebar.
 *
 * Persistence is **best-effort**. Network errors are logged and
 * surfaced via `error` state but never throw — the live translation
 * pipeline keeps working regardless. This matches the old project's
 * behaviour, where a Mongo write failure also just logged and moved
 * on without interrupting the UI.
 *
 * The same pushed-id set is used for the original line and (if it
 * arrives later) the translation line, so each transcript turn ends up
 * stored at most twice — once for the source-language final, and once
 * for the translation. That's how the live UI renders Hindi-mode lines
 * (Hindi text + English under it), and the saved transcript reads the
 * same way.
 *
 * @param {string} httpUrl  Base URL of the session API. Defaults to
 *                          `http://localhost:8000`. Override with
 *                          `VITE_HTTP_URL` for non-default deploys.
 */
export function useSessionPersistence(httpUrl) {
  const baseUrl = (httpUrl || "http://localhost:8000").replace(/\/+$/, "");

  const [sessionId, setSessionId] = useState(null);
  const [persistenceEnabled, setPersistenceEnabled] = useState(true);
  const [error, setError] = useState(null);
  // Backend-supplied reason persistence is off (auth failure, IP
  // allowlist, malformed URI, etc.) — surfaced via a UI banner so the
  // user can fix .env without scraping backend logs.
  const [persistenceReason, setPersistenceReason] = useState("");
  // Cloudinary state. Reported by GET / so the UI can tell the user
  // whether session recordings will actually be saved (vs. lost on
  // refresh) before they hit Start Translation. Defaults to true so
  // we don't flash a "disabled" banner before the first probe lands.
  const [recordingEnabled, setRecordingEnabled] = useState(true);
  const [recordingReason, setRecordingReason] = useState("");

  // Stable ref so push callbacks always read the *current* session_id
  // without being recreated by React.
  const sessionIdRef = useRef(null);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Track which lines we've already pushed. Keys are either
  //   `${id}`              — for the source-language final
  // or
  //   `${id}:translation`  — for the (later) translation.
  // A Set ref instead of state because we mutate it from inside an
  // effect and don't want to re-render on every push.
  const pushedRef = useRef(new Set());

  // ── helpers ────────────────────────────────────────────────────────────

  const _post = useCallback(
    async (path, body) => {
      const url = `${baseUrl}${path}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      if (res.status === 503) {
        // Backend says persistence is disabled. Try to capture the
        // classified reason ('Authentication failed', 'IP not allowed',
        // 'MONGO_URI is malformed', ...) so the UI can tell the user
        // exactly what to fix in backend/.env.
        let reason = "";
        try {
          const data = await res.json();
          reason = (data && (data.error || (data.diagnostics && data.diagnostics.error))) || "";
        } catch (_e) {
          /* ignore */
        }
        setPersistenceEnabled(false);
        setPersistenceReason(reason || "Session persistence is disabled on the backend.");
        return null;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${path} ${res.status} ${text}`);
      }
      return res.json();
    },
    [baseUrl]
  );

  const _get = useCallback(
    async (path) => {
      const url = `${baseUrl}${path}`;
      const res = await fetch(url);
      if (res.status === 503) {
        let reason = "";
        try {
          const data = await res.json();
          reason = (data && (data.error || (data.diagnostics && data.diagnostics.error))) || "";
        } catch (_e) {
          /* ignore */
        }
        setPersistenceEnabled(false);
        setPersistenceReason(reason || "Session persistence is disabled on the backend.");
        return null;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${path} ${res.status} ${text}`);
      }
      return res.json();
    },
    [baseUrl]
  );

  // ── probe persistence state on mount ──────────────────────────────────
  // Hits the backend's `GET /` once so the UI can show the right
  // banner *before* the user tries to start a session. Without this,
  // the user would only learn persistence is broken after their first
  // /start-session 503.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${baseUrl}/`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const enabled = data && data.persistence === "enabled";
        setPersistenceEnabled(enabled);
        if (!enabled) {
          const reason =
            (data && data.diagnostics && data.diagnostics.error) ||
            "Session persistence is disabled on the backend.";
          setPersistenceReason(reason);
        } else {
          setPersistenceReason("");
        }
        // Recording (Cloudinary) state lives alongside persistence on
        // GET /, so we read both in the same probe.
        const rec = data && data.recording;
        if (rec && typeof rec === "object") {
          setRecordingEnabled(Boolean(rec.enabled));
          setRecordingReason(rec.enabled ? "" : (rec.error || ""));
        }
      } catch (e) {
        // Backend HTTP server isn't reachable — we'll fall back to
        // the 503 path on first user action.
        if (!cancelled) {
          setPersistenceEnabled(false);
          setPersistenceReason(
            `Could not reach session API at ${baseUrl}. Is the backend running?`
          );
          setRecordingEnabled(false);
          setRecordingReason(
            `Could not reach session API at ${baseUrl}.`
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  // ── start a session ────────────────────────────────────────────────────

  const startSession = useCallback(async () => {
    setError(null);
    try {
      const data = await _post("/start-session", {});
      if (!data || !data.session_id) {
        // 503 / disabled — clear any previous id so we don't push to
        // a stale one.
        setSessionId(null);
        pushedRef.current = new Set();
        return null;
      }
      setSessionId(data.session_id);
      // Fresh session = fresh pushed-id ledger.
      pushedRef.current = new Set();
      return data.session_id;
    } catch (e) {
      console.warn("[session] start-session failed:", e);
      setError(`Could not start session: ${e.message}`);
      return null;
    }
  }, [_post]);

  // ── push one line ──────────────────────────────────────────────────────

  const pushLine = useCallback(
    async (line) => {
      const id = sessionIdRef.current;
      if (!id || !persistenceEnabled) return false;
      if (!line || typeof line !== "string") return false;
      try {
        const data = await _post("/push", { session_id: id, text: line });
        if (data === null) return false; // disabled mid-flight
        return Boolean(data && data.ok);
      } catch (e) {
        // Don't disable persistence on a single transient push error;
        // log it and keep the live pipeline running.
        console.warn("[session] push failed:", e);
        setError(`Push failed: ${e.message}`);
        return false;
      }
    },
    [_post, persistenceEnabled]
  );

  // ── push a batch of finalized lines, deduped by id ─────────────────────

  /**
   * Walk through `finals` (in order) and push any line we haven't
   * already pushed. Used by App.jsx in a useEffect that watches
   * `mergedFinals`.
   *
   * Each `final` is `{id, text, translation, source, createdAt}`. We
   * push:
   *   - `[SOURCE] [HH:MM:SS] text`               on first sight
   *   - `[SOURCE] [HH:MM:SS] -> translation`     when translation arrives
   *
   * Same dedup key shape used by the pushedRef set (`id` and
   * `${id}:translation`).
   */
  const flushFinals = useCallback(
    async (finals) => {
      if (!sessionIdRef.current || !persistenceEnabled) return;
      if (!Array.isArray(finals) || finals.length === 0) return;
      const pushed = pushedRef.current;

      // Build the pending list synchronously, mark as pushed *before*
      // awaiting, so re-entry of this function (next finals update)
      // doesn't queue a duplicate request for the same line. If the
      // network call later fails, we accept the loss — better that
      // than a flood of duplicates that the live UI never had.
      const pending = [];
      for (const line of finals) {
        if (!line || !line.id) continue;
        const source = (line.source === "mic" ? "MIC" : "SYSTEM");
        const stamp = formatTimestamp(line.createdAt);

        if (line.text && !pushed.has(line.id)) {
          pushed.add(line.id);
          pending.push(`[${source}] [${stamp}] ${line.text}`);
        }

        if (line.translation) {
          const tKey = `${line.id}:translation`;
          if (!pushed.has(tKey)) {
            pushed.add(tKey);
            pending.push(`[${source}] [${stamp}] → ${line.translation}`);
          }
        }
      }

      // Push sequentially so the saved order matches the on-screen
      // order even if /push latencies jitter.
      for (const text of pending) {
        await pushLine(text);
      }
    },
    [pushLine, persistenceEnabled]
  );

  // ── save AI Meeting Intelligence into the existing session ────────────
  // POST /insights → updates `session.insights = { summary, keyPoints,
  // actionItems, topics, timeline, flashcards, quiz, studyVault }`. No
  // separate collection or document — everything lives on the same
  // session record as the transcript, so a future GET /transcript/:id
  // returns the whole meeting in one query.
  const saveInsights = useCallback(
    async (insights, explicitSessionId = null) => {
      // `explicitSessionId` is supplied when the user is viewing a
      // saved session in the main page and re-saves insights there —
      // the write must target *that* session, not whichever live
      // session is currently active. Falling back to the live id
      // keeps the original "save during live recording" path working.
      const id =
        (typeof explicitSessionId === "string" && explicitSessionId.trim()) ||
        sessionIdRef.current;
      if (!id) {
        const msg =
          "No active session. Click Start Translation first so the " +
          "insights have a session to attach to.";
        setError(msg);
        return { ok: false, reason: "no-session", message: msg };
      }
      if (!persistenceEnabled) {
        const msg =
          "Session persistence is disabled. Set MONGO_URI in backend/.env.";
        setError(msg);
        return { ok: false, reason: "disabled", message: msg };
      }
      if (!insights || typeof insights !== "object") {
        return { ok: false, reason: "bad-payload", message: "no insights to save" };
      }
      try {
        const data = await _post("/insights", { session_id: id, insights });
        if (data === null) {
          return { ok: false, reason: "disabled", message: "Persistence disabled" };
        }
        if (data && data.ok) {
          return { ok: true, sessionId: id };
        }
        return { ok: false, reason: "unknown", message: "Backend returned non-ok" };
      } catch (e) {
        console.warn("[session] save insights failed:", e);
        const msg = `Save insights failed: ${e.message}`;
        setError(msg);
        return { ok: false, reason: "error", message: msg };
      }
    },
    [_post, persistenceEnabled]
  );

  // ── session history ────────────────────────────────────────────────────

  const listSessions = useCallback(async () => {
    setError(null);
    try {
      const data = await _get("/transcripts");
      if (data === null) return [];
      return Array.isArray(data) ? data : [];
    } catch (e) {
      console.warn("[session] list /transcripts failed:", e);
      setError(`Could not list sessions: ${e.message}`);
      return [];
    }
  }, [_get]);

  const loadSession = useCallback(
    async (sid) => {
      if (!sid) return null;
      setError(null);
      try {
        const data = await _get(`/transcript/${encodeURIComponent(sid)}`);
        if (data === null) return null;
        // Always return the structured shape so callers can rely on
        // `.text`, `.insights`, `.audioUrl`, and `.audioDuration`
        // regardless of whether the session had any AI Meeting
        // Intelligence or recorded audio. Older records without a
        // field get a falsy default.
        if (typeof data === "string") {
          return { text: data, insights: null, audioUrl: "", audioDuration: 0 };
        }
        return {
          text: typeof data?.text === "string" ? data.text : "",
          insights: data?.insights || null,
          audioUrl: typeof data?.audioUrl === "string" ? data.audioUrl : "",
          audioDuration: Number(data?.audioDuration) || 0,
        };
      } catch (e) {
        console.warn("[session] load /transcript failed:", e);
        setError(`Could not load session: ${e.message}`);
        return null;
      }
    },
    [_get]
  );

  // ── upload a full-session audio recording ─────────────────────────────
  // Mirrors the old project's POST /upload-audio call. The blob is
  // built by useMixedAudio.stopRecording(); we just stream it through
  // a multipart form so aiohttp can hand it to Cloudinary.
  //
  // Returns:
  //   { ok: true, audioUrl, audioDuration }
  //   { ok: false, reason: "no-session"|"disabled"|"size"|"error", message }
  // Never throws — failures are best-effort like every other
  // persistence method, so a Cloudinary outage doesn't break the
  // live UI.
  const uploadRecording = useCallback(
    async (sid, blob, mimeType) => {
      const targetId =
        (typeof sid === "string" && sid.trim()) || sessionIdRef.current;
      if (!targetId) {
        return {
          ok: false,
          reason: "no-session",
          message: "no active session to attach the recording to",
        };
      }
      if (!persistenceEnabled) {
        return {
          ok: false,
          reason: "disabled",
          message: "Session persistence is disabled.",
        };
      }
      if (!recordingEnabled) {
        return {
          ok: false,
          reason: "disabled",
          message:
            recordingReason ||
            "Audio recording is disabled on the backend (Cloudinary not configured).",
        };
      }
      if (!blob || !(blob instanceof Blob) || blob.size === 0) {
        return {
          ok: false,
          reason: "size",
          message: "no recorded audio to upload",
        };
      }

      const ext = pickExtension(mimeType || blob.type);
      const filename = `session-${targetId}.${ext}`;
      const file = new File([blob], filename, {
        type: mimeType || blob.type || "audio/webm",
      });

      const form = new FormData();
      form.append("session_id", targetId);
      form.append("audio", file, filename);

      try {
        const res = await fetch(`${baseUrl}/upload-audio`, {
          method: "POST",
          body: form,
        });
        if (res.status === 503) {
          let reason = "";
          try {
            const data = await res.json();
            reason =
              (data && (data.error || (data.diagnostics && data.diagnostics.error))) ||
              "";
          } catch (_e) {
            /* ignore */
          }
          setRecordingEnabled(false);
          setRecordingReason(reason || "Audio recording is disabled on the backend.");
          return { ok: false, reason: "disabled", message: reason };
        }
        if (res.status === 404) {
          return {
            ok: false,
            reason: "no-session",
            message: "session not found on the backend",
          };
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`upload-audio ${res.status} ${text}`);
        }
        const data = await res.json();
        return {
          ok: true,
          audioUrl: data?.audioUrl || "",
          audioDuration: data?.audioDuration || 0,
        };
      } catch (e) {
        console.warn("[session] upload-audio failed:", e);
        const msg = `Recording upload failed: ${e.message}`;
        setError(msg);
        return { ok: false, reason: "error", message: msg };
      }
    },
    [baseUrl, persistenceEnabled, recordingEnabled, recordingReason]
  );

  // Permanently remove a session from MongoDB (transcript + insights
  // + audio metadata, all in one shot — there's only one document
  // per session by design). The frontend handles the user-confirmation
  // popup; this method assumes the user already said yes.
  //
  // Returns:
  //   { ok: true }                      — session deleted.
  //   { ok: false, reason: "missing" }  — backend says no such id (404).
  //   { ok: false, reason: "disabled" } — MongoDB persistence is off.
  //   { ok: false, reason: "error", message: "..." } — network / 5xx.
  const deleteSession = useCallback(
    async (sid) => {
      if (!sid) return { ok: false, reason: "missing", message: "no id" };
      if (!persistenceEnabled) {
        return {
          ok: false,
          reason: "disabled",
          message: "Session persistence is disabled.",
        };
      }
      try {
        const url = `${baseUrl}/transcript/${encodeURIComponent(sid)}`;
        const res = await fetch(url, { method: "DELETE" });
        if (res.status === 503) {
          let reason = "";
          try {
            const data = await res.json();
            reason =
              (data && (data.error || (data.diagnostics && data.diagnostics.error))) ||
              "";
          } catch (_e) {
            /* ignore */
          }
          setPersistenceEnabled(false);
          setPersistenceReason(reason || "Session persistence is disabled on the backend.");
          return { ok: false, reason: "disabled", message: reason };
        }
        if (res.status === 404) {
          // Already gone — caller can treat as success and refresh.
          return { ok: false, reason: "missing", message: "session not found" };
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`DELETE ${res.status} ${text}`);
        }
        return { ok: true };
      } catch (e) {
        console.warn("[session] delete failed:", e);
        const msg = `Delete failed: ${e.message}`;
        setError(msg);
        return { ok: false, reason: "error", message: msg };
      }
    },
    [baseUrl, persistenceEnabled]
  );

  // ── reset (used when user clears transcripts client-side) ──────────────

  const resetSession = useCallback(() => {
    setSessionId(null);
    pushedRef.current = new Set();
  }, []);

  return {
    sessionId,
    persistenceEnabled,
    persistenceReason,
    recordingEnabled,
    recordingReason,
    error,
    startSession,
    pushLine,
    flushFinals,
    saveInsights,
    uploadRecording,
    listSessions,
    loadSession,
    deleteSession,
    resetSession,
  };
}

/**
 * Map a MIME type from MediaRecorder to a sensible filename
 * extension. Cloudinary sniffs by MIME first but having a real
 * extension on the multipart filename helps when the upload is
 * proxied through tools that strip headers.
 */
function pickExtension(mime) {
  if (!mime) return "webm";
  const m = mime.toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  return "webm";
}

/** Format a Date / ms timestamp as HH:MM:SS — matches old server.js. */
function formatTimestamp(input) {
  const d = input ? new Date(input) : new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
