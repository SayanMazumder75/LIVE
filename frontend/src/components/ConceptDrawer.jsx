import { useCallback, useEffect, useRef, useState } from "react";
import {
  Brain,
  Lightbulb,
  Globe,
  Network,
  GraduationCap,
  Briefcase,
  Loader2,
  Save,
  X,
  RefreshCw,
  Check,
  AlertTriangle,
  ClipboardList,
  CheckCircle2,
  HelpCircle,
} from "lucide-react";
import { DiagramView } from "./ConceptDiagrams.jsx";

/**
 * ConceptDrawer
 * -------------
 * Right-side drawer that opens when the user clicks a highlighted
 * concept in the transcript. Generates a teacher-style explanation
 * via Groq the first time a concept is opened, caches it for the
 * remainder of the session, and lets the user save it back into the
 * session document so re-opening the same meeting later shows it
 * instantly without another LLM round-trip.
 *
 * Sections rendered (in order):
 *   - Definition          — clear, beginner-friendly what-it-is
 *   - Why Needed          — motivation / problem it solves
 *   - Real Life Example   — relatable concrete scenario
 *   - Diagram             — TWO panes side-by-side: a Concept Structure
 *                           with placeholder labels AND a Real Example
 *                           with concrete values. Stacks vertically on
 *                           narrow viewports (mobile / split screen).
 *   - Solved Example      — beginner-friendly worked problem: question,
 *                           numbered steps with optional inline diagrams,
 *                           highlighted Final Answer + Beginner Tip.
 *   - Exam Questions      — 3-5 academic-style questions
 *   - Interview Questions — 3-5 industry / behavioural prompts
 *
 * Props
 * -----
 *   open        : boolean — drawer visibility
 *   onClose     : () => void
 *   concept     : { name, summary } — the concept being explained
 *   contextText : string  — meeting summary / surrounding transcript
 *                 fed to the LLM for relevance
 *   cached      : full explanation object if we already have one
 *                 (from a prior in-session click or hydrated from a
 *                 saved session). When set, we render immediately
 *                 and skip the Groq call.
 *   onGenerated : (concept, explanation) => void
 *                 fires when a fresh explanation is produced so the
 *                 parent can stash it in the cache + saved insights.
 *   onSave      : (concept, explanation) => Promise<{ok, message?}>
 *                 fires from the Save button. The parent persists
 *                 into session.insights.conceptExplanations.
 */
