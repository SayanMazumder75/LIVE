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
// Groq call — multi-model with JSON Schema Mode.
//
// Primary model  : openai/gpt-oss-20b  (reasoning_effort:low, JSON Schema)
// Fallback model : qwen/qwen3.6-27b   (reasoning_effort:none, JSON Schema
//                                      then json_object if schema rejected)
// ─────────────────────────────────────────────────────────────────────────

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

// Model priority: primary first, fallback second.
const MODEL_CANDIDATES = [
  "openai/gpt-oss-20b",
  "qwen/qwen3.6-27b",
];
// Prefer a dedicated concept key (separate Groq account / quota bucket).
// Falls back to the shared key so nothing breaks if only one key is set.
//   Primary  → VITE_GROQ_API_KEY_CONCEPT  (add to frontend/.env)
//   Fallback → VITE_GROQ_API_KEY
const GROQ_API_KEY_CONCEPT =
  import.meta.env.VITE_GROQ_API_KEY_CONCEPT ||
  import.meta.env.VITE_GROQ_API_KEY ||
  "";

async function callGroqForExplanation(concept, contextText) {
  if (!GROQ_API_KEY_CONCEPT) {
    throw new Error(
      "No Groq API key found. Set VITE_GROQ_API_KEY_CONCEPT (recommended) " +
      "or VITE_GROQ_API_KEY in frontend/.env"
    );
  }
  const trimmedContext = (contextText || "").slice(0, 2000);

  // ── User prompt ──────────────────────────────────────────────────────────
  // JSON Schema Mode handles output structure, so the prompt focuses on
  // content guidance rather than JSON formatting instructions.
  const userPrompt = `Generate a study guide for the following concept.

CONCEPT: "${concept.name}"
${concept.summary ? `SHORT SUMMARY: "${concept.summary}"` : ""}

MEETING CONTEXT (tailor to what was discussed; ignore irrelevant parts):
${trimmedContext || "(no additional context provided)"}

Guidelines:
- definition: 2-4 clear beginner-friendly sentences.
- whyNeeded: 2-4 sentences explaining the motivation / problem it solves.
- realLifeExample: 2-4 concrete relatable sentences, no jargon.
- diagram: choose tree/list/stack/queue/graph/hashTable/ascii that best shows the concept structure with teaching labels (Root, Left Child, Leaf, etc.).
- exampleDiagram: same kind as diagram with concrete realistic values (numbers, names, cities).
- solvedExample: 3-4 steps max. Each step does ONE small operation. Include a diagram in steps where a visual snapshot helps (omit the diagram key entirely otherwise). Keep the worked example small (at most 4 numbers/rows/processes).
- examQuestions: exactly 3 short academic-style questions.
- interviewQuestions: exactly 3 short industry/behavioural questions.
- Keep everything concise. Beginner-friendly language throughout.
`;

  // ── JSON Schema for response_format:json_schema ───────────────────────
  // Proper JSON Schema object — no pseudo-syntax, no comments inside.
  // Diagram uses a single flexible object (kind + optional per-kind fields)
  // rather than anyOf, which some models handle poorly under strict mode.
  const diagramSchema = {
    type: "object",
    description: "Visual diagram. Set kind to: tree, list, stack, queue, graph, hashTable, or ascii.",
    properties: {
      kind: { type: "string", enum: ["tree","list","stack","queue","graph","hashTable","ascii"] },
      rule: { type: "string" },
      root:  { type: "object", properties: { value:{type:"string"}, label:{type:"string"}, left:{type:"object"}, right:{type:"object"} }, required:["value"] },
      items: { type: "array",  items: { type:"object", properties:{value:{type:"string"}}, required:["value"] } },
      terminator: { type: "string" },
      nodes: { type: "array",  items: { type:"object", properties:{id:{type:"string"},label:{type:"string"}}, required:["id"] } },
      edges: { type: "array",  items: { type:"object", properties:{from:{type:"string"},to:{type:"string"},weight:{type:"string"}}, required:["from","to"] } },
      directed: { type: "boolean" },
      buckets:  { type: "array",  items: { type:"object", properties:{index:{type:"integer"},items:{type:"array",items:{type:"object",properties:{value:{type:"string"}},required:["value"]}}}, required:["index","items"] } },
      text: { type: "string" }
    },
    required: ["kind"]
  };

  const stepSchema = {
    type: "object",
    properties: {
      title:       { type: "string" },
      explanation: { type: "string" },
      diagram:     diagramSchema
    },
    required: ["title", "explanation"]
  };

  const topLevelSchema = {
    type: "object",
    properties: {
      definition:         { type: "string" },
      whyNeeded:          { type: "string" },
      realLifeExample:    { type: "string" },
      diagram:            diagramSchema,
      exampleDiagram:     diagramSchema,
      solvedExample: {
        type: "object",
        properties: {
          question:    { type: "string" },
          steps:       { type: "array", items: stepSchema },
          finalAnswer: { type: "string" },
          beginnerTip: { type: "string" }
        },
        required: ["question","steps","finalAnswer","beginnerTip"]
      },
      examQuestions:      { type: "array", items: { type: "string" } },
      interviewQuestions: { type: "array", items: { type: "string" } }
    },
    required: [
      "definition","whyNeeded","realLifeExample",
      "diagram","exampleDiagram","solvedExample",
      "examQuestions","interviewQuestions"
    ],
    additionalProperties: false
  };

  const jsonSchemaResponseFormat = {
    type: "json_schema",
    json_schema: {
      name: "concept_study_guide",
      strict: true,
      schema: topLevelSchema
    }
  };

  // ── System prompt ─────────────────────────────────────────────────────
  const systemPrompt =
    "You are a precise computer-science teacher generating a structured study guide. " +
    "Follow the supplied JSON schema exactly. Use beginner-friendly explanations. " +
    "Choose the diagram type that best represents the concept. Keep the response concise.";

  // ── Attempt each model in priority order ──────────────────────────────
  let lastError = null;

  for (const model of MODEL_CANDIDATES) {
    const isGptOss = model.startsWith("openai/gpt-oss");

    const requestBody = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
      temperature: 0.2,
      max_completion_tokens: 3000,
      response_format: jsonSchemaResponseFormat,
    };

    if (isGptOss) {
      // GPT-OSS: low reasoning effort, suppress reasoning tokens from output.
      requestBody.reasoning_effort  = "low";
      requestBody.include_reasoning = false;
    } else {
      // Qwen: disable built-in chain-of-thought to avoid <think> blocks.
      requestBody.reasoning_effort = "none";
    }

    // Attempt 1: JSON Schema Mode.
    try {
      const result = await attemptGroqRequest(requestBody, model, concept);
      if (result !== null) return result;
      lastError = new Error(`${model}: response failed validation`);
    } catch (err) {
      lastError = err;
      console.error("[ConceptDrawer] Model failed:", {
        model,
        concept: concept?.name,
        error: err.message?.slice(0, 500),
      });

      if (isGptOss) continue; // GPT-OSS: no json_object retry, try next model.

      // Qwen: retry once with plain json_object mode if schema was rejected.
      console.warn(`[ConceptDrawer] ${model}: JSON Schema Mode failed — retrying with json_object mode.`);
      const fallbackBody = { ...requestBody, response_format: { type: "json_object" } };

      try {
        const result = await attemptGroqRequest(fallbackBody, model, concept);
        if (result !== null) return result;
        lastError = new Error(`${model} (json_object): response failed validation`);
      } catch (err2) {
        lastError = err2;
        console.error("[ConceptDrawer] Model failed (json_object retry):", {
          model,
          concept: concept?.name,
          error: err2.message?.slice(0, 500),
        });
      }
    }
  }

  console.error("[ConceptDrawer] All models failed. Last error:", lastError?.message);
  throw new Error("AI concept generation failed. Please try Regenerate.");
}

