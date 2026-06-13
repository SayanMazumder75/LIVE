import { useEffect, useRef } from "react";

/**
 * Scrollable panel that renders transcript lines and auto-scrolls to the
 * bottom whenever a new line arrives.
 */
export default function TranscriptPanel({ transcripts }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Scroll to the very bottom; using scrollTop is reliable across browsers
    // and avoids the ancestor-scroll quirks of scrollIntoView.
    el.scrollTop = el.scrollHeight;
  }, [transcripts.length]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-y-auto rounded-lg p-6 shadow-inner"
      style={{ backgroundColor: "#1e293b" }}
    >
      {transcripts.length === 0 ? (
        <p className="italic text-slate-400">Waiting for transcript…</p>
      ) : (
        <ul className="space-y-3">
          {transcripts.map((t) => (
            <li
              key={t.id}
              className="leading-relaxed"
              style={{ color: "#ffffff" }}
            >
              {t.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
