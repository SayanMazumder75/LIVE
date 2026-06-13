import { useEffect, useRef } from "react";

/**
 * Scrollable panel that renders finalized transcript lines plus the
 * current in-progress (interim) turn, and auto-scrolls to the bottom
 * whenever either changes.
 *
 * Each finalized line may carry an optional `translation` string. When
 * present (and different from the original), it's rendered underneath
 * the original text in a muted accent color. Translations stream in
 * after the transcript itself, so existing lines update in place when a
 * translation arrives.
 */
export default function TranscriptPanel({ finals, interim }) {
  const containerRef = useRef(null);

  // Re-anchor whenever the content changes — including when a
  // translation gets attached to an existing line (which doesn't change
  // `finals.length` but does grow the rendered list vertically).
  const translationsKey = finals.map((l) => (l.translation ? "1" : "0")).join("");

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [finals.length, interim, translationsKey]);

  const isEmpty = finals.length === 0 && !interim;

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-y-auto rounded-lg p-6 shadow-inner"
      style={{ backgroundColor: "#1e293b" }}
    >
      {isEmpty ? (
        <p className="italic text-slate-400">
          Click <span className="font-medium text-slate-300">Start Microphone</span>{" "}
          and begin speaking.
        </p>
      ) : (
        <ul className="space-y-4">
          {finals.map((line) => (
            <li key={line.id} className="leading-relaxed">
              <p style={{ color: "#ffffff" }}>{line.text}</p>
              {line.translation && line.translation !== line.text ? (
                <p className="mt-1 text-sm italic text-emerald-300">
                  <span className="not-italic mr-1 text-emerald-500">→</span>
                  {line.translation}
                </p>
              ) : null}
            </li>
          ))}
          {interim ? (
            <li className="leading-relaxed italic text-slate-400">{interim}</li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
