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

    const scheduleReconnect = () => {
      if (destroyed || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!destroyed) connect();
      }, RECONNECT_DELAY_MS);
    };

    const connect = () => {
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

    connect();

    return () => {
      destroyed = true;
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
  };
}
