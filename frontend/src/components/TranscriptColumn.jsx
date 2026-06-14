import { useEffect, useRef } from "react";

/**
 * One column of the two-pane transcript layout. Identical visual shell
 * for "System Audio" and "Microphone" — the difference is just which
 * icon and finals/interim are passed in.
 *
 * Why a fresh component instead of reusing TranscriptPanel: the new
 * column has its own header (icon + title + active pill), its own
 * empty-state copy, and uses theme tokens rather than hard-coded
 * dark colors so it adapts to light/dark mode.
 *
 * Props:
 *   icon         : ReactElement — leading icon in the header
 *   title        : string — e.g. "System Audio"
 *   subtitle     : string — small caption under the title
 *   accent       : "indigo" | "violet" | "emerald" — header pill color
 *   finals       : Array<{ id, text, translation: string|null }>
 *   interim      : string
 *   active       : boolean — controls the "live" pill
 *   placeholder  : ReactNode — what to show when there's nothing yet
 */
export default function TranscriptColumn({
  icon,
  title,
  subtitle,
  accent = "indigo",
  finals,
  interim,
  active,
  placeholder,
}) {
  const scrollRef = useRef(null);

  // Re-anchor whenever the content changes — including when a
  // translation is attached to an existing line (which doesn't change
  // finals.length but does grow the rendered list vertically).
  const translationsKey = finals.map((l) => (l.translation ? "1" : "0")).join("");
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [finals.length, interim, translationsKey]);

  const isEmpty = finals.length === 0 && !interim;

  const accentText = ACCENT_CLASSES[accent]?.text || ACCENT_CLASSES.indigo.text;
  const accentBg = ACCENT_CLASSES[accent]?.bg || ACCENT_CLASSES.indigo.bg;
  const accentRing = ACCENT_CLASSES[accent]?.ring || ACCENT_CLASSES.indigo.ring;

  return (
    <section
      className={`flex flex-col h-full overflow-hidden rounded-2xl border bg-[color:var(--surface)] border-[color:var(--border)] shadow-sm`}
    >
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-4 border-b border-[color:var(--border)]">
        <div className="flex items-center gap-3 min-w-0">
          <span
            className={`inline-flex items-center justify-center h-9 w-9 rounded-xl ${accentBg} ${accentText}`}
          >
            {icon}
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[color:var(--text)] truncate">
              {title}
            </h3>
            {subtitle ? (
              <p className="text-xs text-[color:var(--text-muted)] truncate">
                {subtitle}
              </p>
            ) : null}
          </div>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
            active
              ? `${accentBg} ${accentText} ring-1 ${accentRing}`
              : "bg-[color:var(--surface-2)] text-[color:var(--text-muted)]"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              active ? "animate-pulse bg-current" : "bg-current opacity-60"
            }`}
            aria-hidden="true"
          />
          {active ? "Live" : "Idle"}
        </span>
      </header>

      {/* Body */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto thin-scroll px-5 py-4"
      >
        {isEmpty ? (
          <div className="h-full flex items-center justify-center text-center">
            <div className="text-sm text-[color:var(--text-muted)] max-w-xs leading-relaxed">
              {placeholder}
            </div>
          </div>
        ) : (
          <ul className="space-y-3.5">
            {finals.map((line) => (
              <li
                key={line.id}
                className="rounded-xl bg-[color:var(--surface-2)] px-4 py-3 leading-relaxed"
              >
                <p className="text-[color:var(--text)] text-sm">{line.text}</p>
                {line.translation && line.translation !== line.text ? (
                  <p
                    className={`mt-1.5 text-sm italic ${accentText} flex gap-1`}
                  >
                    <span className="not-italic">→</span>
                    <span>{line.translation}</span>
                  </p>
                ) : null}
              </li>
            ))}
            {interim ? (
              <li className="rounded-xl border border-dashed border-[color:var(--border-strong)] px-4 py-3 italic text-sm text-[color:var(--text-muted)] leading-relaxed">
                {interim}
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </section>
  );
}

// Tailwind doesn't pick up dynamic class names, so we keep them in a
// static lookup table.
const ACCENT_CLASSES = {
  indigo: {
    text: "text-indigo-600 dark:text-indigo-300",
    bg: "bg-indigo-50 dark:bg-indigo-500/10",
    ring: "ring-indigo-200/60 dark:ring-indigo-400/20",
  },
  violet: {
    text: "text-violet-600 dark:text-violet-300",
    bg: "bg-violet-50 dark:bg-violet-500/10",
    ring: "ring-violet-200/60 dark:ring-violet-400/20",
  },
  emerald: {
    text: "text-emerald-600 dark:text-emerald-300",
    bg: "bg-emerald-50 dark:bg-emerald-500/10",
    ring: "ring-emerald-200/60 dark:ring-emerald-400/20",
  },
};
