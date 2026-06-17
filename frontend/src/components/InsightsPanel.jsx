import { useCallback, useState } from "react";
import {
  Brain, ListChecks, CheckSquare, BookOpen,
  HelpCircle, Archive, Sparkles, ChevronDown,
  ChevronUp, Check, X, Loader2,
} from "lucide-react";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
// Add VITE_GROQ_API_KEY=your_key to frontend .env
const GROQ_API_KEY = import.meta.env.VITE_GROQ_API_KEY || "";

// ── direct Groq call (no backend needed) ─────────────────────────────────
async function callClaude(prompt) {
  if (!GROQ_API_KEY) throw new Error("VITE_GROQ_API_KEY not set in frontend .env");
  const res = await fetch(GROQ_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 2000,
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ── helpers ───────────────────────────────────────────────────────────────
function buildTranscript(finals) {
  return finals
    .map((l) => {
      const who = l.source === "mic" ? "MIC" : "SYS";
      const t = l.createdAt
        ? new Date(l.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "";
      return `[${who}${t ? " " + t : ""}]: ${l.text}`;
    })
    .join("\n");
}

function speakerStats(finals) {
  const stats = { mic: { turns: 0, words: 0 }, sys: { turns: 0, words: 0 } };
  for (const l of finals) {
    const key = l.source === "mic" ? "mic" : "sys";
    stats[key].turns += 1;
    stats[key].words += (l.text || "").trim().split(/\s+/).filter(Boolean).length;
  }
  return stats;
}

const priorityColor = { High: "#ef4444", Medium: "#f59e0b", Low: "#22c55e" };

// ── collapsible Section (from old code) ──────────────────────────────────
function Section({ icon: Icon, title, color, children, defaultOpen = false, count }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{
      background: "rgba(255,255,255,0.03)",
      border: `1px solid ${color}30`,
      borderRadius: 12,
      marginBottom: 10,
      overflow: "hidden",
    }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 10,
          padding: "12px 16px", background: "transparent", border: "none",
          cursor: "pointer", color: "#e2e8f0",
        }}
      >
        <Icon size={15} style={{ color, flexShrink: 0 }} />
        <span style={{ fontWeight: 700, fontSize: 13, color, letterSpacing: "0.06em",
          textTransform: "uppercase" }}>{title}</span>
        {count != null && (
          <span style={{ fontSize: 10, background: color + "22", color,
            borderRadius: 99, padding: "1px 7px", marginLeft: 4 }}>{count}</span>
        )}
        {open
          ? <ChevronUp size={13} style={{ marginLeft: "auto", opacity: 0.5 }} />
          : <ChevronDown size={13} style={{ marginLeft: "auto", opacity: 0.5 }} />}
      </button>
      {open && (
        <div style={{ padding: "0 16px 14px" }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ── FlashcardDeck with prev/next nav (from old code) ─────────────────────
function FlashcardDeck({ cards }) {
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  if (!cards.length) return null;
  const card = cards[idx];

  // 3D flip card. The outer wrapper sets the perspective so the
  // rotation reads as a true card flip rather than a horizontal squish;
  // the inner wrapper rotates around its Y axis with both faces
  // absolutely positioned and `backfaceVisibility: hidden` so only
  // the currently-facing one is visible. TERM and DEFINITION use
  // distinct color themes (amber for the question, violet for the
  // answer) so it's instantly clear which side you're looking at.
  const minH = 130;
  const faceBase = {
    position: "absolute",
    inset: 0,
    minHeight: minH,
    borderRadius: 10,
    padding: "16px 18px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    backfaceVisibility: "hidden",
    WebkitBackfaceVisibility: "hidden",
    boxSizing: "border-box",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Perspective container — fixes the 3D vanishing point. */}
      <div
        onClick={() => setFlipped(!flipped)}
        style={{
          perspective: "1200px",
          minHeight: minH,
          cursor: "pointer",
        }}
      >
        {/* Inner wrapper that actually rotates. */}
        <div
          style={{
            position: "relative",
            width: "100%",
            minHeight: minH,
            transition: "transform 0.6s cubic-bezier(0.4, 0.0, 0.2, 1)",
            transformStyle: "preserve-3d",
            transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)",
          }}
        >
          {/* TERM — front face, amber theme (question side). */}
          <div
            style={{
              ...faceBase,
              background: "rgba(245,158,11,0.08)",
              border: "1px solid rgba(245,158,11,0.4)",
              boxShadow: "0 4px 16px rgba(245,158,11,0.05)",
            }}
          >
            <span
              style={{
                fontSize: 10,
                color: "#f59e0b",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
              }}
            >
              Term — tap to flip
            </span>
            <p
              style={{
                margin: 0,
                fontSize: 14,
                color: "#fde68a",
                lineHeight: 1.6,
              }}
            >
              {card.front}
            </p>
          </div>

          {/* DEFINITION — back face, violet theme (answer side). Pre-
              rotated 180deg so when the wrapper rotates it sits
              flat for the viewer. */}
          <div
            style={{
              ...faceBase,
              transform: "rotateY(180deg)",
              background: "rgba(139,92,246,0.15)",
              border: "1px solid #8b5cf6",
              boxShadow: "0 4px 16px rgba(139,92,246,0.12)",
            }}
          >
            <span
              style={{
                fontSize: 10,
                color: "#a78bfa",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
              }}
            >
              Definition — tap to flip back
            </span>
            <p
              style={{
                margin: 0,
                fontSize: 14,
                color: "#c4b5fd",
                lineHeight: 1.6,
              }}
            >
              {card.back}
            </p>
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button
          onClick={() => { setIdx((idx - 1 + cards.length) % cards.length); setFlipped(false); }}
          style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 8, padding: "6px 14px", color: "#94a3b8", fontSize: 12, cursor: "pointer" }}
        >← Prev</button>
        <span style={{ fontSize: 12, color: "#64748b" }}>{idx + 1} / {cards.length}</span>
        <button
          onClick={() => { setIdx((idx + 1) % cards.length); setFlipped(false); }}
          style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 8, padding: "6px 14px", color: "#94a3b8", fontSize: 12, cursor: "pointer" }}
        >Next →</button>
      </div>
    </div>
  );
}

