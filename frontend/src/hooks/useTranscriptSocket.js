import { useEffect, useRef, useState } from "react";

const RECONNECT_DELAY_MS = 3000;

/**
 * Connects to the backend transcript broadcast server over WebSocket.
 *
 * - Tracks connection status ("connected" / "disconnected").
 * - Appends every incoming `{type: "transcript", text}` payload to a list.
 * - Automatically attempts to reconnect every 3 seconds on close/error.
 *
 * @param {string} url ws:// URL of the transcript server
 * @returns {{ status: "connected" | "disconnected", transcripts: {id: string, text: string}[] }}
 */
export function useTranscriptSocket(url) {
  const [status, setStatus] = useState("disconnected");
  const [transcripts, setTranscripts] = useState([]);

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
      } catch (_err) {
        setStatus("disconnected");
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelledRef.current) return;
        setStatus("connected");
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (
            data &&
            data.type === "transcript" &&
            typeof data.text === "string" &&
            data.text.length > 0
          ) {
            setTranscripts((prev) => [
              ...prev,
              {
                id: `${Date.now()}-${prev.length}-${Math.random()
                  .toString(36)
                  .slice(2, 7)}`,
                text: data.text,
              },
            ]);
          }
        } catch (_err) {
          // ignore malformed payloads
        }
      };

      ws.onerror = () => {
        // The browser will fire `onclose` right after; reconnect happens there.
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        if (cancelledRef.current) return;
        setStatus("disconnected");
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
        } catch (_err) {
          // ignore
        }
        wsRef.current = null;
      }
    };
  }, [url]);

  return { status, transcripts };
}
