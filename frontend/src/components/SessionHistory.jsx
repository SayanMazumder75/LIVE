import { useCallback, useEffect, useState } from "react";

/**
 * SessionHistory
 * --------------
 * A right-side drawer that lists past sessions saved to MongoDB
 * (`GET /transcripts`). The drawer is *only* a list — no inline
 * preview, no transcript viewer, no insights renderer. Clicking a row
 * fires `onOpenSession(sessionId)` and closes the drawer; the parent
 * (App.jsx) then loads the session and replaces the main page with
 * the saved meeting using the same components that render the live
 * meeting (TranscriptPanel + InsightsPanel).
 *
 * In other words: the drawer behaves like "Open Meeting", not
 * "Preview Meeting". The user shouldn't be able to tell from the
 * pixels whether the meeting being shown is live or restored from
 * history.
 *
 * Props
 * -----
 *   open              : boolean — drawer visibility
 *   onClose           : () => void — close handler
 *   listSessions      : () => Promise<[{id,label,createdAt}]>
 *   onOpenSession     : (id, meta) => void — fires when a row is
 *                       clicked. The drawer closes itself before the
 *                       parent runs its load + render.
 *   currentSessionId  : id of the in-progress live session, shown as
 *                       a "live" tag and highlighted in the list
 *   viewedSessionId   : id of the saved session currently rendered
 *                       in the main page (if any), highlighted with
 *                       a different colour so the user knows where
 *                       the focus is
 */
export default function SessionHistory({
  open,
  onClose,
  listSessions,
  onOpenSession,
  currentSessionId,
  viewedSessionId,
}) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshError, setRefreshError] = useState("");

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

  // Auto-refresh every time the drawer opens so the list reflects
  // recent saves without a manual refresh click.
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const handleOpen = useCallback(
    (session) => {
      // Close FIRST, then notify the parent. App.jsx is responsible
      // for the actual load + replace-main-page work. Closing first
      // gives the page a moment to settle before the heavy render.
      onClose?.();
      onOpenSession?.(session.id, session);
    },
    [onClose, onOpenSession]
  );

  if (!open) return null;

  return (
    <>
      {/* Backdrop — clicking outside the drawer closes it. */}
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
          width: "min(420px, 92vw)",
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
              Click a row to open the meeting in the main page.
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
              const isCurrent = s.id === currentSessionId;
              const isViewed = s.id === viewedSessionId;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => handleOpen(s)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      background: isViewed ? "#1e3a5f" : "transparent",
                      border: "none",
                      borderLeft: isViewed
                        ? "3px solid #38bdf8"
                        : isCurrent
                        ? "3px solid #4ade80"
                        : "3px solid transparent",
                      padding: "12px 14px",
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
                      {isViewed ? " · open" : ""}
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
      </aside>
    </>
  );
}