// ── QuizCard (from old code — answer matches option text) ─────────────────
function QuizCard({ q, idx }) {
  const [selected, setSelected] = useState(null);
  const correct = q.options?.findIndex((o) => o === q.answer);
  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 10, padding: "14px 16px", marginBottom: 10 }}>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: "#e2e8f0", fontWeight: 500 }}>
        <span style={{ color: "#8b5cf6", marginRight: 6 }}>Q{idx + 1}.</span>{q.question}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {(q.options || []).map((opt, i) => {
          const isSelected = selected === i;
          const isCorrect = i === correct;
          let bg = "rgba(255,255,255,0.03)";
          let border = "rgba(255,255,255,0.1)";
          let iconEl = null;
          if (selected !== null) {
            if (isCorrect) { bg = "rgba(74,222,128,0.1)"; border = "#4ade80";
              iconEl = <Check size={12} style={{ color: "#4ade80", flexShrink: 0 }} />; }
            else if (isSelected) { bg = "rgba(248,113,113,0.1)"; border = "#f87171";
              iconEl = <X size={12} style={{ color: "#f87171", flexShrink: 0 }} />; }
          }
          return (
            <button key={i} onClick={() => selected === null && setSelected(i)}
              disabled={selected !== null}
              style={{ background: bg, border: `1px solid ${border}`, borderRadius: 8,
                padding: "8px 12px", textAlign: "left", color: "#cbd5e1", fontSize: 12,
                cursor: selected !== null ? "default" : "pointer", transition: "all 0.15s",
                display: "flex", alignItems: "center", gap: 8 }}>
              {iconEl}
              <span style={{ color: "#8b5cf6", fontWeight: 700, marginRight: 4 }}>
                {String.fromCharCode(65 + i)}.
              </span>{opt}
            </button>
          );
        })}
      </div>
      {selected !== null && (
        <p style={{ margin: "10px 0 0", fontSize: 11,
          color: selected === correct ? "#4ade80" : "#f87171" }}>
          {selected === correct ? "✓ Correct!" : `✗ Correct: ${q.answer}`}
        </p>
      )}
    </div>
  );
}

