import { useEffect, useRef } from "react";

/**
 * Scrollable panel that renders finalized transcript lines plus the
 * current in-progress (interim) turn, and auto-scrolls to the bottom
 * whenever either changes.
 */
export default function TranscriptPanel({ finals, interim }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Plain `scrollTop = scrollHeight` is the most reliable cross-browser
    // way to anchor to the bottom inside a flex/min-h-0 container.
    el.scrollTop = el.scrollHeight;
  }, [finals.length, interim]);

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
        <ul className="space-y-3">
          {finals.map((line) => (
            <li
              key={line.id}
              className="leading-relaxed"
              style={{ color: "#ffffff" }}
            >
              {line.text}
            </li>
          ))}
          {interim ? (
            <li className="leading-relaxed italic text-slate-400">
              {interim}
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
