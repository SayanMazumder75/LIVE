import { useCallback, useEffect, useRef, useState } from "react";

const RECONNECT_DELAY_MS = 3000;

/**
 * Manages the WebSocket connection to the transcription bridge.
 *
 * Each `useEffect` run owns its own closure-scoped state (`destroyed`,
 * `currentWs`, `reconnectTimer`). The WebSocket event handlers compare
 * the firing socket against `currentWs` before mutating React state, so
 * a late `onclose` from a cancelled connection cannot affect the current
 * one. This is what makes the hook safe under React 18 StrictMode dev
 * mode (where effects mount → cleanup → mount in quick succession) and
 * under genuine reconnects.
 *
 * Dev-mode WebSocket warning
 * --------------------------
 * The very first WebSocket creation is deferred via `setTimeout(0)` so
 * StrictMode's mount → cleanup → mount cycle (which runs synchronously)
 * happens *before* the connection actually starts. Without this, Chrome
 * logs "WebSocket is closed before the connection is established"
 * because the still-CONNECTING first socket gets cancelled in cleanup.
 * The warning is harmless but noisy; the deferred connect eliminates
 * it. In production builds StrictMode doesn't double-invoke effects, so
 * this `setTimeout(0)` is a no-op there.
 *
 * Returns:
 *   status        : "connected" | "disconnected"
 *   sessionStatus : "idle" | "ready" | "stopped" | "error"
 *   finals        : Array<{id, text, translation: string|null}>
 *                   append-only finalized lines; `translation` may be
 *                   filled in later when the backend's Gemini step
 *                   completes (or stay null if not configured / no-op).
 *   interim       : string                current in-progress turn
 *   error         : string | null
 *
 *   startSession() / stopSession() / sendAudio(buffer) / clearTranscripts()
 *
 * Hindi-mode helpers (used when the browser does the recognition
 * locally because AAI doesn't support the language):
 *   addLocalFinal(text)       — append a finalized line, returns its id
 *   setLocalInterim(text)     — overwrite the current in-progress line
 *   requestTranslation(id, t) — ask the backend to translate `t` and
 *                                attach the result to the line `id`
 */
export function useTranscriptSocket(url) {
  const [status, setStatus] = useState("disconnected");
  const [sessionStatus, setSessionStatus] = useState("idle");
  const [finals, setFinals] = useState([]);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState(null);

  // Read by the imperative API (`startSession` / `sendAudio` / ...).
  const wsRef = useRef(null);

  useEffect(() => {
    let destroyed = false;
    let currentWs = null;
    let reconnectTimer = null;
    let initialConnectScheduled = false;

    let connect = () => {};

    const scheduleReconnect = () => {
      if (destroyed || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!destroyed) connect();
      }, RECONNECT_DELAY_MS);
    };

    const wrappedConnect = () => {
      if (destroyed) return;

      let ws;
      try {
        ws = new WebSocket(url);
      } catch (_e) {
        setStatus("disconnected");
        scheduleReconnect();
        return;
      }
      ws.binaryType = "arraybuffer";
      currentWs = ws;
      wsRef.current = ws;

      ws.onopen = () => {
        if (ws !== currentWs || destroyed) return;
        setStatus("connected");
      };

      ws.onmessage = (event) => {
        if (ws !== currentWs || destroyed) return;
        if (typeof event.data !== "string") return;

        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!msg || typeof msg !== "object") return;

        if (msg.type === "transcript" && typeof msg.text === "string") {
          if (msg.final) {
            // Prefer the server-provided id so translation frames can
            // attach to the right line. Fall back to a local id only
            // if the server didn't send one (older backends).
            const id =
              typeof msg.id === "string" && msg.id
                ? msg.id
                : `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            setFinals((prev) => [
              ...prev,
              { id, text: msg.text, translation: null },
            ]);
            setInterim("");
          } else {
            setInterim(msg.text);
          }
        } else if (
          msg.type === "translation" &&
          typeof msg.id === "string" &&
          typeof msg.text === "string"
        ) {
          // Attach the translation to the matching finalized line.
          // No-op if the line is gone (e.g. user clicked Clear).
          setFinals((prev) =>
            prev.map((line) =>
              line.id === msg.id ? { ...line, translation: msg.text } : line
            )
          );
        } else if (msg.type === "status" && typeof msg.status === "string") {
          setSessionStatus(msg.status);
          if (msg.status === "stopped") setInterim("");
          if (msg.status === "ready") setError(null);
        } else if (msg.type === "error") {
          setError(msg.message || "Unknown server error");
          setSessionStatus("error");
        }
      };

      ws.onerror = () => {
        // Browser fires `onclose` next; the reconnect path lives there.
      };

      ws.onclose = () => {
        // Ignore close events for sockets we've already replaced or
        // intentionally cancelled — this is the lock that fixes the
        // StrictMode-dev double-mount race.
        if (ws !== currentWs) return;

        currentWs = null;
        if (wsRef.current === ws) wsRef.current = null;

        if (destroyed) return;
        setStatus("disconnected");
        setSessionStatus("idle");
        setInterim("");
        scheduleReconnect();
      };
    };

    connect = wrappedConnect;

    // Defer the very first connect by a setTimeout(0) so StrictMode's
    // dev-mode mount → cleanup → mount cycle (which runs synchronously)
    // happens *before* we open a WebSocket. Without this delay, the
    // first WebSocket would be cancelled mid-handshake during cleanup,
    // and Chrome would log a benign but noisy "WebSocket is closed
    // before the connection is established" warning. In production
    // (no StrictMode double-invoke) this is just a one-tick delay.
    const initialConnectTimer = setTimeout(() => {
      initialConnectScheduled = false;
      if (destroyed) return;
      connect();
    }, 0);
    initialConnectScheduled = true;

    return () => {
      destroyed = true;
      if (initialConnectScheduled) {
        clearTimeout(initialConnectTimer);
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const ws = currentWs;
      currentWs = null;
      if (wsRef.current === ws) wsRef.current = null;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* noop */
        }
      }
    };
  }, [url]);

  const startSession = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setError(null);
    ws.send(JSON.stringify({ type: "start" }));
  }, []);

  const stopSession = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "stop" }));
  }, []);

  const sendAudio = useCallback((arrayBuffer) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(arrayBuffer);
  }, []);

  const clearTranscripts = useCallback(() => {
    setFinals([]);
    setInterim("");
  }, []);

  // --- Hindi-mode helpers --------------------------------------------------
  // These let the UI inject locally-recognized transcripts (e.g. from the
  // browser's Web Speech API) into the same `finals` / `interim` state that
  // backend transcripts use, so the rendering layer doesn't have to know
  // where the text came from. Translations are still requested via the
  // server (`requestTranslation`) and arrive over the existing message
  // channel as `{type:"translation", id, text}`.

  const addLocalFinal = useCallback((text) => {
    const trimmed = (text || "").trim();
    if (!trimmed) return null;
    const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setFinals((prev) => [
      ...prev,
      { id, text: trimmed, translation: null },
    ]);
    setInterim("");
    return id;
  }, []);

  const setLocalInterim = useCallback((text) => {
    setInterim(text || "");
  }, []);

  const requestTranslation = useCallback((id, text) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!id || !text) return;
    ws.send(JSON.stringify({ type: "translate", id, text }));
  }, []);

  return {
    status,
    sessionStatus,
    finals,
    interim,
    error,
    startSession,
    stopSession,
    sendAudio,
    clearTranscripts,
    // Hindi-mode helpers
    addLocalFinal,
    setLocalInterim,
    requestTranslation,
  };
}
