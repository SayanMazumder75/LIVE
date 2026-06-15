import { useCallback, useEffect, useRef, useState } from "react";

const RECONNECT_DELAY_MS = 3000;

/**
 * Manages one WebSocket connection to the transcription bridge.
 *
 * In Option-B each source (system / mic) gets its own socket instance,
 * so `source` is injected at construction time as a plain string
 * ("system" | "mic") and stamped on every final transcript line.
 * No dynamic `getSource` callback is needed — the identity of the
 * socket IS the source.
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
 *   finals        : Array<{id, text, translation: string|null, source}>
 *                   append-only; `translation` filled in when the
 *                   backend translation step completes.
 *   interim       : string   current in-progress turn
 *   error         : string | null
 *
 *   startSession() / stopSession() / sendAudio(buffer) / clearTranscripts()
 *
 * Hindi-mode helpers:
 *   addLocalFinal(text)       — append a finalized line, returns its id
 *   setLocalInterim(text)     — overwrite the current in-progress line
 *   requestTranslation(id, t) — ask the backend to translate `t` and
 *                                attach the result to the line `id`
 *   requestHindiChunk(id, ab) — two-step send for Hindi system audio
 *
 * @param {string} url     WebSocket URL
 * @param {"system"|"mic"} source  Stamped on every final line produced
 *                                  by this socket instance.
 */
export function useTranscriptSocket(url, source = "system") {
  const [status, setStatus] = useState("disconnected");
  const [sessionStatus, setSessionStatus] = useState("idle");
  const [finals, setFinals] = useState([]);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState(null);

  const wsRef = useRef(null);

  // Keep source in a ref so the stable callbacks below always stamp the
  // latest value without needing to be recreated.
  const sourceRef = useRef(source);
  useEffect(() => {
    sourceRef.current = source;
  }, [source]);

  useEffect(() => {
    let destroyed = false;
    let currentWs = null;
    let reconnectTimer = null;

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
            const id =
              typeof msg.id === "string" && msg.id
                ? msg.id
                : `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

            setFinals((prev) => [
              ...prev,
              { id, text: msg.text, translation: null, source: sourceRef.current },
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
        // Browser fires `onclose` next; reconnect logic lives there.
      };

      ws.onclose = () => {
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

    const initialConnectTimer = setTimeout(() => {
      if (destroyed) return;
      connect();
    }, 0);

    return () => {
      destroyed = true;
      clearTimeout(initialConnectTimer);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const ws = currentWs;
      currentWs = null;
      if (wsRef.current === ws) wsRef.current = null;
      if (ws) {
        try { ws.close(); } catch { /* noop */ }
      }
    };
  }, [url]);

  // ── imperative API ─────────────────────────────────────────────────────

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

  // ── Hindi-mode helpers ─────────────────────────────────────────────────

  const addLocalFinal = useCallback((text) => {
    const trimmed = (text || "").trim();
    if (!trimmed) return null;
    const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setFinals((prev) => [
      ...prev,
      { id, text: trimmed, translation: null, source: sourceRef.current },
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

  const requestHindiChunk = useCallback((id, audioBuffer) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!id || !audioBuffer || audioBuffer.byteLength === 0) return;
    ws.send(JSON.stringify({ type: "hindi_chunk", id }));
    ws.send(audioBuffer);
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
    addLocalFinal,
    setLocalInterim,
    requestTranslation,
    requestHindiChunk,
  };
}