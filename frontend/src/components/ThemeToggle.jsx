import { MoonIcon, SunIcon } from "./Icons.jsx";

/**
 * Pill-shaped Sun / Moon toggle. Uses the theme tokens so it picks up
 * the dark/light surface colors automatically.
 *
 * Props:
 *   theme  : "light" | "dark"
 *   onToggle : () => void
 */
export default function ThemeToggle({ theme, onToggle }) {
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="inline-flex items-center justify-center h-9 w-9 rounded-full transition-colors hover:bg-[color:var(--surface-2)] text-[color:var(--text-muted)] hover:text-[color:var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
    >
      {isDark ? <MoonIcon className="h-4 w-4" /> : <SunIcon className="h-4 w-4" />}
    </button>
  );
}
