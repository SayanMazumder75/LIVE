import { useCallback, useEffect, useState } from "react";

/**
 * SessionHistory
 * --------------
 * A drawer that lists past saved sessions (from `GET /transcripts`)
 * and lets the user load any of them into a read-only viewer
 * (`GET /transcript/:session_id`).
 *
 * This component intentionally does NOT touch the live transcript
 * panel, the audio pipelines, or the WebSocket flow. It only reads
 * from the session-storage API. Loading a previous session opens its
 * text in a separate viewer area inside the drawer; the live
 * captioning UI keeps running underneath, exactly as before.
 *
 * Props
 * -----
 *   open        : boolean — drawer visibility
 *   onClose     : () => void — close handler
 *   listSessions: () => Promise<Array<{id,label,createdAt}>>
 *   loadSession : (id: string) => Promise<string|null>  // returns saved text
 *   currentSessionId : string | null — id of the in-progress session,
 *                                       highlighted in the list
 */
export default function SessionHistory({
  open,
  onClose,
  listSessions,
  loadSession,
  currentSessionId,
}) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshError, setRefreshError] = useState("");

  const [selectedId, setSelectedId] = useState(null);
  const [viewerText, setViewerText] = useState("");
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerError, setViewerError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setRefreshError("");
    try {
      const list = await listSessions();
      setSessions(Array.isArray(list) ? list : []);
    } catch (e) {
      setRefreshError(e.message || "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, [listSessions]);

  // Auto-refresh when the drawer opens.
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const handleSelect = useCallback(
    async (sid) => {
      setSelectedId(sid);
      setViewerText("");
      setViewerError("");
      setViewerLoading(true);
      try {
        const text = await loadSession(sid);
        if (text === null) {
          setViewerError(
            "Could not load this session. The backend may not be configured for persistence."
          );
        } else {
          setViewerText(text || "(this session has no saved transcript yet)");
        }
      } catch (e) {
        setViewerError(e.message || "Failed to load session");
      } finally {
        setViewerLoading(false);
      }
    },
    [loadSession]
  );

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.55)",
          zIndex: 60,
        }}
      />
      {/* Drawer */}
      <aside
        role="dialog"
        aria-label="Session history"
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(720px, 92vw)",
          background: "#0f172a",
          borderLeft: "1px solid #334155",
          boxShadow: "-12px 0 32px rgba(0,0,0,0.5)",
          zIndex: 61,
          display: "flex",
          flexDirection: "column",
          color: "#fff",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: "1px solid #334155",
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              Saved Sessions
            </h2>
            <p
              style={{
                margin: "2px 0 0",
                fontSize: 11,
                color: "#94a3b8",
              }}
            >
              MongoDB — same store as the old MeetMind project
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              style={{
                background: "#1e293b",
                border: "1px solid #334155",
                color: "#cbd5e1",
                padding: "6px 12px",
                fontSize: 12,
                borderRadius: 6,
                cursor: loading ? "not-allowed" : "pointer",
              }}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: "#1e293b",
                border: "1px solid #334155",
                color: "#cbd5e1",
                padding: "6px 12px",
                fontSize: 12,
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              Close
            </button>
          </div>
        </header>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: "260px 1fr",
            gap: 0,
          }}
        >
          {/* List pane */}
          <div
            style={{
              borderRight: "1px solid #334155",
              overflowY: "auto",
              padding: "8px 0",
            }}
          >
            {refreshError ? (
              <div
                style={{
                  margin: "8px 12px",
                  padding: "8px 10px",
                  borderRadius: 6,
                  background: "rgba(239,68,68,0.1)",
                  border: "1px solid rgba(239,68,68,0.3)",
                  color: "#fca5a5",
                  fontSize: 12,
                }}
              >
                {refreshError}
              </div>
            ) : null}

            {!loading && sessions.length === 0 && !refreshError ? (
              <p
                style={{
                  margin: "12px 14px",
                  fontSize: 12,
                  color: "#64748b",
                  lineHeight: 1.5,
                }}
              >
                No sessions yet. Start a translation to create one. If
                you don't see anything after recording, check that{" "}
                <code style={{ color: "#94a3b8" }}>MONGO_URI</code> is
                set in <code style={{ color: "#94a3b8" }}>backend/.env</code>.
              </p>
            ) : null}

            <ul
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
              }}
            >
              {sessions.map((s) => {
                const isSelected = s.id === selectedId;
                const isCurrent = s.id === currentSessionId;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => handleSelect(s.id)}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        background: isSelected ? "#1e3a5f" : "transparent",
                        border: "none",
                        borderLeft: isSelected
                          ? "3px solid #38bdf8"
                          : "3px solid transparent",
                        padding: "10px 12px",
                        cursor: "pointer",
                        color: "#e2e8f0",
                        fontSize: 12,
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                      }}
                    >
                      <span
                        style={{
                          fontWeight: 500,
                          color: isCurrent ? "#4ade80" : "#e2e8f0",
                        }}
                      >
                        {s.label || `Session ${s.id}`}
                        {isCurrent ? " · live" : ""}
                      </span>
                      <span
                        style={{
                          fontFamily: "monospace",
                          fontSize: 10,
                          color: "#64748b",
                        }}
                      >
                        {s.id}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Viewer pane */}
          <div
            style={{
              overflowY: "auto",
              padding: "16px 18px",
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            {!selectedId ? (
              <p style={{ color: "#64748b", margin: 0 }}>
                Select a session on the left to view its saved transcript.
              </p>
            ) : viewerLoading ? (
              <p style={{ color: "#94a3b8", margin: 0 }}>Loading…</p>
            ) : viewerError ? (
              <div
                style={{
                  background: "rgba(239,68,68,0.1)",
                  border: "1px solid rgba(239,68,68,0.3)",
                  borderRadius: 6,
                  padding: "10px 12px",
                  color: "#fca5a5",
                }}
              >
                {viewerError}
              </div>
            ) : (
              <pre
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  fontSize: 12,
                  color: "#e2e8f0",
                  background: "#0b1220",
                  border: "1px solid #1e293b",
                  borderRadius: 8,
                  padding: "12px 14px",
                }}
              >
                {viewerText}
              </pre>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