// ── Speaker stats bar ─────────────────────────────────────────────────────
function SpeakerStatsBar({ stats }) {
  const total = stats.mic.words + stats.sys.words || 1;
  const micPct = Math.round((stats.mic.words / total) * 100);
  const sysPct = 100 - micPct;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 10 }}>
        {[
          { label: "System Audio", key: "sys", color: "#6366f1", avatar: "SYS" },
          { label: "Microphone",   key: "mic", color: "#10b981", avatar: "MIC" },
        ].map(({ label, key, color, avatar }) => (
          <div key={key} style={{ flex: 1, background: "rgba(255,255,255,0.03)",
            border: `1px solid ${color}30`, borderRadius: 10, padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ background: color + "25", color, borderRadius: 99,
                padding: "2px 8px", fontSize: 10, fontWeight: 700 }}>{avatar}</span>
              <span style={{ fontSize: 11, color: "#94a3b8" }}>{label}</span>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color }}>{stats[key].words}</div>
            <div style={{ fontSize: 10, color: "#64748b" }}>words · {stats[key].turns} turns</div>
          </div>
        ))}
      </div>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between",
          fontSize: 10, color: "#64748b", marginBottom: 4 }}>
          <span>SYS {sysPct}%</span><span>MIC {micPct}%</span>
        </div>
        <div style={{ height: 6, borderRadius: 99, background: "#1e293b", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${sysPct}%`,
            background: "linear-gradient(90deg,#6366f1,#10b981)", borderRadius: 99 }} />
        </div>
      </div>
    </div>
  );
}

// ── reusable section block (used by both live + saved views) ─────────────
//
// Renders the full AI Meeting Intelligence stack — Summary, Key Points,
// Action Items, Topics, Timeline, Flashcards, Quiz, Study Vault — for a
// given `insights` object. Both `<InsightsPanel/>` (live generation)
// and `<SessionHistory/>` (loading a saved meeting) call this so the
// two views are guaranteed to look identical.
//
// Props
// -----
//   insights      : the AI Meeting Intelligence object (summary,
//                   keyPoints, actionItems, topics, timeline,
//                   flashcards, quiz, studyVault).
//   vaultSection  : JSX rendered inside the Study Vault collapsible.
//                   Live mode passes the Save button + status pill +
//                   in-memory vault list. Saved mode passes a
//                   read-only metadata block with savedAt and
//                   lineCount.
//
// Order matters: this matches the spec's required order
// (Summary → Key Points → Action Items → Topics → Timeline →
// Flashcards → Quiz → Study Vault).
export function MeetingIntelligenceSections({ insights, vaultSection }) {
  if (!insights) return null;
  return (
    <div style={{ marginTop: 4 }}>
      <Section icon={Brain} title="AI Summary" color="#a855f7" defaultOpen>
        <p style={{ margin: 0, fontSize: 13, color: "#cbd5e1", lineHeight: 1.7 }}>
          {insights.summary}
        </p>
      </Section>

      <Section icon={ListChecks} title="Key Points" color="#3b82f6"
        count={insights.keyPoints?.length}>
        <ul style={{ margin: 0, padding: 0, listStyle: "none",
          display: "flex", flexDirection: "column", gap: 2 }}>
          {insights.keyPoints?.map((p, i) => (
            <li key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start",
              padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
              <span style={{ color: "#3b82f6", fontSize: 10, marginTop: 5, flexShrink: 0 }}>◆</span>
              <p style={{ margin: 0, fontSize: 13, color: "#cbd5e1", lineHeight: 1.6 }}>{p}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section icon={CheckSquare} title="Action Items" color="#22c55e"
        count={insights.actionItems?.length}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {insights.actionItems?.map((a, i) => (
            <div key={i} style={{ background: "rgba(34,197,94,0.05)",
              border: "1px solid rgba(34,197,94,0.15)", borderRadius: 8,
              padding: "10px 12px" }}>
              <div style={{ display: "flex", alignItems: "flex-start",
                justifyContent: "space-between", gap: 8 }}>
                <p style={{ margin: "0 0 4px", fontSize: 13, color: "#cbd5e1" }}>{a.task}</p>
                <span style={{
                  background: (priorityColor[a.priority] || "#94a3b8") + "22",
                  color: priorityColor[a.priority] || "#94a3b8",
                  border: `1px solid ${(priorityColor[a.priority] || "#94a3b8")}44`,
                  borderRadius: 99, padding: "1px 8px", fontSize: 10,
                  fontWeight: 700, flexShrink: 0,
                }}>{a.priority}</span>
              </div>
              <span style={{ fontSize: 11, color: "#64748b" }}>👤 {a.owner}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section icon={Sparkles} title="Topics Detected" color="#f59e0b"
        count={insights.topics?.length}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {insights.topics?.map((t, i) => (
            <span key={i} style={{ background: "rgba(245,158,11,0.1)",
              border: "1px solid rgba(245,158,11,0.3)", borderRadius: 99,
              padding: "4px 12px", fontSize: 12, color: "#fcd34d" }}>{t}</span>
          ))}
        </div>
      </Section>

      <Section icon={Brain} title="Meeting Timeline" color="#6366f1"
        count={insights.timeline?.length}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {insights.timeline?.map((e, i) => (
            <div key={i} style={{ display: "flex", gap: 12, paddingBottom: 14 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div style={{ width: 8, height: 8, borderRadius: 99,
                  background: "#6366f1", flexShrink: 0, marginTop: 3 }} />
                {i < (insights.timeline.length - 1) && (
                  <div style={{ width: 1, flex: 1, background: "rgba(99,102,241,0.2)",
                    marginTop: 3 }} />
                )}
              </div>
              <div>
                <span style={{ fontSize: 10, color: "#6366f1", fontWeight: 700,
                  display: "block", marginBottom: 2 }}>{e.time}</span>
                <p style={{ margin: 0, fontSize: 12, color: "#94a3b8" }}>{e.event}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section icon={BookOpen} title="Flashcards" color="#f59e0b"
        count={insights.flashcards?.length}>
        <FlashcardDeck cards={insights.flashcards || []} />
      </Section>

      <Section icon={HelpCircle} title="Quiz" color="#ec4899"
        count={insights.quiz?.length}>
        {insights.quiz?.map((q, i) => <QuizCard key={i} q={q} idx={i} />)}
      </Section>

      <Section icon={Archive} title="Study Vault" color="#06b6d4">
        {vaultSection}
      </Section>
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────
export default function InsightsPanel({
  finals,
  sessionId,
  saveInsights,
  persistenceEnabled,
  // When set, the panel mounts in "saved session" mode:
  //   - `insights` is pre-populated from the saved record
  //   - the Save button still works but writes back to `sessionId`
  //     (which the parent points at the saved meeting's id)
  // Pair this with a unique `key` in the parent if you want a fully
  // fresh component instance on session switch.
  initialInsights = null,
  // When true the panel is being used to render a saved meeting
  // rather than the live one. The Generate button label changes to
  // "Regenerate Insights" (no "Generate AI Insights" first-run copy)
  // and the Study Vault save button becomes "Update saved meeting"
  // so the affordance matches the user's mental model.
  savedView = false,
}) {
  const [insights, setInsights] = useState(initialInsights || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // When opening a saved meeting (savedView + initialInsights set),
  // pre-populate the in-memory vault list with the meeting's
  // existing snapshot so the Study Vault section looks exactly like
  // it did right after the user originally clicked "Save Current
  // Insights" — single entry, savedAt + lineCount + summary visible.
  // Without this the section would say "No saved sessions yet" on a
  // freshly-opened saved meeting, which contradicts the spec ("the
  // page should look identical to when the meeting was originally
  // generated").
  const [vault, setVault] = useState(() => {
    if (!initialInsights) return [];
    const sv =
      initialInsights.studyVault && typeof initialInsights.studyVault === "object"
        ? initialInsights.studyVault
        : null;
    const savedAtIso = sv?.savedAt;
    const savedAtLabel =
      savedAtIso && !Number.isNaN(new Date(savedAtIso).getTime())
        ? new Date(savedAtIso).toLocaleString()
        : "Saved meeting";
    return [
      {
        id: `restored-${savedAtIso || Date.now()}`,
        savedAt: savedAtLabel,
        lineCount: sv?.lineCount ?? (Array.isArray(finals) ? finals.length : 0),
        ...initialInsights,
      },
    ];
  });
  // In saved-session mode the meeting is already in MongoDB, so the
  // Save button starts in "saved" state until the user regenerates.
  const [saved, setSaved] = useState(savedView);
  // Status of the most recent persist-to-MongoDB attempt. Drives the
  // small status pill next to the "Save Current Insights" button so
  // the user knows whether their click actually wrote to the session
  // record (vs. only the local in-memory vault).
  //   "" | "saving" | "saved" | "no-session" | "disabled" | "error"
  const [persistStatus, setPersistStatus] = useState("");
  const [persistMessage, setPersistMessage] = useState("");

  const stats = speakerStats(finals);

  const generate = useCallback(async () => {
    if (!finals.length) { setError("No transcript yet. Start session first."); return; }
    setLoading(true);
    setError("");
    setInsights(null);
    setSaved(false);

    const transcriptText = buildTranscript(finals);

    const prompt = `You are an AI Meeting Intelligence engine. Analyze this transcript and return ONLY valid JSON (no markdown, no preamble).

TRANSCRIPT:
${transcriptText.slice(0, 6000)}

Return this exact JSON shape:
{
  "summary": "2-3 sentence meeting summary",
  "keyPoints": ["point 1", "point 2", "point 3", "point 4", "point 5"],
  "actionItems": [
    { "task": "task description", "owner": "inferred owner or Team", "priority": "High|Medium|Low" }
  ],
  "topics": ["topic1", "topic2", "topic3", "topic4"],
  "timeline": [
    { "time": "HH:MM", "event": "brief description" }
  ],
  "flashcards": [
    { "front": "term or concept", "back": "definition or explanation" }
  ],
  "quiz": [
    {
      "question": "question text",
      "options": ["option A text", "option B text", "option C text", "option D text"],
      "answer": "exact text of correct option"
    }
  ]
}

Generate 5 key points, 3-5 action items, 4 topics, 5 timeline events, 5 flashcards, 4 quiz questions.
Quiz: options array has exactly 4 items, answer must match one option exactly.`;

    try {
      const data = await callClaude(prompt);
      setInsights(data);
    } catch (e) {
      setError("AI generation failed. Check backend or transcript length.");
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [finals]);

  const saveToVault = async () => {
    if (!insights) return;
    // 1. Build the snapshot. `studyVault` is metadata about THIS save
    //    so the saved session document records when intelligence was
    //    promoted from "generated" to "saved" and against how many
    //    transcript lines. Living on the same `insights` subtree means
    //    a single GET /transcript/:session_id returns it alongside
    //    every other section.
    const studyVault = {
      savedAt: new Date().toISOString(),
      lineCount: finals.length,
    };
    const fullInsights = { ...insights, studyVault };

    // 2. Update the local vault list immediately so the UI reflects
    //    the click without waiting for the network round-trip. Same
    //    UX as before — only the persistence step is new.
    setVault((prev) => [
      {
        id: Date.now(),
        savedAt: new Date(studyVault.savedAt).toLocaleString(),
        lineCount: studyVault.lineCount,
        ...insights,
      },
      ...prev,
    ]);
    setSaved(true);

    // 3. Persist to MongoDB. Per the project requirement, this writes
    //    to the EXISTING session document — no separate vault /
    //    meeting_intelligence / quiz / flashcards collection. The
    //    backend does an atomic `$set: { insights: ... }` on the same
    //    record that already holds the transcript text.
    if (!saveInsights) {
      // No hook wired in — the panel is being rendered standalone
      // (e.g. in tests). Local-only save is the legacy behaviour.
      return;
    }
    setPersistStatus("saving");
    setPersistMessage("");
    const result = await saveInsights(fullInsights);
    if (result?.ok) {
      setPersistStatus("saved");
      setPersistMessage(`Saved to session ${result.sessionId}`);
    } else {
      setPersistStatus(result?.reason || "error");
      setPersistMessage(result?.message || "Failed to save to MongoDB");
    }
  };

  const btnBase = {
    border: "none", cursor: "pointer", borderRadius: 8,
    fontWeight: 600, fontSize: 12, transition: "all 0.15s",
    display: "flex", alignItems: "center", gap: 6,
  };

  // ── live-mode Study Vault contents ─────────────────────────────────────
  // Save button + persist-status pill + the in-memory vault list that
  // shows previous "Save Current Insights" clicks during this session.
  const liveVaultSection = (
    <>
      <div style={{ marginBottom: 12, display: "flex",
        alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          onClick={saveToVault}
          disabled={saved || persistStatus === "saving"}
          style={{
            ...btnBase,
            background: saved ? "rgba(6,182,212,0.15)" : "rgba(6,182,212,0.2)",
            color: saved ? "#67e8f9" : "#22d3ee",
            border: "1px solid rgba(6,182,212,0.3)",
            padding: "7px 14px",
            opacity: saved ? 0.7 : 1,
          }}
        >
          {persistStatus === "saving"
            ? <><Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> Saving…</>
            : saved
              ? <><Check size={13} /> {savedView ? "Saved meeting" : "Saved to Vault"}</>
              : <><Archive size={13} /> {savedView ? "Update saved meeting" : "Save Current Insights"}</>}
        </button>

        {persistStatus === "saved" && (
          <span style={{ fontSize: 11, color: "#4ade80",
            background: "rgba(74,222,128,0.1)",
            border: "1px solid rgba(74,222,128,0.3)",
            borderRadius: 99, padding: "2px 10px" }}>
            ● Stored in session
          </span>
        )}
        {persistStatus === "no-session" && (
          <span style={{ fontSize: 11, color: "#fcd34d",
            background: "rgba(245,158,11,0.1)",
            border: "1px solid rgba(245,158,11,0.3)",
            borderRadius: 99, padding: "2px 10px" }}
            title={persistMessage}>
            ⚠ No active session — click Start Translation first
          </span>
        )}
        {persistStatus === "disabled" && (
          <span style={{ fontSize: 11, color: "#fcd34d",
            background: "rgba(245,158,11,0.1)",
            border: "1px solid rgba(245,158,11,0.3)",
            borderRadius: 99, padding: "2px 10px" }}
            title={persistMessage}>
            ⚠ MongoDB persistence disabled
          </span>
        )}
        {persistStatus === "error" && (
          <span style={{ fontSize: 11, color: "#fca5a5",
            background: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 99, padding: "2px 10px" }}
            title={persistMessage}>
            ✗ Save failed
          </span>
        )}
      </div>

      {!sessionId && persistenceEnabled !== false && (
        <p style={{ margin: "0 0 10px", fontSize: 11, color: "#64748b" }}>
          Tip: insights save into the existing session document — start
          a translation first so there's a session to attach to.
        </p>
      )}
      {vault.length === 0 && (
        <p style={{ margin: 0, fontSize: 12, color: "#475569" }}>
          No saved sessions yet.
        </p>
      )}
      {vault.map((v) => (
        <div key={v.id} style={{ background: "rgba(6,182,212,0.05)",
          border: "1px solid rgba(6,182,212,0.15)", borderRadius: 10,
          padding: "12px 14px", marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between",
            marginBottom: 6 }}>
            <span style={{ fontSize: 11, color: "#64748b" }}>{v.savedAt}</span>
            <span style={{ fontSize: 11, color: "#64748b" }}>{v.lineCount} lines</span>
          </div>
          <p style={{ margin: "0 0 8px", fontSize: 12, color: "#94a3b8" }}>{v.summary}</p>
          <details>
            <summary style={{ fontSize: 11, color: "#06b6d4", cursor: "pointer" }}>
              {v.keyPoints?.length} key points · {v.actionItems?.length} actions · {v.flashcards?.length} flashcards
            </summary>
            <ul style={{ margin: "8px 0 0", padding: "0 0 0 16px" }}>
              {v.keyPoints?.map((p, i) => (
                <li key={i} style={{ fontSize: 11, color: "#64748b", marginBottom: 3 }}>{p}</li>
              ))}
            </ul>
          </details>
        </div>
      ))}
    </>
  );

  return (
    <div style={{
      background: "rgba(15,23,42,0.95)",
      border: "1px solid rgba(139,92,246,0.25)",
      borderRadius: 16, padding: "20px 22px",
      backdropFilter: "blur(12px)",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
    }}>
      {/* ── header ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10,
        marginBottom: 18, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
          <Brain size={20} style={{ color: "#a855f7" }} />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#f1f5f9" }}>
            AI Meeting Intelligence
          </h2>
          <span style={{ fontSize: 11, color: "#64748b", marginLeft: 4 }}>
            {finals.length} segments · {stats.mic.words + stats.sys.words} words
          </span>
        </div>
        <button
          onClick={generate}
          disabled={loading || finals.length === 0}
          style={{
            ...btnBase,
            background: loading ? "#374151"
              : "linear-gradient(135deg,#7c3aed,#db2777)",
            color: loading ? "#6b7280" : "#fff",
            padding: "8px 18px",
            opacity: finals.length === 0 ? 0.4 : 1,
          }}
        >
          {loading
            ? <><Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> Analyzing...</>
            : <><Sparkles size={14} /> {insights ? "Regenerate" : "Generate AI Insights"}</>}
        </button>
      </div>

      {/* ── error ── */}
      {error && (
        <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)",
          borderRadius: 10, padding: "10px 14px", marginBottom: 14,
          fontSize: 12, color: "#fca5a5" }}>⚠ {error}</div>
      )}

      {/* ── empty state ── */}
      {finals.length === 0 && (
        <div style={{ textAlign: "center", padding: "32px 0", color: "#475569" }}>
          <Brain size={40} style={{ opacity: 0.2, marginBottom: 12 }} />
          <p style={{ margin: 0, fontSize: 13 }}>
            Click <strong>Generate AI Insights</strong> after recording to unlock
            summary, key points, action items, flashcards, and quiz.
          </p>
        </div>
      )}

      {/* ── speaker stats always visible ── */}
      {finals.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <SpeakerStatsBar stats={stats} />
        </div>
      )}

      {/* ── sections (collapsible, same as old code) ── */}
      <MeetingIntelligenceSections
        insights={insights}
        vaultSection={liveVaultSection}
      />

      {/* spinner keyframes */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
