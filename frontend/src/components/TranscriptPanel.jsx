import { useEffect, useRef } from "react";

/**
 * WhatsApp-style chat panel.
 * - source === "mic"    → right side (owner bubble, green)
 * - source === "system" → left side (other bubble, dark)
 * - source undefined    → left side (fallback for legacy finals)
 *
 * All logic untouched. Only rendering changed.
 */
export default function TranscriptPanel({ finals, interim }) {
  const containerRef = useRef(null);

  const translationsKey = finals.map((l) => (l.translation ? "1" : "0")).join("");

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [finals.length, interim, translationsKey]);

  const isEmpty = finals.length === 0 && !interim;

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
            return (
              <div
                key={line.id}
                className={`transcript-row ${isMic ? "transcript-row--right" : "transcript-row--left"}`}
              >
                {/* Avatar label */}
                {!isMic && (
                  <div className="transcript-avatar transcript-avatar--sys">SYS</div>
                )}

                <div
                  className={`transcript-bubble ${
                    isMic ? "transcript-bubble--mic" : "transcript-bubble--sys"
                  }`}
                >
                  <p className="transcript-bubble-text">{line.text}</p>
                  {line.translation && line.translation !== line.text ? (
                    <p className="transcript-bubble-translation">
                      <span className="transcript-translation-arrow">→</span>
                      {line.translation}
                    </p>
                  ) : null}
                  <span className="transcript-bubble-time">
                    {new Date().toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>

                {isMic && (
                  <div className="transcript-avatar transcript-avatar--mic">MIC</div>
                )}
              </div>
            );
          })}

          {interim ? (
            <div className="transcript-row transcript-row--left">
              <div className="transcript-avatar transcript-avatar--sys">SYS</div>
              <div className="transcript-bubble transcript-bubble--sys transcript-bubble--interim">
                <p className="transcript-bubble-text">{interim}</p>
                <span className="transcript-typing-dots">
                  <span /><span /><span />
                </span>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}