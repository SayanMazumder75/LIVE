import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "ai-translator-theme";

/**
 * Persistent light / dark theme toggle.
 *
 * - Reads the saved choice from localStorage on mount; falls back to
 *   the OS `prefers-color-scheme` preference; falls back to dark.
 * - Reflects the active theme onto `<html class="dark">` so Tailwind's
 *   class-based dark-mode strategy (configured in tailwind.config.js)
 *   takes effect everywhere.
 * - Saves the user's choice back to localStorage so refreshes are
 *   sticky.
 *
 * Returns: { theme: "light" | "dark", toggle, setTheme }.
 */
export function useTheme() {
  const [theme, setThemeState] = useState(() => readInitialTheme());

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* localStorage may be blocked in private mode */
    }
  }, [theme]);

  const setTheme = useCallback((next) => {
    setThemeState(next === "light" ? "light" : "dark");
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  return { theme, setTheme, toggle };
}

function readInitialTheme() {
  if (typeof window === "undefined") return "dark";
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* ignore */
  }
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    return "light";
  }
  return "dark";
}
