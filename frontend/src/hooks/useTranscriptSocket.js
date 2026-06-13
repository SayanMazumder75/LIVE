import { useCallback, useEffect, useRef, useState } from "react";

const RECONNECT_DELAY_MS = 3000;

/**
 * Manages the WebSocket connection to the transcription bridge.
 *
 * The hook owns the socket and re-connects automatically every 3 seconds
 * if the connection drops. It exposes:
 *
 *   status        : "connected" | "disconnected"
 *   sessionStatus : "idle" | "ready" | "stopped" | "error"
 *   finals        : Array<{id, text}>   - finalized transcripts (append-only)
 *   interim       : string              - current in-progress turn
 *   error         : string | null
 *
 *   startSession() : tell server to open an AssemblyAI session
 *   stopSession()  : tell server to close it
 *   sendAudio(buf) : forward a binary PCM chunk
 */
export function useTranscriptSocket(url) {
  const [status, setStatus] = useState("disconnected");
  const [sessionStatus, setSessionStatus] = useState("idle");
  const [finals, setFinals] = useState([]);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState(null);

  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    const scheduleReconnect = () => {
      if (cancelledRef.current) return;
      if (reconnectTimerRef.current) return;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, RECONNECT_DELAY_MS);
    };

    const connect = () => {
      if (cancelledRef.current) return;

      let ws;
      try {
        ws = new WebSocket(url);
      } catch (_e) {
        setStatus("disconnected");
        scheduleReconnect();
        return;
      }
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelledRef.current) return;
        setStatus("connected");
      };

      ws.onmessage = (event) => {
        // Server only sends JSON text frames; ignore anything else.
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
            setFinals((prev) => [
              ...prev,
              {
                id: `${Date.now()}-${prev.length}-${Math.random()
                  .toString(36)
                  .slice(2, 7)}`,
                text: msg.text,
              },
            ]);
            setInterim("");
          } else {
            setInterim(msg.text);
          }
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
        // `onclose` always follows; reconnect happens there.
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        if (cancelledRef.current) return;
        setStatus("disconnected");
        setSessionStatus("idle");
        setInterim("");
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      cancelledRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          /* noop */
        }
        wsRef.current = null;
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
