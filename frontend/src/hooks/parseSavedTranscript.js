/**
 * parseSavedTranscript
 * --------------------
 * Turn the `text` blob stored in a session document back into the
 * same `finals` array shape the live `<TranscriptPanel/>` expects.
 * That way "open saved session" can reuse the *exact* same component
 * that renders the live transcript — bubbles, avatars, timestamps,
 * translation arrows — without any saved-mode UI duplicated.
 *
 * Stored format (produced by `useSessionPersistence.flushFinals`):
 *
 *     [SYSTEM] [12:00:01] hello world
 *     [MIC]    [12:00:02] aap kaise hain
 *     [MIC]    [12:00:02] → how are you doing
 *     ...
 *
 *   - `[SOURCE]` is one of `MIC` / `SYSTEM` / `SYS` (legacy alias).
 *   - `[HH:MM:SS]` is the wall-clock time at which the line was
 *     finalised on the client.
 *   - A line whose body starts with `→ ` is the *translation* of the
 *     most recent same-source line that shares its timestamp. The
 *     live finals carry these as a `translation` field on the same
 *     entry, so we re-attach them here to keep the bubble layout
 *     identical between live and saved views.
 *
 * @param {string}        text             Raw `session.text` from the API.
 * @param {string|number} sessionCreatedAt Date for combining with HH:MM:SS so
 *                                         the rendered "12:34" labels are
 *                                         consistent with when the meeting
 *                                         actually happened.
 * @returns {Array<{id:string, text:string, translation?:string,
 *                  source:"mic"|"system", createdAt:number}>}
 */
export function parseSavedTranscript(text, sessionCreatedAt) {
  if (!text || typeof text !== "string") return [];

  const lines = text.split("\n");
  // [SOURCE] [HH:MM:SS] body  — tolerant of `MIC` / `SYS` / `SYSTEM`.
  const lineRe = /^\[(MIC|SYSTEM|SYS)\]\s+\[(\d{2}:\d{2}:\d{2})\]\s+(.*)$/i;

  const base = sessionCreatedAt ? new Date(sessionCreatedAt) : new Date();
  const baseTime = Number.isNaN(base.getTime()) ? new Date() : base;

  // Use a temporary `_timeStr` field to match translations to their
  // originals (both share the same HH:MM:SS string when produced by
  // flushFinals). Stripped before returning so callers see the same
  // shape `<TranscriptPanel/>` gets from live sockets.
  const finals = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;

    const match = lineRe.exec(raw);
    if (!match) {
      // Unrecognised format (legacy data, manual edits, etc.) — show
      // it as-is rather than dropping it. Falls to the system side.
      finals.push({
        id: `saved-${i}`,
        text: raw,
        source: "system",
        createdAt: baseTime.getTime() + i * 1000,
      });
      continue;
    }

    const [, src, time, content] = match;
    const source = src.toUpperCase() === "MIC" ? "mic" : "system";
    const isTranslation = content.startsWith("→ ");
    const body = isTranslation ? content.slice(2).trim() : content;

    if (isTranslation) {
      // Walk backwards looking for the most recent same-source,
      // same-time entry without a translation already attached.
      let attached = false;
      for (let j = finals.length - 1; j >= 0; j--) {
        const prev = finals[j];
        if (
          prev.source === source &&
          prev._timeStr === time &&
          !prev.translation
        ) {
          prev.translation = body;
          attached = true;
          break;
        }
      }
      if (attached) continue;
      // No matching original — preserve as a standalone line so
      // saved data is never silently dropped.
    }

    const [hh, mm, ss] = time.split(":").map((n) => parseInt(n, 10));
    const dt = new Date(baseTime);
    dt.setHours(hh || 0, mm || 0, ss || 0, 0);

    finals.push({
      id: `saved-${i}`,
      text: isTranslation ? `→ ${body}` : body,
      source,
      createdAt: dt.getTime(),
      _timeStr: time,
    });
  }

  // Strip internal field before returning.
  return finals.map(({ _timeStr, ...rest }) => rest);
}
