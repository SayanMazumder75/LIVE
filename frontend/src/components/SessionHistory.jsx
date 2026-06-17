import { useCallback, useEffect, useState } from "react";
import { Trash2, Loader2 } from "lucide-react";

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
 * Each row also has a trash icon button on the right. Clicking it
 * pops a `window.confirm` dialog — same modal style the spec asked
 * for ("OK to delete, Cancel to keep"). On OK we fire
 * `onDeleteSession(id)`; on Cancel nothing happens. The trash click
 * stops propagation so it doesn't also fire `onOpenSession`.
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
 *   onDeleteSession   : async (id, meta) => {ok, reason?, message?}
 *                       fires when the user confirms the trash-icon
 *                       prompt. The drawer awaits the result, refreshes
 *                       the list on ok=true, and surfaces error
 *                       messages inline.
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
  onDeleteSession,
  currentSessionId,
  viewedSessionId,
}) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  // Per-row delete state. Map of session_id -> "deleting" while the
  // request is in flight, and a separate map of session_id -> error
  // message when something went wrong (404 / 503 / network).
  const [deletingId, setDeletingId] = useState(null);
  const [deleteError, setDeleteError] = useState("");

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

  // Auto-refresh in two cases:
  //   1. drawer opens — get the freshest list before the user reads it
  //   2. a new live session_id appears (Start Translation just ran) —
  //      so the count badge in the header bumps up immediately
  //      without the user having to hit the Refresh button.
  // Deletes are already handled inline by `handleDelete`, which both
  // optimistically removes the row and re-runs `refresh` to reconcile
  // with the server.
  useEffect(() => {
    if (open) refresh();
  }, [open, currentSessionId, refresh]);

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

  // Trash-icon click: confirmation popup, then call onDeleteSession.
  // Stops propagation so the row's main click handler doesn't also
  // fire (which would open the meeting we're about to delete).
  const handleDelete = useCallback(
    async (session, event) => {
      if (event) {
        event.stopPropagation();
        event.preventDefault();
      }
      if (!session?.id) return;
      if (!onDeleteSession) return;

      const niceLabel = session.label || `Session ${session.id}`;
      // window.confirm gives the OK/Cancel dialog the spec asked for —
      // native, accessible, blocks until the user answers. No third-
      // party modal needed.
      const confirmed = window.confirm(
        `Delete "${niceLabel}"?\n\n` +
          `This will permanently remove the transcript, AI insights, ` +
          `and study vault for this meeting from MongoDB. ` +
          `This cannot be undone.`
      );
      if (!confirmed) return;

      setDeletingId(session.id);
      setDeleteError("");
      try {
        const result = await onDeleteSession(session.id, session);
        if (result?.ok || result?.reason === "missing") {
          // Optimistically drop the row immediately so the user sees
          // the result even before the next /transcripts refresh.
          setSessions((prev) => prev.filter((s) => s.id !== session.id));
          // And ask the server for the authoritative list in the
          // background so any race conditions sort themselves out.
          refresh();
        } else {
          setDeleteError(
            result?.message || "Could not delete this session."
          );
        }
      } catch (e) {
        setDeleteError(e.message || "Could not delete this session.");
      } finally {
        setDeletingId(null);
      }
    },
    [onDeleteSession, refresh]
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
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600,
              display: "flex", alignItems: "center", gap: 8 }}>
              Saved Sessions
              {/* Live count badge — updates automatically via the
                  refresh effects above whenever a session is added
                  (new live recording) or deleted (trash icon). */}
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#67e8f9",
                  background: "rgba(6,182,212,0.15)",
                  border: "1px solid rgba(6,182,212,0.35)",
                  borderRadius: 99,
                  padding: "1px 9px",
                  minWidth: 22,
                  textAlign: "center",
                }}
                aria-label={`${sessions.length} saved sessions`}
              >
                {loading && sessions.length === 0 ? "…" : sessions.length}
              </span>
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

          {deleteError ? (
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
              {deleteError}
            </div>
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
              const isDeleting = deletingId === s.id;
              return (
                <li
                  key={s.id}
                  style={{
                    display: "flex",
                    alignItems: "stretch",
                    background: isViewed ? "#1e3a5f" : "transparent",
                    borderLeft: isViewed
                      ? "3px solid #38bdf8"
                      : isCurrent
                      ? "3px solid #4ade80"
                      : "3px solid transparent",
                    opacity: isDeleting ? 0.5 : 1,
                    transition: "opacity 0.15s",
                  }}
                >
                  {/* Open button — fills the row, fires onOpenSession. */}
                  <button
                    type="button"
                    onClick={() => handleOpen(s)}
                    disabled={isDeleting}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      textAlign: "left",
                      background: "transparent",
                      border: "none",
                      padding: "12px 6px 12px 11px",
                      cursor: isDeleting ? "wait" : "pointer",
                      color: "#e2e8f0",
                      fontSize: 12,
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                      overflow: "hidden",
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 500,
                        color: isCurrent ? "#4ade80" : "#e2e8f0",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
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
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {s.id}
                    </span>
                  </button>

                  {/* Trash icon — confirms with window.confirm, then
                      fires onDeleteSession. stopPropagation prevents
                      the row's main onClick from also firing. */}
                  <button
                    type="button"
                    aria-label={`Delete ${s.label || s.id}`}
                    title={
                      isCurrent
                        ? "This session is currently recording — deleting it is allowed but won't stop the recording"
                        : "Delete this saved session"
                    }
                    onClick={(e) => handleDelete(s, e)}
                    disabled={isDeleting}
                    style={{
                      alignSelf: "stretch",
                      width: 40,
                      flexShrink: 0,
                      background: "transparent",
                      border: "none",
                      borderLeft: "1px solid rgba(255,255,255,0.04)",
                      color: isDeleting ? "#94a3b8" : "#94a3b8",
                      cursor: isDeleting ? "wait" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      transition: "color 0.15s, background 0.15s",
                    }}
                    onMouseEnter={(e) => {
                      if (!isDeleting) {
                        e.currentTarget.style.color = "#fca5a5";
                        e.currentTarget.style.background = "rgba(239,68,68,0.1)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isDeleting) {
                        e.currentTarget.style.color = "#94a3b8";
                        e.currentTarget.style.background = "transparent";
                      }
                    }}
                  >
                    {isDeleting ? (
                      <Loader2
                        size={14}
                        style={{ animation: "spin 1s linear infinite" }}
                      />
                    ) : (
                      <Trash2 size={14} />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Spinner keyframes for the trash button's loading state. */}
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </aside>
    </>
  );
}
