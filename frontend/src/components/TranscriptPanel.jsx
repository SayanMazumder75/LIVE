import { Fragment, useEffect, useRef, useState } from "react";

// A "conversation block" is a run of consecutive finals from the SAME
// source separated by less than this many milliseconds. When silence
// exceeds the threshold the block ends and any future final from the
// same source starts a new block. 30 seconds is what we landed on after
// trying 10 / 60: short enough to break naturally between speaker turns,
// long enough that normal pauses inside one utterance don't fragment
// the block.
const SILENCE_GAP_MS = 30_000;

/**
 * WhatsApp-style chat panel.
 *
 * Source binding is permanent and decided BEFORE rendering:
 *   - finals come in tagged with `source` ("mic" | "system") at the
 *     moment each WebSocket onmessage handler appends them.
 *   - interim text is taken in PER source so a mic interim renders on
 *     the right (mic-styled) and a sys interim on the left (sys-styled).
 *
 * Conversation-level timing (PHASE 3 Part A):
 *   - Per-message timestamps are gone. Instead, consecutive finals from
 *     the same source are grouped into a "block" and a single header
 *     above the block shows "SYSTEM AUDIO   10:30 AM → 10:35 AM".
 *   - The latest block per source has a LIVE end time while that
 *     source's interim is non-empty: the header re-renders once a
 *     second so the user sees the range growing in real time.
 *   - When the source falls silent (interim cleared), the end time
 *     freezes at the last final's createdAt. A new utterance >
 *     SILENCE_GAP_MS later starts a fresh block.
 *
 * Props:
 *   finals      Array<{id, text, translation: string|null, source, createdAt}>
 *   sysInterim  string  in-progress system-audio transcript
 *   micInterim  string  in-progress microphone transcript
 *   interim     string  (legacy) treated as sysInterim if neither
 *                       per-source value was provided.
 */