/**
 * Makes one Groq chat-completion request and returns the parsed +
 * validated result, or null when HTTP succeeded but the payload is
 * unusable. Throws on network errors or non-2xx status.
 *
 * Authorization header uses GROQ_API_KEY_CONCEPT and is never logged.
 */
async function attemptGroqRequest(requestBody, model, concept) {
  const res = await fetch(GROQ_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY_CONCEPT}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    console.error("[ConceptDrawer] Model failed:", {
      model,
      status: res.status,
      concept: concept?.name,
      error: errorText?.slice(0, 1000),
    });
    throw new Error(`Groq ${res.status} (${model}): ${errorText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";

  let parsed;
  try {
    parsed = extractJsonObject(text);
  } catch (parseErr) {
    console.error("[ConceptDrawer] JSON parse failed:", {
      model,
      concept: concept?.name,
      parseError: parseErr.message,
      rawPreview: text.slice(0, 800),
    });
    return null; // caller will try next model/mode
  }

  if (!isValidConceptExplanation(parsed)) {
    console.warn("[ConceptDrawer] Validation failed:", {
      model,
      concept: concept?.name,
      keys: parsed ? Object.keys(parsed) : "null",
    });
    return null;
  }

  return normalizeExplanation(parsed);
}

/**
 * Lightweight structural validation — ensures all fields the UI expects
 * are present and of the right type before rendering.
 */
function isValidConceptExplanation(result) {
  if (!result || typeof result !== "object")                                      return false;
  if (typeof result.definition !== "string")                                      return false;
  if (typeof result.whyNeeded !== "string")                                       return false;
  if (typeof result.realLifeExample !== "string")                                 return false;
  if (!result.diagram        || typeof result.diagram !== "object")               return false;
  if (!result.exampleDiagram || typeof result.exampleDiagram !== "object")        return false;
  if (!result.solvedExample  || typeof result.solvedExample !== "object")         return false;
  if (!Array.isArray(result.solvedExample.steps))                                 return false;
  if (!Array.isArray(result.examQuestions)      || result.examQuestions.length < 1)      return false;
  if (!Array.isArray(result.interviewQuestions) || result.interviewQuestions.length < 1) return false;
  return true;
}

/**
 * normalizeExplanation
 * --------------------
 * Runs normalizeDiagram() over every diagram field in the explanation
 * object so the renderer always receives a canonical shape regardless
 * of which variant the model happened to return.
 */
function normalizeExplanation(result) {
  if (!result || typeof result !== "object") return result;
  const out = { ...result };
  if (out.diagram)        out.diagram        = normalizeDiagram(out.diagram);
  if (out.exampleDiagram) out.exampleDiagram = normalizeDiagram(out.exampleDiagram);
  if (out.solvedExample?.steps) {
    out.solvedExample = {
      ...out.solvedExample,
      steps: out.solvedExample.steps.map((step) =>
        step?.diagram
          ? { ...step, diagram: normalizeDiagram(step.diagram) }
          : step
      ),
    };
  }
  return out;
}

/**
 * normalizeDiagram
 * ----------------
 * The ConceptDiagrams renderer expects specific canonical shapes, but
 * models sometimes return structurally equivalent but differently-keyed
 * objects. This converts any known variant to the canonical shape.
 *
 * Canonical shapes:
 *   tree      : { kind:"tree",      root:{value,label?,left?,right?} }
 *   list      : { kind:"list",      items:[{value}], terminator? }
 *   stack     : { kind:"stack",     items:[{value}] }
 *   queue     : { kind:"queue",     items:[{value}] }
 *   graph     : { kind:"graph",     nodes:[{id,label?}], edges:[{from,to,weight?}], directed? }
 *   hashTable : { kind:"hashTable", buckets:[{index,items:[{value}]}] }
 *   ascii     : { kind:"ascii",     text:"..." }
 */
function normalizeDiagram(d) {
  if (!d || typeof d !== "object") return d;

  // Normalise kind (model may use "type" instead of "kind").
  const rawKind = (d.kind || d.type || "ascii").toString().toLowerCase().trim();

  // Kind alias map (mirrors ConceptDiagrams.normaliseKind).
  const KIND = {
    linkedlist: "list", "linked-list": "list", "linked list": "list",
    "hash-table": "hashTable", "hash table": "hashTable", hashtable: "hashTable", map: "hashTable",
    binarytree: "tree", "binary-tree": "tree", "binary tree": "tree",
    bst: "tree", avl: "tree", heap: "tree", trie: "tree",
    redblack: "tree", redblacktree: "tree", btree: "tree", "b-tree": "tree",
  };
  const kind = KIND[rawKind] || rawKind;
  const base = { ...d, kind };

  // ── Tree ───────────────────────────────────────────────────────────────
  if (kind === "tree") {
    // Already canonical.
    if (base.root && typeof base.root === "object") return base;
    // { structure: [{label, value, children:[...]}] }  ← GPT-OSS variant.
    if (Array.isArray(base.structure) && base.structure.length > 0) {
      base.root = _structureNodeToRoot(base.structure[0]);
      delete base.structure;
      return base;
    }
    // { nodes: [{id, label, parentId?}] }  ← adjacency-list variant.
    if (Array.isArray(base.nodes) && base.nodes.length > 0 && !base.edges) {
      base.root = _adjacencyNodesToRoot(base.nodes);
      delete base.nodes;
      return base;
    }
    // Single-value shorthand: { kind:"tree", value:"50" }.
    if (typeof base.value === "string") {
      base.root = { value: base.value };
      return base;
    }
    // Unknown tree format — fall through as-is; renderer will JSON.stringify.
    return base;
  }

  // ── List / Stack / Queue ───────────────────────────────────────────────
  if (kind === "list" || kind === "stack" || kind === "queue") {
    if (Array.isArray(base.items)) return base;
    const rawArr = base.elements || base.values || base.nodes || [];
    base.items = (Array.isArray(rawArr) ? rawArr : []).map((x) =>
      x && typeof x === "object" ? x : { value: String(x) }
    );
    return base;
  }

  // ── Graph ──────────────────────────────────────────────────────────────
  if (kind === "graph") {
    if (Array.isArray(base.nodes)) return base;
  }

  // ── Hash Table ─────────────────────────────────────────────────────────
  if (kind === "hashTable") {
    if (Array.isArray(base.buckets)) return base;
    if (base.buckets && typeof base.buckets === "object") {
      base.buckets = Object.entries(base.buckets).map(([k, v]) => ({
        index: parseInt(k, 10) || 0,
        items: Array.isArray(v) ? v.map((x) =>
          x && typeof x === "object" ? x : { value: String(x) }
        ) : [],
      }));
      return base;
    }
  }

  return base;
}

/** Recursively converts a { label, value, children:[...] } node. */
function _structureNodeToRoot(node) {
  if (!node) return null;
  const value = String(node.value ?? node.label ?? node.name ?? node.text ?? "?");
  const label = (node.label && node.label !== value) ? node.label : undefined;
  const children = Array.isArray(node.children) ? node.children : [];
  const out = { value };
  if (label) out.label = label;
  if (children[0]) out.left  = _structureNodeToRoot(children[0]);
  if (children[1]) out.right = _structureNodeToRoot(children[1]);
  return out;
}

/** Converts flat adjacency-list nodes (with parentId) into a nested root. */
function _adjacencyNodesToRoot(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return { value: "?" };
  const map = {};
  nodes.forEach((n) => { map[n.id ?? n.value] = { ...n, _ch: [] }; });
  let root = null;
  nodes.forEach((n) => {
    const key = n.id ?? n.value;
    if (n.parentId != null && map[n.parentId]) {
      map[n.parentId]._ch.push(map[key]);
    } else {
      root = map[key];
    }
  });
  if (!root) root = map[Object.keys(map)[0]];
  return _adjacencyNodeToRoot(root);
}
function _adjacencyNodeToRoot(node) {
  if (!node) return null;
  const out = { value: String(node.value ?? node.label ?? node.id ?? "?") };
  if (node.label && node.label !== out.value) out.label = node.label;
  const ch = node._ch || [];
  if (ch[0]) out.left  = _adjacencyNodeToRoot(ch[0]);
  if (ch[1]) out.right = _adjacencyNodeToRoot(ch[1]);
  return out;
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

  // Strip Qwen/DeepSeek-style <think>…</think> chain-of-thought blocks.
  // Thinking models emit these before the actual output; the blocks often
  // contain { characters that would fool the brace-matcher below into
  // treating reasoning prose as the JSON candidate.
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

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
