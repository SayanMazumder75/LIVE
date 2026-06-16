import { useCallback, useEffect, useState } from "react";
import { Brain, Archive } from "lucide-react";
import { MeetingIntelligenceSections } from "./InsightsPanel.jsx";

/**
 * SessionHistory
 * --------------
 * Drawer that lists past saved sessions (`GET /transcripts`) and, when
 * one is clicked, renders the **complete saved meeting** — transcript
 * plus every AI Meeting Intelligence section (Summary, Key Points,
 * Action Items, Topics, Timeline, Flashcards, Quiz, Study Vault) —
 * using the exact same React components the live `<InsightsPanel/>`
 * uses during generation.
 *
 * Reopening a saved session feels like reopening the meeting, not
 * opening a transcript file. The sidebar (left column) is unchanged;
 * only the right-hand viewer swaps from a transcript-only `<pre>` to
 * a full meeting view when the loaded session has saved insights.
 *
 * Loading flow:
 *   click row -> loadSession(id) -> {text, insights?}
 *               -> render Transcript + (if insights) full intelligence stack
 *
 * Props
 * -----
 *   open              : drawer visibility
 *   onClose           : close handler
 *   listSessions      : () => Promise<[{id,label,createdAt}]>
 *   loadSession       : (id) => Promise<string | {text, insights} | null>
 *   currentSessionId  : id of the in-progress session, highlighted in
 *                       the list
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
  const [viewerInsights, setViewerInsights] = useState(null);
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
      setViewerInsights(null);
      setViewerError("");
      setViewerLoading(true);
      try {
        // loadSession returns either a string (transcript-only legacy
        // sessions) or an object {text, insights} when AI Meeting
        // Intelligence was previously saved on the same record. The
        // backend ships both in a single GET /transcript/:id response,
        // so the "Load Session → Load Transcript → Load Saved AI
        // Intelligence → Render Complete Meeting View" flow is one
        // request, not three.
        const result = await loadSession(sid);
        if (result === null) {
          setViewerError(
            "Could not load this session. The backend may not be configured for persistence."
          );
        } else if (typeof result === "string") {
          setViewerText(result || "(this session has no saved transcript yet)");
        } else {
          setViewerText(
            result.text && result.text.length > 0
              ? result.text
              : "(this session has no saved transcript yet)"
          );
          if (result.insights && typeof result.insights === "object") {
            setViewerInsights(result.insights);
          }
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
          width: "min(960px, 96vw)",
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
          {/* List pane (sidebar — unchanged per the spec) */}
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

          {/* Viewer pane — full meeting view */}
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
                Select a session on the left to reopen the complete meeting:
                transcript, summary, key points, action items, topics,
                timeline, flashcards, quiz, and study vault — exactly as it
                looked when it was generated.
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
              <SavedMeetingView
                sessionId={selectedId}
                transcriptText={viewerText}
                insights={viewerInsights}
              />
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

/**
 * SavedMeetingView
 * ----------------
 * Renders a full saved meeting in the order required by the spec:
 *
 *   Transcript
 *     ↓
 *   AI Meeting Intelligence (header)
 *     ↓ Summary ↓ Key Points ↓ Action Items ↓ Topics
 *     ↓ Timeline ↓ Flashcards ↓ Quiz ↓ Study Vault
 *
 * The intelligence stack is rendered through the *same*
 * `<MeetingIntelligenceSections/>` component that the live
 * `<InsightsPanel/>` uses, so a re-opened meeting looks identical to
 * a freshly-generated one. The Study Vault section is given a
 * read-only metadata block (savedAt + lineCount) instead of a Save
 * button — the meeting is already saved.
 */
function SavedMeetingView({ sessionId, transcriptText, insights }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ── Transcript ───────────────────────────────────────────────── */}
      <section>
        <h3
          style={{
            margin: "0 0 8px",
            fontSize: 13,
            fontWeight: 700,
            color: "#cbd5e1",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          Transcript
        </h3>
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
          {transcriptText}
        </pre>
      </section>

      {/* ── AI Meeting Intelligence ──────────────────────────────────── */}
      {insights ? (
        <section
          style={{
            background: "rgba(15,23,42,0.95)",
            border: "1px solid rgba(139,92,246,0.25)",
            borderRadius: 16,
            padding: "20px 22px",
            backdropFilter: "blur(12px)",
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 18,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
              <Brain size={20} style={{ color: "#a855f7" }} />
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#f1f5f9" }}>
                AI Meeting Intelligence
              </h2>
              <span style={{ fontSize: 11, color: "#64748b", marginLeft: 4 }}>
                Saved meeting · session {sessionId}
              </span>
            </div>
          </div>

          <MeetingIntelligenceSections
            insights={insights}
            vaultSection={<SavedVaultMetadata insights={insights} />}
          />
        </section>
      ) : (
        <p
          style={{
            margin: 0,
            fontSize: 12,
            color: "#64748b",
            background: "rgba(139,92,246,0.05)",
            border: "1px dashed rgba(139,92,246,0.25)",
            borderRadius: 8,
            padding: "10px 12px",
          }}
        >
          No AI Meeting Intelligence has been saved for this session yet.
          Open the live transcript, generate insights, then click{" "}
          <strong>Save Current Insights</strong> to attach them to this session.
        </p>
      )}
    </div>
  );
}

/**
 * Read-only Study Vault contents for a saved meeting.
 * Replaces the live "Save Current Insights" button with the metadata
 * recorded at save time, so the user sees *when* this meeting was
 * archived without being offered to re-save it.
 */
function SavedVaultMetadata({ insights }) {
  const sv = insights && typeof insights.studyVault === "object" ? insights.studyVault : null;
  const savedAt = sv?.savedAt ? new Date(sv.savedAt) : null;
  const savedLabel =
    savedAt && !Number.isNaN(savedAt.getTime())
      ? savedAt.toLocaleString()
      : null;
  return (
    <div
      style={{
        background: "rgba(6,182,212,0.05)",
        border: "1px solid rgba(6,182,212,0.15)",
        borderRadius: 10,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Archive size={14} style={{ color: "#22d3ee" }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: "#67e8f9" }}>
          Saved meeting
        </span>
      </div>
      <div style={{ fontSize: 11, color: "#94a3b8" }}>
        {savedLabel ? <>Archived {savedLabel}</> : "Archived"}
        {sv?.lineCount != null ? (
          <> · {sv.lineCount} transcript line{sv.lineCount === 1 ? "" : "s"}</>
        ) : null}
      </div>
      <p
        style={{
          margin: "4px 0 0",
          fontSize: 11,
          color: "#475569",
          lineHeight: 1.5,
        }}
      >
        This meeting is already saved in the session document — the same
        record that holds the transcript above. To capture changes, regenerate
        and save from the live transcript view.
      </p>
    </div>
  );
}
