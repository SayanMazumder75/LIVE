import { useEffect, useRef, useState } from "react";

/**
 * WhatsApp-style chat panel.
 * - source === "mic"    → right side (owner bubble, green)
 * - source === "system" → left side (other bubble, dark)
 * - source undefined    → left side (fallback for legacy finals)
 *
 * Props:
 *   finals          Array<{id, text, translation, source, createdAt}>
 *   sysInterim      string  live system-audio partial (left side)
 *   micInterim      string  live mic partial (right side)
 *   interim         string  legacy fallback — treated as sysInterim
 *
 *   concepts        Array<{name, summary}>  optional. When present, the
 *                   FIRST occurrence of each concept in the finals is
 *                   wrapped in a <ConceptHighlight/> with a tooltip on
 *                   hover and a click handler that fires onConceptClick.
 *                   Interim text is never highlighted (it changes
 *                   constantly).
 *   onConceptClick  (concept) => void  fires when the user clicks a
 *                   highlighted concept; the parent opens the
 *                   ConceptDrawer with the full teacher-style
 *                   explanation.
 */
export default function TranscriptPanel({
  finals,
  sysInterim,
  micInterim,
  interim,
  concepts,
  onConceptClick,
}) {
  const containerRef = useRef(null);

  // Resolve effective interims — sysInterim/micInterim take priority;
  // legacy `interim` falls back to sys side when neither is provided.
  const effectiveSysInterim =
    typeof sysInterim === "string"
      ? sysInterim
      : typeof interim === "string" && !micInterim
      ? interim
      : "";

  const effectiveMicInterim =
    typeof micInterim === "string" ? micInterim : "";

  const translationsKey = finals.map((l) => (l.translation ? "1" : "0")).join("");

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [finals.length, effectiveSysInterim, effectiveMicInterim, translationsKey]);

  const isEmpty = finals.length === 0 && !effectiveSysInterim && !effectiveMicInterim;

  // Single shared Set for the whole render walk. Mutated by
  // renderWithHighlights as we move from bubble to bubble so the
  // FIRST occurrence anywhere in the transcript wins. The Set is
  // recreated on every render — never persisted across renders —
  // because `finals`, `concepts`, and the order in which we walk
  // them all could have changed.
  const seenConcepts = new Set();
  const conceptsList = Array.isArray(concepts) ? concepts : [];

  return (
    <div ref={containerRef} className="transcript-chat-container">
      {isEmpty ? (
        <p className="transcript-empty">
          Click <span className="transcript-empty-highlight">Start Translation</span>{" "}
          and pick a tab or screen to begin.
        </p>
      ) : (
        <div className="transcript-messages">
          {finals.map((line) => {
            const isMic = line.source === "mic";
            const textNodes = renderWithHighlights(
              line.text || "",
              conceptsList,
              seenConcepts,
              onConceptClick,
              `${line.id}-text`
            );
            const translationNodes =
              line.translation && line.translation !== line.text
                ? renderWithHighlights(
                    line.translation,
                    conceptsList,
                    seenConcepts,
                    onConceptClick,
                    `${line.id}-trans`
                  )
                : null;
            return (
              <div
                key={line.id}
                className={`transcript-row ${isMic ? "transcript-row--right" : "transcript-row--left"}`}
              >
                {!isMic && (
                  <div className="transcript-avatar transcript-avatar--sys">SYS</div>
                )}

                <div
                  className={`transcript-bubble ${
                    isMic ? "transcript-bubble--mic" : "transcript-bubble--sys"
                  }`}
                >
                  <p className="transcript-bubble-text">{textNodes}</p>
                  {translationNodes ? (
                    <p className="transcript-bubble-translation">
                      <span className="transcript-translation-arrow">→</span>
                      {translationNodes}
                    </p>
                  ) : null}
                  <span className="transcript-bubble-time">
                    {line.createdAt
                      ? new Date(line.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : ""}
                  </span>
                </div>

                {isMic && (
                  <div className="transcript-avatar transcript-avatar--mic">MIC</div>
                )}
              </div>
            );
          })}

          {/* System live interim — left side. Interim text is NOT
              concept-highlighted because it changes on every chunk;
              wrapping unstable text in interactive elements would
              flash and steal focus. */}
          {effectiveSysInterim ? (
            <div className="transcript-row transcript-row--left">
              <div className="transcript-avatar transcript-avatar--sys">SYS</div>
              <div className="transcript-bubble transcript-bubble--sys transcript-bubble--interim">
                <p className="transcript-bubble-text">{effectiveSysInterim}</p>
                <span className="transcript-typing-dots">
                  <span /><span /><span />
                </span>
              </div>
            </div>
          ) : null}

          {/* Mic live interim — right side */}
          {effectiveMicInterim ? (
            <div className="transcript-row transcript-row--right">
              <div className="transcript-bubble transcript-bubble--mic transcript-bubble--interim">
                <p className="transcript-bubble-text">{effectiveMicInterim}</p>
                <span className="transcript-typing-dots">
                  <span /><span /><span />
                </span>
              </div>
              <div className="transcript-avatar transcript-avatar--mic">MIC</div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Concept highlighting helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Find the earliest case-insensitive occurrence of any concept in
 * `text` that hasn't already been highlighted in the seen set.
 * Returns { concept, pos, length } or null.
 *
 * The match is required to sit on a "word edge" — i.e. the character
 * immediately before/after must not be a letter/digit — so that
 * "Tree" doesn't match inside "streetwise". For non-Latin scripts
 * this still works because /[\p{L}\p{N}]/u recognises Unicode letter
 * + number characters.
 */
function findEarliestUnseen(text, concepts, alreadySeen) {
  if (!text) return null;
  const lower = text.toLowerCase();
  let bestPos = -1;
  let bestConcept = null;
  let bestLen = 0;
  for (const concept of concepts) {
    if (!concept?.name) continue;
    if (alreadySeen.has(concept.name)) continue;
    const needle = concept.name.toLowerCase();
    if (!needle) continue;
    let from = 0;
    while (from <= lower.length) {
      const idx = lower.indexOf(needle, from);
      if (idx < 0) break;
      const before = idx === 0 ? "" : text.charAt(idx - 1);
      const afterIdx = idx + needle.length;
      const after = afterIdx >= text.length ? "" : text.charAt(afterIdx);
      if (!isWordChar(before) && !isWordChar(after)) {
        if (bestPos < 0 || idx < bestPos) {
          bestPos = idx;
          bestConcept = concept;
          bestLen = needle.length;
        }
        break; // first valid occurrence in this string is enough
      }
      from = idx + 1;
    }
  }
  if (!bestConcept) return null;
  return { concept: bestConcept, pos: bestPos, length: bestLen };
}

const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
function isWordChar(c) {
  if (!c) return false;
  return WORD_CHAR_RE.test(c);
}

/**
 * Walk through `text` and return either the original string (when no
 * concepts hit) or an array of strings + <ConceptHighlight/> elements
 * with each first-occurrence-anywhere wrapped. Mutates `alreadySeen`.
 */
function renderWithHighlights(text, concepts, alreadySeen, onClick, baseKey) {
  if (!text || !concepts || concepts.length === 0) return text;

  const parts = [];
  let remaining = text;
  let cursor = 0;
  let part = 0;
  // Bound the loop to prevent any pathological case from looping
  // forever — there's a hard ceiling of `concepts.length` matches per
  // string anyway because each match consumes a concept from the
  // not-yet-seen pool.
  for (let safety = 0; safety < concepts.length + 1; safety++) {
    const match = findEarliestUnseen(remaining, concepts, alreadySeen);
    if (!match) {
      if (remaining) parts.push(remaining);
      break;
    }
    if (match.pos > 0) parts.push(remaining.slice(0, match.pos));
    const matchedText = remaining.slice(match.pos, match.pos + match.length);
    parts.push(
      <ConceptHighlight
        key={`${baseKey}-${part}-${match.concept.name}`}
        concept={match.concept}
        matchedText={matchedText}
        onClick={onClick}
      />
    );
    alreadySeen.add(match.concept.name);
    remaining = remaining.slice(match.pos + match.length);
    cursor += match.pos + match.length;
    part += 1;
    if (!remaining) break;
  }

  return parts.length === 0 ? text : parts;
}

// ─────────────────────────────────────────────────────────────────────────
// ConceptHighlight + Tooltip
// ─────────────────────────────────────────────────────────────────────────

function ConceptHighlight({ concept, matchedText, onClick }) {
  const [showTip, setShowTip] = useState(false);
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`Open explanation for ${concept.name}`}
      title=""  // suppress browser default; we render our own tooltip
      onMouseEnter={() => setShowTip(true)}
      onMouseLeave={() => setShowTip(false)}
      onFocus={() => setShowTip(true)}
      onBlur={() => setShowTip(false)}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(concept);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.(concept);
        }
        if (e.key === "Escape") setShowTip(false);
      }}
      style={{
        position: "relative",
        cursor: "pointer",
        background:
          "linear-gradient(135deg, rgba(168,85,247,0.18), rgba(217,70,239,0.10))",
        borderBottom: "2px dotted rgba(192,132,252,0.7)",
        padding: "0 3px",
        margin: "0 1px",
        borderRadius: 3,
        color: "inherit",
        fontWeight: 600,
        outline: "none",
        transition: "background 0.15s",
      }}
      onMouseDown={(e) => {
        // Tiny visual press feedback without re-render churn.
        e.currentTarget.style.background =
          "linear-gradient(135deg, rgba(168,85,247,0.32), rgba(217,70,239,0.20))";
      }}
      onMouseUp={(e) => {
        e.currentTarget.style.background =
          "linear-gradient(135deg, rgba(168,85,247,0.18), rgba(217,70,239,0.10))";
      }}
    >
      {matchedText}
      {showTip ? <ConceptTooltip concept={concept} /> : null}
    </span>
  );
}

function ConceptTooltip({ concept }) {
  // The tooltip renders inside the same span, positioned absolutely.
  // It's intentionally pointer-events:none so hover-tracking on the
  // parent stays stable when the tooltip overflows the bubble edge.
  //
  // IMPORTANT: every child here must be a phrasing-content element
  // (span / a / strong / etc.), NOT a block element like <div>. The
  // tooltip is rendered inside <ConceptHighlight/> which is a <span>
  // which itself is rendered inside <p className="transcript-bubble-text">
  // (and the translation <p>). React's HTML validator throws
  //   validateDOMNesting(...): <div> cannot appear as a descendant of <p>
  // on any block element nested under <p>. Using <span style={{ display:
  // "block" }}> gives us the visual stacking we want without the DOM
  // nesting violation.
  return (
    <span
      role="tooltip"
      style={{
        position: "absolute",
        bottom: "calc(100% + 6px)",
        left: "50%",
        transform: "translateX(-50%)",
        background: "#0b1220",
        border: "1px solid rgba(168,85,247,0.45)",
        boxShadow: "0 12px 28px rgba(0,0,0,0.55)",
        color: "#e2e8f0",
        padding: "8px 10px",
        borderRadius: 8,
        fontSize: 12,
        fontWeight: 400,
        lineHeight: 1.45,
        whiteSpace: "normal",
        width: 240,
        textAlign: "left",
        zIndex: 50,
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          display: "block",
          fontWeight: 700,
          color: "#c4b5fd",
          marginBottom: 3,
          fontSize: 12,
        }}
      >
        {concept.name}
      </span>
      {concept.summary ? (
        <span
          style={{
            display: "block",
            color: "#cbd5e1",
            marginBottom: 4,
          }}
        >
          {concept.summary}
        </span>
      ) : null}
      <span
        style={{
          display: "block",
          color: "#a78bfa",
          fontSize: 10,
          fontStyle: "italic",
          letterSpacing: "0.02em",
        }}
      >
        Click for full explanation →
      </span>
    </span>
  );
}
