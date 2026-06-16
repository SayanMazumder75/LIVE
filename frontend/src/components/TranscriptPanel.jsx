import { useEffect, useRef } from "react";

/**
 * WhatsApp-style chat panel.
 * - source === "mic"    → right side (owner bubble, green)
 * - source === "system" → left side (other bubble, dark)
 * - source undefined    → left side (fallback for legacy finals)
 *
 * Props:
 *   finals      Array<{id, text, translation, source, createdAt}>
 *   sysInterim  string  live system-audio partial (left side)
 *   micInterim  string  live mic partial (right side)
 *   interim     string  legacy fallback — treated as sysInterim
 */
export default function TranscriptPanel({ finals, sysInterim, micInterim, interim }) {
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

          {/* System live interim — left side */}
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