export default function ConceptDrawer({
  open,
  onClose,
  concept,
  contextText,
  cached,
  onGenerated,
  onSave,
}) {
  const [explanation, setExplanation] = useState(cached || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Save status: "" | "saving" | "saved" | "error"
  const [saveStatus, setSaveStatus] = useState("");
  const [saveMessage, setSaveMessage] = useState("");

  // Reset everything when the drawer is opened for a new concept.
  // Keying off concept.name means switching between different
  // highlighted terms in the same session shows their cached
  // explanations cleanly without state leakage.
  const lastNameRef = useRef(null);
  useEffect(() => {
    if (!open || !concept?.name) return;
    if (lastNameRef.current === concept.name) return;
    lastNameRef.current = concept.name;
    setExplanation(cached || null);
    setError("");
    setSaveStatus("");
    setSaveMessage("");
  }, [open, concept?.name, cached]);

  // Auto-generate on first open when no cache is available. We use
  // the cached prop as the trigger condition rather than `explanation`
  // because the parent might lazily hydrate the cache after we
  // mounted.
  const generationTriggeredRef = useRef(false);
  useEffect(() => {
    if (!open || !concept?.name) {
      generationTriggeredRef.current = false;
      return;
    }
    if (cached) return;            // already have it
    if (explanation) return;       // generated this open
    if (generationTriggeredRef.current) return;
    generationTriggeredRef.current = true;
    void generate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, concept?.name, cached]);

  const generate = useCallback(
    async (force) => {
      if (!concept?.name) return;
      setLoading(true);
      setError("");

      try {
        const data = await callGroqForExplanation(concept, contextText);
        setExplanation(data);
        setSaveStatus("");
        setSaveMessage("");
        onGenerated?.(concept, data);
      } catch (e) {
        console.error(e);
        setError(
          e.message ||
            "Could not generate the explanation. Check VITE_GROQ_API_KEY in frontend/.env."
        );
        if (!force) setExplanation(null);
      } finally {
        setLoading(false);
      }
    },
    [concept, contextText, onGenerated]
  );

  const handleRegenerate = useCallback(() => {
    setExplanation(null);
    setSaveStatus("");
    void generate(true);
  }, [generate]);

  const handleSave = useCallback(async () => {
    if (!explanation || !onSave || !concept?.name) return;
    setSaveStatus("saving");
    setSaveMessage("");
    try {
      const result = await onSave(concept, explanation);
      if (result?.ok) {
        setSaveStatus("saved");
        setSaveMessage(
          result.message || "Stored in this meeting's Study Vault."
        );
      } else {
        setSaveStatus("error");
        setSaveMessage(result?.message || "Could not save the explanation.");
      }
    } catch (e) {
      setSaveStatus("error");
      setSaveMessage(e.message || "Could not save the explanation.");
    }
  }, [explanation, onSave, concept]);

  if (!open || !concept) return null;

  return (
    <>
      {/* Backdrop — click outside closes. */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.55)",
          zIndex: 70,
        }}
      />

      <aside
        role="dialog"
        aria-label={`${concept.name} explanation`}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(640px, 96vw)",
          background: "#0f172a",
          borderLeft: "1px solid #334155",
          boxShadow: "-12px 0 32px rgba(0,0,0,0.5)",
          zIndex: 71,
          display: "flex",
          flexDirection: "column",
          color: "#e2e8f0",
        }}
      >
        {/* ── header ─────────────────────────────────────────────────── */}
        <header
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 14,
            padding: "16px 18px",
            borderBottom: "1px solid #334155",
            background:
              "linear-gradient(135deg, rgba(168,85,247,0.08), rgba(15,23,42,0.95))",
          }}
        >
          <div style={{ display: "flex", gap: 10, minWidth: 0 }}>
            <div
              aria-hidden="true"
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: "rgba(168,85,247,0.15)",
                border: "1px solid rgba(168,85,247,0.4)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <GraduationCap size={18} style={{ color: "#c4b5fd" }} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  color: "#a78bfa",
                }}
              >
                Concept
              </div>
              <h2
                style={{
                  margin: "2px 0 0",
                  fontSize: 18,
                  fontWeight: 700,
                  color: "#f1f5f9",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={concept.name}
              >
                {concept.name}
              </h2>
              {concept.summary ? (
                <p
                  style={{
                    margin: "4px 0 0",
                    fontSize: 12,
                    color: "#94a3b8",
                    lineHeight: 1.5,
                  }}
                >
                  {concept.summary}
                </p>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close concept drawer"
            style={{
              background: "transparent",
              border: "1px solid #334155",
              color: "#cbd5e1",
              padding: "6px",
              borderRadius: 6,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <X size={14} />
          </button>
        </header>

        {/* ── body ───────────────────────────────────────────────────── */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: "18px",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {error ? (
            <div
              style={{
                background: "rgba(239,68,68,0.1)",
                border: "1px solid rgba(239,68,68,0.3)",
                color: "#fca5a5",
                borderRadius: 8,
                padding: "10px 12px",
                fontSize: 13,
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
              }}
            >
              <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0 }} />
              <span>{error}</span>
            </div>
          ) : null}

          {loading && !explanation ? (
            <SkeletonExplanation />
          ) : explanation ? (
            <ExplanationBody explanation={explanation} />
          ) : (
            <p style={{ margin: 0, color: "#64748b", fontSize: 13 }}>
              Click <strong>Generate</strong> to fetch the teacher-style
              explanation for this concept.
            </p>
          )}
        </div>

        {/* ── footer (actions) ───────────────────────────────────────── */}
        <footer
          style={{
            borderTop: "1px solid #334155",
            padding: "12px 18px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            flexWrap: "wrap",
            background: "rgba(2,6,23,0.6)",
          }}
        >
          <div
            style={{
              fontSize: 11,
              color:
                saveStatus === "saved"
                  ? "#4ade80"
                  : saveStatus === "error"
                  ? "#fca5a5"
                  : "#94a3b8",
              minHeight: 16,
            }}
          >
            {saveStatus === "saving"
              ? "Saving…"
              : saveStatus === "saved"
              ? `✓ ${saveMessage}`
              : saveStatus === "error"
              ? `✗ ${saveMessage}`
              : explanation
              ? "Explanation cached for this session."
              : ""}
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={handleRegenerate}
              disabled={loading}
              style={btn("ghost", loading)}
              title="Regenerate the explanation from scratch"
            >
              {loading ? (
                <Loader2
                  size={13}
                  style={{ animation: "spin 1s linear infinite" }}
                />
              ) : (
                <RefreshCw size={13} />
              )}
              Regenerate
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!explanation || saveStatus === "saving" || !onSave}
              style={btn(
                "primary",
                !explanation || saveStatus === "saving" || !onSave
              )}
              title={
                onSave
                  ? "Save this explanation into the meeting's Study Vault"
                  : "No active session to save into"
              }
            >
              {saveStatus === "saving" ? (
                <Loader2
                  size={13}
                  style={{ animation: "spin 1s linear infinite" }}
                />
              ) : saveStatus === "saved" ? (
                <Check size={13} />
              ) : (
                <Save size={13} />
              )}
              {saveStatus === "saved" ? "Saved" : "Save to Vault"}
            </button>
          </div>
        </footer>

        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </aside>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers + sub-components
// ─────────────────────────────────────────────────────────────────────────

function btn(variant, disabled) {
  const base = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    fontWeight: 600,
    padding: "7px 14px",
    borderRadius: 8,
    cursor: disabled ? "not-allowed" : "pointer",
    border: "1px solid transparent",
    transition: "background 0.15s, color 0.15s, border 0.15s",
    opacity: disabled ? 0.55 : 1,
  };
  if (variant === "primary") {
    return {
      ...base,
      background: "linear-gradient(135deg,#7c3aed,#db2777)",
      color: "#fff",
    };
  }
  return {
    ...base,
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.1)",
    color: "#cbd5e1",
  };
}

function SectionCard({ icon: Icon, title, color, children }) {
  return (
    <section
      style={{
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${color}30`,
        borderRadius: 10,
        padding: "12px 14px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <Icon size={14} style={{ color }} />
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color,
          }}
        >
          {title}
        </span>
      </div>
      <div style={{ fontSize: 13, color: "#cbd5e1", lineHeight: 1.6 }}>
        {children}
      </div>
    </section>
  );
}

/**
 * SolvedExampleBlock
 * ------------------
 * Renders a beginner-friendly worked example with the spec's
 * required structure:
 *
 *   📝 Question
 *
 *   Step 1
 *   Diagram (optional)
 *   Explanation
 *
 *   Step 2
 *   ...
 *
 *   Final Answer
 *
 *   💡 Beginner Tip
 *
 * Steps are connected by a vertical accent rail so the sequence
 * reads top-to-bottom even when individual explanations wrap.
 * Inline diagrams reuse <DiagramView/> from ConceptDiagrams so a
 * BST insertion sequence shows the tree growing one node at a time
 * with the same SVG renderer used by the main Diagram section.
 *
 * Defensive against a malformed payload: missing question, empty
 * steps array, or missing finalAnswer / beginnerTip — the section
 * shows whatever fields ARE present and silently skips the rest.
 */
function SolvedExampleBlock({ data }) {
  if (!data || typeof data !== "object") return null;
  const question = typeof data.question === "string" ? data.question.trim() : "";
  const steps = Array.isArray(data.steps) ? data.steps.filter(Boolean) : [];
  const finalAnswer =
    typeof data.finalAnswer === "string" ? data.finalAnswer.trim() : "";
  const beginnerTip =
    typeof data.beginnerTip === "string" ? data.beginnerTip.trim() : "";

  // If the LLM gave us nothing useful, render nothing rather than
  // an empty card.
  if (!question && steps.length === 0 && !finalAnswer && !beginnerTip) {
    return null;
  }

  return (
    <SectionCard
      icon={ClipboardList}
      title="Solved Example"
      color="#fb7185"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Question card — distinct from the steps so the prompt
            reads like an exam paper at a glance. */}
        {question ? (
          <div
            style={{
              background: "rgba(251,113,133,0.08)",
              border: "1px solid rgba(251,113,133,0.3)",
              borderRadius: 8,
              padding: "10px 12px",
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
            }}
          >
            <span
              aria-hidden="true"
              style={{ fontSize: 14, lineHeight: "20px" }}
            >
              📝
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  color: "#fda4af",
                  marginBottom: 4,
                }}
              >
                Question
              </div>
              <p style={{ margin: 0, fontSize: 13, color: "#e2e8f0", lineHeight: 1.55 }}>
                {question}
              </p>
            </div>
          </div>
        ) : null}

        {/* Step list — numbered badges with a vertical rail so the
            sequence is visually unmistakable. */}
        {steps.length > 0 ? (
          <ol
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            {steps.map((step, i) => {
              const stepTitle =
                typeof step.title === "string" ? step.title.trim() : "";
              const stepExplanation =
                typeof step.explanation === "string"
                  ? step.explanation.trim()
                  : typeof step.text === "string"
                  ? step.text.trim()
                  : "";
              const stepDiagram = step.diagram || null;
              const isLast = i === steps.length - 1;
              return (
                <li
                  key={i}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "30px 1fr",
                    gap: 12,
                    position: "relative",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                    }}
                  >
                    <div
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: "50%",
                        background: "rgba(251,113,133,0.15)",
                        border: "1.5px solid #fb7185",
                        color: "#fda4af",
                        fontSize: 11,
                        fontWeight: 700,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      {i + 1}
                    </div>
                    {!isLast ? (
                      <div
                        style={{
                          width: 1,
                          flex: 1,
                          background: "rgba(251,113,133,0.25)",
                          marginTop: 4,
                          minHeight: 12,
                        }}
                      />
                    ) : null}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      paddingBottom: isLast ? 0 : 4,
                      minWidth: 0,
                    }}
                  >
                    {stepTitle ? (
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: "#fecdd3",
                        }}
                      >
                        {stepTitle}
                      </div>
                    ) : null}
                    {stepExplanation ? (
                      <p
                        style={{
                          margin: 0,
                          fontSize: 12.5,
                          color: "#cbd5e1",
                          lineHeight: 1.55,
                        }}
                      >
                        {stepExplanation}
                      </p>
                    ) : null}
                    {stepDiagram ? (
                      <div style={{ marginTop: 4 }}>
                        <DiagramView
                          diagram={stepDiagram}
                          accent="#fb7185"
                        />
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        ) : null}

        {/* Final Answer — green confirmation box. */}
        {finalAnswer ? (
          <div
            style={{
              background: "rgba(34,197,94,0.08)",
              border: "1px solid rgba(34,197,94,0.3)",
              borderRadius: 8,
              padding: "10px 12px",
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
            }}
          >
            <CheckCircle2
              size={14}
              style={{ color: "#4ade80", marginTop: 2, flexShrink: 0 }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  color: "#4ade80",
                  marginBottom: 4,
                }}
              >
                Final Answer
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: 13,
                  color: "#e2e8f0",
                  lineHeight: 1.55,
                }}
              >
                {finalAnswer}
              </p>
            </div>
          </div>
        ) : null}

        {/* Beginner Tip — amber lightbulb box. Same colour family as
            the Why Needed section so the visual language is
            consistent throughout the drawer. */}
        {beginnerTip ? (
          <div
            style={{
              background: "rgba(245,158,11,0.08)",
              border: "1px solid rgba(245,158,11,0.3)",
              borderRadius: 8,
              padding: "10px 12px",
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
            }}
          >
            <Lightbulb
              size={14}
              style={{ color: "#fbbf24", marginTop: 2, flexShrink: 0 }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  color: "#fbbf24",
                  marginBottom: 4,
                }}
              >
                Beginner Tip
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: 13,
                  color: "#e2e8f0",
                  lineHeight: 1.55,
                }}
              >
                {beginnerTip}
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}

function ExplanationBody({ explanation }) {
  const e = explanation || {};
  const examQuestions = Array.isArray(e.examQuestions) ? e.examQuestions : [];
  const interviewQuestions = Array.isArray(e.interviewQuestions)
    ? e.interviewQuestions
    : [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {e.definition ? (
        <SectionCard icon={Brain} title="Definition" color="#a855f7">
          <p style={{ margin: 0 }}>{e.definition}</p>
        </SectionCard>
      ) : null}

      {e.whyNeeded ? (
        <SectionCard icon={Lightbulb} title="Why Needed" color="#f59e0b">
          <p style={{ margin: 0 }}>{e.whyNeeded}</p>
        </SectionCard>
      ) : null}

      {e.realLifeExample ? (
        <SectionCard icon={Globe} title="Real Life Example" color="#10b981">
          <p style={{ margin: 0 }}>{e.realLifeExample}</p>
        </SectionCard>
      ) : null}

      {(e.diagram || e.exampleDiagram) ? (
        <SectionCard icon={Network} title="Diagram" color="#6366f1">
          {/* Two-pane layout — Concept Structure on the left, Real
              Example on the right.
              `auto-fit, minmax(260px, 1fr)` is the magic that makes
              this responsive WITHOUT a media query: as the drawer
              narrows below ~540 px (e.g. on mobile or split-screen
              desktop) the second column wraps to its own row, so the
              diagrams stack vertically. Above ~540 px they sit
              side-by-side. */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 12,
              alignItems: "stretch",
            }}
          >
            {e.diagram ? (
              <DiagramView
                label="Concept Structure"
                diagram={e.diagram}
                accent="#a78bfa"
              />
            ) : null}
            {e.exampleDiagram ? (
              <DiagramView
                label="Real Example"
                diagram={e.exampleDiagram}
                accent="#22d3ee"
              />
            ) : null}
          </div>
        </SectionCard>
      ) : null}

      {/* Solved Example — a worked problem with step-by-step
          solution + final answer + beginner tip. Sits between
          Diagram and Exam Questions per the spec. Doesn't render
          when the LLM didn't return one (older cached explanations
          predate the field). */}
      {e.solvedExample ? (
        <SolvedExampleBlock data={e.solvedExample} />
      ) : null}

      {examQuestions.length ? (
        <SectionCard
          icon={GraduationCap}
          title={`Exam Questions (${examQuestions.length})`}
          color="#3b82f6"
        >
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {examQuestions.map((q, i) => (
              <li key={i} style={{ marginBottom: 6 }}>
                {q}
              </li>
            ))}
          </ol>
        </SectionCard>
      ) : null}

      {interviewQuestions.length ? (
        <SectionCard
          icon={Briefcase}
          title={`Interview Questions (${interviewQuestions.length})`}
          color="#ec4899"
        >
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {interviewQuestions.map((q, i) => (
              <li key={i} style={{ marginBottom: 6 }}>
                {q}
              </li>
            ))}
          </ol>
        </SectionCard>
      ) : null}
    </div>
  );
}

function SkeletonExplanation() {
  // Six placeholder section cards so the user sees the upcoming
  // structure even while Groq is still thinking. Each has a faint
  // pulse animation so the wait feels alive rather than stuck.
  const stripeKeyframes = `@keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 0.7; }
  }`;
  const placeholder = (height) => (
    <div
      style={{
        height,
        background: "rgba(255,255,255,0.06)",
        borderRadius: 6,
        animation: "pulse 1.4s ease-in-out infinite",
      }}
    />
  );
  const titles = [
    ["Definition", "#a855f7", Brain],
    ["Why Needed", "#f59e0b", Lightbulb],
    ["Real Life Example", "#10b981", Globe],
    ["Diagram", "#6366f1", Network],
    ["Exam Questions", "#3b82f6", GraduationCap],
    ["Interview Questions", "#ec4899", Briefcase],
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <style>{stripeKeyframes}</style>
      {titles.map(([title, color, Icon]) => (
        <SectionCard key={title} icon={Icon} title={title} color={color}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {placeholder(10)}
            {placeholder(10)}
            {placeholder(10)}
          </div>
        </SectionCard>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Groq call (mirrors the pattern in InsightsPanel — same env var,
// same model, same JSON-only response convention).
// ─────────────────────────────────────────────────────────────────────────

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_API_KEY = import.meta.env.VITE_GROQ_API_KEY || "";

async function callGroqForExplanation(concept, contextText) {
  if (!GROQ_API_KEY) {
    throw new Error("VITE_GROQ_API_KEY is not set in frontend/.env");
  }
  const trimmedContext = (contextText || "").slice(0, 2000);
  const prompt = `You are a teacher creating a one-shot study guide for the term below.

Return ONLY valid JSON (no markdown, no prose around it). Use this EXACT shape:
{
  "definition": "A clear, beginner-friendly definition in 2-4 sentences.",
  "whyNeeded": "Why this concept is needed / what problem it solves, in 2-4 sentences.",
  "realLifeExample": "A concrete relatable example, in 2-4 sentences. Avoid jargon.",
  "diagram": <DIAGRAM-OBJECT for the concept structure (see DIAGRAM SPEC below)>,
  "exampleDiagram": <DIAGRAM-OBJECT for a real example with concrete values>,
  "solvedExample": <SOLVED-EXAMPLE-OBJECT (see SOLVED EXAMPLE SPEC below)>,
  "examQuestions": ["short academic-style question 1", "...", "...", "..."],
  "interviewQuestions": ["short industry / behavioural question 1", "...", "...", "..."]
}

Generate 3-5 exam questions and 3-5 interview questions.

────────────────────────────────────────
DIAGRAM SPEC
────────────────────────────────────────
A DIAGRAM-OBJECT is one of the following JSON shapes — pick whichever
best fits the concept. Output STRUCTURED data, NOT ascii art (the
frontend renders proper SVG from this). Always include a one-line
"rule" string that captures the main teaching point.

(a) Tree (Binary Tree, BST, AVL, Heap, Red-Black, B-Tree, Trie, etc.):
{
  "kind": "tree",
  "root": {
    "value": "Root",
    "label": "optional sub-label, e.g. balance:0",
    "left":  { "value": "Left",  "left": {...}, "right": {...} },
    "right": { "value": "Right", "left": {...}, "right": {...} }
  },
  "rule": "Left < Parent < Right"
}
- For the CONCEPT STRUCTURE, use educational placeholder values:
  "Root", "Left Child", "Right Child", "Leaf", "Internal Node", etc.,
  so beginners learn the terminology.
- For the REAL EXAMPLE, use concrete realistic numbers / strings.
  Show 5-7 nodes total. Always include EVERY child (don't omit
  the right subtree).

(b) Linked List:
{
  "kind": "list",
  "items": [{"value":"3"},{"value":"7"},{"value":"12"}],
  "terminator": "NULL",
  "rule": "Each node points to the next; tail points to NULL"
}

(c) Stack:
{
  "kind": "stack",
  "items": [{"value":"7"},{"value":"4"},{"value":"9"},{"value":"2"}],   // index 0 is the TOP
  "rule": "LIFO — last item pushed is first popped"
}

(d) Queue:
{
  "kind": "queue",
  "items": [{"value":"A"},{"value":"B"},{"value":"C"}],   // index 0 is the FRONT
  "rule": "FIFO — first item enqueued is first dequeued"
}

(e) Graph / Network Topology:
{
  "kind": "graph",
  "nodes": [{"id":"A"},{"id":"B"},{"id":"C"},{"id":"D"}],
  "edges": [
    {"from":"A","to":"B","weight":"5"},
    {"from":"B","to":"C","weight":"3"},
    {"from":"C","to":"D"}
  ],
  "directed": false,
  "rule": "Vertices V connected by edges E; edges may be weighted"
}
- Real example for graphs / networks should use named cities or
  routers (e.g. "Delhi","Mumbai","Pune","Chennai") with edge weights.

(f) Hash Table:
{
  "kind": "hashTable",
  "buckets": [
    {"index":0, "items":[]},
    {"index":1, "items":[{"value":"Alice"},{"value":"Bob"}]},
    {"index":2, "items":[]},
    {"index":3, "items":[{"value":"Carol"}]}
  ],
  "rule": "hash(key) → bucket index; collisions chain in the bucket"
}

(g) ASCII fallback (only if NONE of the above fit):
{
  "kind": "ascii",
  "text": "raw monospace diagram preserving all whitespace",
  "rule": "..."
}

Both "diagram" and "exampleDiagram" MUST follow the same DIAGRAM SPEC.
The CONCEPT STRUCTURE teaches terminology with educational labels;
the REAL EXAMPLE teaches the same shape with simpler concrete values.
Both should include their own short "rule" line.

────────────────────────────────────────
SOLVED EXAMPLE SPEC
────────────────────────────────────────
A SOLVED-EXAMPLE-OBJECT is a small worked problem a first-year
student could read and follow:

{
  "question": "One short exam-style question (1-2 sentences).",
  "steps": [
    {
      "title": "Step 1: Insert 50",
      "explanation": "50 becomes the root since the tree is empty.",
      "diagram": <DIAGRAM-OBJECT or null>   // optional — include when a snapshot of the data structure helps
    },
    {
      "title": "Step 2: Insert 30",
      "explanation": "30 < 50, so it goes to the left of the root.",
      "diagram": { "kind": "tree", "root": { "value": "50", "left": {"value": "30"} } }
    }
  ],
  "finalAnswer": "The single-sentence final answer / final state.",
  "beginnerTip": "One-line key takeaway that helps avoid the most common beginner mistake."
}

REQUIREMENTS for Solved Example:
- Generate 3-6 small steps. Steps should be tiny — each one does
  ONE thing.
- For each step, write a 1-2 sentence beginner-friendly explanation
  in plain language. No jargon.
- Include diagrams in steps that benefit from a visual snapshot
  (data-structure operations, table-state changes, scheduling
  decisions, packet flow). Skip the diagram for purely-prose steps
  (e.g. "compare keys", "look up index").
- Each step's diagram MUST be a full DIAGRAM-OBJECT following the
  DIAGRAM SPEC above — do NOT use ascii inside steps.
- Keep the example small and concrete (≤ 4 numbers / rows / processes).
- finalAnswer is one short sentence.
- beginnerTip is one short sentence — the rule of thumb.

TOPIC-SPECIFIC GUIDANCE for Solved Example:
- DSA (Tree / BST / AVL / Heap / Linked List / Stack / Queue / Trie / Graph):
    Show insertion / deletion / search step-by-step with the data
    structure evolving in each step's diagram.
    Example: 'Insert 50, 30, 70, 20 into an empty BST' → 4 steps,
    each with a diagram of the BST after that insertion.
- DBMS / Database Relationships:
    Show small tables (kind:'ascii' for table grids is OK here, or
    kind:'list' for short row sequences) and SQL/operation steps.
    Example: 'Apply σ_age>18(STUDENTS) on a 4-row table' → step 1
    shows the table, step 2 shows the predicate evaluated row-by-row,
    step 3 shows the resulting subset.
- OS Scheduling:
    Show the Gantt chart progressing one quantum at a time, or the
    ready/blocked queues evolving. Use kind:'queue' for ready
    queues and kind:'ascii' for Gantt charts.
    Example: 'Schedule P1(2ms), P2(5ms), P3(1ms) under FCFS' → step
    1 shows arrival, step 2 dispatches P1, etc.
- Networking / Routing:
    Show the packet's hop-by-hop journey or the routing-table
    lookup. Use kind:'graph' with directed edges for hop traces.
    Example: 'Trace packet from Delhi to Chennai through this
    network' → each step shows the current hop highlighted on the
    graph.
- Concepts with no obvious worked example (e.g. abstract
  philosophy, broad survey terms): use the realLifeExample as a
  jumping-off point and walk through it analytically; diagrams are
  optional in this case.
────────────────────────────────────────
"diagram": {
  "kind": "tree",
  "root": {
    "value": "Root",
    "left":  { "value": "Left Child",  "left":{"value":"Leaf"}, "right":{"value":"Leaf"} },
    "right": { "value": "Right Child", "left":{"value":"Leaf"}, "right":{"value":"Leaf"} }
  },
  "rule": "Each node has up to 2 children: left and right"
},
"exampleDiagram": {
  "kind": "tree",
  "root": {
    "value": "50",
    "left":  { "value": "30", "left": {"value":"20"}, "right": {"value":"40"} },
    "right": { "value": "70", "left": {"value":"60"}, "right": {"value":"80"} }
  },
  "rule": "Left < Parent < Right"
},
"solvedExample": {
  "question": "Insert 50, 30, 70, 20 into an empty BST. Show the tree after each insertion.",
  "steps": [
    {
      "title": "Step 1: Insert 50",
      "explanation": "The tree is empty, so 50 becomes the root.",
      "diagram": { "kind": "tree", "root": { "value": "50" } }
    },
    {
      "title": "Step 2: Insert 30",
      "explanation": "30 < 50, so it goes to the LEFT of the root.",
      "diagram": { "kind": "tree", "root": { "value": "50", "left": {"value":"30"} } }
    },
    {
      "title": "Step 3: Insert 70",
      "explanation": "70 > 50, so it goes to the RIGHT of the root.",
      "diagram": { "kind": "tree", "root": { "value": "50", "left": {"value":"30"}, "right": {"value":"70"} } }
    },
    {
      "title": "Step 4: Insert 20",
      "explanation": "20 < 50 → go left. 20 < 30 → go left of 30. Place there.",
      "diagram": { "kind": "tree", "root": { "value": "50", "left": {"value":"30", "left": {"value":"20"}}, "right": {"value":"70"} } }
    }
  ],
  "finalAnswer": "Final BST has root 50 with 30 (left) and 70 (right); 20 hangs under 30 on the left.",
  "beginnerTip": "Always start at the root: smaller goes left, larger goes right, then repeat."
}
────────────────────────────────────────

CRITICAL: When a tree node has only ONE child in the example, you
MUST omit the missing child key entirely (don't put null, don't put
an empty object). The renderer treats missing keys as "no child".

CONCEPT: "${concept.name}"
${concept.summary ? `SHORT SUMMARY: "${concept.summary}"` : ""}

CONTEXT (the meeting transcript / summary the concept came from — use this to tailor your explanation to what was actually discussed; ignore parts that aren't directly relevant to the concept):
${trimmedContext || "(no additional context provided)"}
`;

  const res = await fetch(GROQ_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      // `response_format: json_object` asks Groq for strict JSON.
      // The endpoint accepts the same OpenAI-style flag, and even
      // when it's silently ignored by an older model the
      // extractJsonObject() fallback below still recovers the
      // payload. Belt and braces.
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a precise study-guide generator. Reply with a single JSON object only, no markdown, no preamble, no closing remarks.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
      max_tokens: 1600,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Groq ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";

  try {
    return extractJsonObject(text);
  } catch (e) {
    // Surface what Groq actually returned in the dev console — the
    // user-facing message stays short. Helps debug the rare case
    // where even the recovery extractor can't find a JSON object.
    console.error(
      "[ConceptDrawer] could not parse Groq response:",
      e.message,
      "\nRaw response (first 800 chars):\n",
      text.slice(0, 800)
    );
    throw new Error(
      "The teacher response wasn't valid JSON. Try Regenerate, or check the console for the raw output."
    );
  }
}

/**
 * Robust extractor for "JSON object somewhere inside an LLM reply".
 *
 * LLMs are inconsistent about how they hand back JSON:
 *   1. Bare object:           {"definition": "..."}
 *   2. Wrapped in ```json ... ```  fences
 *   3. Wrapped in plain ``` fences  with no language tag
 *   4. Preamble prose ("Sure, here is the JSON:") then the object
 *   5. Postscript prose ("Hope this helps!") after the object
 *   6. Trailing commas before } or ] (technically invalid JSON)
 *   7. Mixed quotes / smart quotes — handled implicitly by JSON.parse
 *      when it succeeds; we don't try to repair that ourselves.
 *
 * We strip code fences, locate the *first* `{` and walk the string
 * tracking string-literal context + brace depth to find its matching
 * `}`. The substring between them is the JSON candidate. Then we
 * try JSON.parse, and if that throws we strip trailing commas as a
 * last-ditch repair before re-trying.
 *
 * Throws if no JSON object is recoverable.
 */
function extractJsonObject(input) {
  if (input == null) throw new Error("empty response");
  // Sometimes the LLM returns a parsed object directly (some SDKs
  // unwrap `response_format: json_object` for you). Defensive pass-
  // through so callers don't have to special-case it.
  if (typeof input === "object") return input;

  let s = String(input).trim();

  // Strip leading + trailing markdown code fences (```json, ``` js, ```
  // — language tag optional, surrounding whitespace tolerated).
  s = s.replace(/^```[a-zA-Z0-9_-]*\s*\n?/i, "");
  s = s.replace(/\n?\s*```\s*$/i, "");
  s = s.trim();

  const start = s.indexOf("{");
  if (start < 0) {
    throw new Error("no JSON object found in response");
  }

  // Walk forward from `start` finding the matching closing brace.
  // Track:
  //   - inString:    inside a "..." string literal (braces don't count)
  //   - escapeNext:  previous char was a backslash (so this char is
  //                  part of an escape, not a closing quote)
  //   - depth:       current nesting depth of {}
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (inString) {
      if (c === "\\") {
        escapeNext = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end < 0) {
    throw new Error("unbalanced braces around JSON object");
  }

  const candidate = s.slice(start, end + 1);

  try {
    return JSON.parse(candidate);
  } catch (firstErr) {
    // Last-ditch repair: drop trailing commas before } or ]. LLMs
    // often produce these by mistake; everything else (bad quotes,
    // unescaped newlines) is too risky to auto-repair.
    const repaired = candidate.replace(/,(\s*[}\]])/g, "$1");
    try {
      return JSON.parse(repaired);
    } catch (_e2) {
      throw new Error(`JSON.parse failed: ${firstErr.message}`);
    }
  }
}