export default function TranscriptPanel({
  finals,
  sysInterim,
  micInterim,
  interim,
}) {
  const containerRef = useRef(null);

  const effectiveSysInterim =
    typeof sysInterim === "string"
      ? sysInterim
      : typeof interim === "string" && !micInterim
      ? interim
      : "";
  const effectiveMicInterim =
    typeof micInterim === "string" ? micInterim : "";

  // `now` ticks once a second while ANY interim is active so the
  // open block's end time updates on screen even if the user is
  // briefly silent between interim updates. When both interims go
  // empty, the interval stops and the displayed time freezes
  // automatically — that's how the "freeze end time when conversation
  // finishes" bullet from the spec is met.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!effectiveSysInterim && !effectiveMicInterim) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [effectiveSysInterim, effectiveMicInterim]);

  const blocks = computeConversationBlocks(
    finals,
    Boolean(effectiveSysInterim),
    Boolean(effectiveMicInterim),
    now
  );

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
    <div ref={containerRef} className="transcript-chat-container thin-scroll">
      {isEmpty ? (
        <p className="transcript-empty">
          Click <span className="transcript-empty-highlight">Start Translation</span>{" "}
          and pick a tab or screen to begin.
        </p>
      ) : (
        <div className="transcript-messages">
          {blocks.map((block) => (
            <Fragment key={`block-${block.source}-${block.startsAt}`}>
              <ConversationBlockHeader
                source={block.source}
                startsAt={block.startsAt}
                endsAt={block.endsAt}
                live={block.live}
              />
              {block.lines.map((line) => {
                const isMic = line.source === "mic";
                return (
                  <div
                    key={line.id}
                    className={`transcript-row ${
                      isMic ? "transcript-row--right" : "transcript-row--left"
                    }`}
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
                    </div>

                    {isMic && (
                      <div className="transcript-avatar transcript-avatar--mic">MIC</div>
                    )}
                  </div>
                );
              })}
            </Fragment>
          ))}

          {/* Interim bubbles. They're never grouped into blocks — by
              definition they're "the part the user is still saying", so
              they sit at the bottom of their column and morph into a
              real bubble (under their block's header) when the segment
              finalises. The block above them is the one whose live
              end time is currently advancing. */}
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

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function ConversationBlockHeader({ source, startsAt, endsAt, live }) {
  const isMic = source === "mic";
  const sourceLabel = isMic ? "MICROPHONE" : "SYSTEM AUDIO";
  // Centered narrow band, source-tinted. Tailwind utilities only — no
  // new CSS rules in index.css to keep this PR's surface tight.
  const colorClasses = isMic
    ? "text-violet-600 dark:text-violet-300"
    : "text-indigo-600 dark:text-indigo-300";
  return (
    <div
      className={`flex flex-col items-center gap-0.5 my-3 ${
        live ? "animate-pulse-soft" : ""
      }`}
    >
      <span
        className={`text-[0.65rem] font-bold uppercase tracking-[0.18em] ${colorClasses}`}
      >
        {sourceLabel}
      </span>
      <span className="text-xs tabular-nums text-[color:var(--text-muted)]">
        {formatBlockTime(startsAt)}
        <span className="mx-1.5 opacity-60" aria-hidden="true">→</span>
        {formatBlockTime(endsAt)}
        {live ? (
          <span className="ml-1.5 text-[color:var(--text-subtle)]">·</span>
        ) : null}
        {live ? (
          <span className="ml-1.5 italic text-[color:var(--text-subtle)]">live</span>
        ) : null}
      </span>
    </div>
  );
}

function formatBlockTime(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Group consecutive same-source finals into conversation blocks.
 *
 * Each block carries:
 *   { source, startsAt, endsAt, live, lines }
 *
 * Rules implemented:
 *   - Every line gets bucketed into exactly one block.
 *   - A block ends when the next line is from a different source OR
 *     when the time gap to the previous line exceeds SILENCE_GAP_MS.
 *   - For the latest block of each source, if that source's interim
 *     is currently active, `endsAt` is bumped to `now` and `live` is
 *     true. As soon as the interim is cleared the next render fixes
 *     `endsAt` at the last line's createdAt — the "freeze end time
 *     when conversation finishes" rule in the spec.
 *   - Lines without a numeric createdAt fall back to 0 (legacy
 *     defensive path; current code always populates createdAt).
 */
function computeConversationBlocks(finals, hasSysActive, hasMicActive, now) {
  const blocks = [];
  let current = null;

  for (const line of finals) {
    const ts =
      typeof line.createdAt === "number" && Number.isFinite(line.createdAt)
        ? line.createdAt
        : 0;
    const source = line.source === "mic" ? "mic" : "system";

    const breaks =
      !current ||
      current.source !== source ||
      ts - current.endsAt > SILENCE_GAP_MS;

    if (breaks) {
      if (current) blocks.push(current);
      current = {
        source,
        startsAt: ts,
        endsAt: ts,
        live: false,
        lines: [line],
      };
    } else {
      current.endsAt = ts;
      current.lines.push(line);
    }
  }
  if (current) blocks.push(current);

  // Find the most recent block per source. Walking once and just
  // tracking the latest index for each is O(n) and avoids slice/some
  // calls inside a loop.
  let latestSysIdx = -1;
  let latestMicIdx = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].source === "mic") latestMicIdx = i;
    else latestSysIdx = i;
  }

  if (hasSysActive && latestSysIdx >= 0) {
    blocks[latestSysIdx] = {
      ...blocks[latestSysIdx],
      endsAt: Math.max(blocks[latestSysIdx].endsAt, now),
      live: true,
    };
  }
  if (hasMicActive && latestMicIdx >= 0) {
    blocks[latestMicIdx] = {
      ...blocks[latestMicIdx],
      endsAt: Math.max(blocks[latestMicIdx].endsAt, now),
      live: true,
    };
  }

  return blocks;
}
