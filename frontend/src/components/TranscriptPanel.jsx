import { useEffect, useRef } from "react";

/**
 * WhatsApp-style chat panel.
 *
 * Source binding is permanent and decided BEFORE rendering:
 *   - finals come in tagged with `source` ("mic" | "system") at the
 *     moment each WebSocket onmessage handler appends them. We render
 *     each line on its own side and never move it.
 *   - interim text used to be merged into a single string by the host,
 *     which lost the source — so a mic interim would render on the
 *     left (sys-styled) and only "jump" to the right when the segment
 *     finalised. We now take TWO separate interim strings, each
 *     associated with its own source, and render each on its own side.
 *
 * source === "mic"     → right side (mic bubble, accent)
 * source === "system"  → left side  (sys bubble, neutral)
 * undefined            → left side  (defensive fallback for legacy finals)
 *
 * Props:
 *   finals      Array<{id, text, translation: string|null, source}>
 *   sysInterim  string  in-progress system-audio transcript
 *   micInterim  string  in-progress microphone transcript
 *   interim     string  (legacy) accepted for backward compatibility:
 *                       if neither sysInterim nor micInterim is set,
 *                       this falls back into the sys side. Existing
 *                       callers that still pass a single `interim`
 *                       keep working but should migrate.
 */
export default function TranscriptPanel({
  finals,
  sysInterim,
  micInterim,
  interim,
}) {
  const containerRef = useRef(null);

  // Backwards compat: if a legacy single `interim` was passed and
  // nothing per-source was, treat it as the sys interim. We never
  // route a legacy interim onto the mic side because that's where
  // the bug used to live; safer to default to the neutral side.
  const effectiveSysInterim =
    typeof sysInterim === "string"
      ? sysInterim
      : typeof interim === "string" && !micInterim
      ? interim
      : "";
  const effectiveMicInterim =
    typeof micInterim === "string" ? micInterim : "";

  const translationsKey = finals
    .map((l) => (l.translation ? "1" : "0"))
    .join("");

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [finals.length, effectiveSysInterim, effectiveMicInterim, translationsKey]);

  const isEmpty =
    finals.length === 0 && !effectiveSysInterim && !effectiveMicInterim;

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
                {/* Avatar label (left side) */}
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

                {/* Avatar label (right side) */}
                {isMic && (
                  <div className="transcript-avatar transcript-avatar--mic">MIC</div>
                )}
              </div>
            );
          })}

          {/* In-progress system audio — always on the left, never moves */}
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

          {/* In-progress microphone — always on the right, never moves.
              This is the line that fixes the user's "appears as System
              first then jumps to Mic" report: mic interim is rendered
              on the mic side from the very first frame, so when the
              segment finalises and the line moves from the interim
              area into the finals list, it stays on the same side. */}
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
