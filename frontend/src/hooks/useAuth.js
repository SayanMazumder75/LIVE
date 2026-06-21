import { useEffect, useState } from "react";
import { getToken, subscribe } from "../auth.js";

/**
 * useAuth
 * -------
 * React-side view of the SSO token store from `auth.js`. Subscribes
 * to token changes so any component that calls this hook re-renders
 * the moment MeetMind broadcasts a token (or the moment we clear it
 * on a 401).
 *
 * The auth store itself is a plain module — it works fine outside
 * React (the persistence hook reads `getToken()` directly inside
 * fetch helpers). This hook exists only so UI gating (e.g. the
 * History button) can react to token state.
 *
 * Returns:
 *   token            — current JWT string, or null
 *   isAuthenticated  — true when token is non-null
 */
export function useAuth() {
  const [token, setToken] = useState(() => getToken());

  useEffect(() => {
    // Sync once on mount in case the postMessage listener already
    // fired before this component subscribed (race with main.jsx
    // bootstrap is unlikely but cheap to guard against).
    setToken(getToken());
    return subscribe((next) => setToken(next));
  }, []);

  return {
    token,
    isAuthenticated: token !== null,
  };
}
