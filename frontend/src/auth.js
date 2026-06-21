/**
 * auth.js — AI Transcriber (LIVE) frontend
 * ----------------------------------------
 * SSO token bridge ported verbatim from the speech-to-text repo.
 *
 *   Login page (issuer)  →  MeetMind parent window  →  this iframe
 *                                  │
 *                                  └── postMessage({
 *                                        type:  "MEETMIND_AUTH",
 *                                        token: "<jwt>",
 *                                      }, transcriberOrigin)
 *
 * MeetMind itself does not host the login page — it just receives a
 * token from whichever auth provider the platform uses, and forwards
 * the same token down to embedded iframes (this app and the
 * speech-to-text app) over postMessage. The contract here matches the
 * speech-to-text contract on purpose so a single MeetMind broadcast
 * authenticates both apps.
 *
 * Storage:
 *   - In-memory (`authToken`) for hot reads from `getToken()`.
 *   - `localStorage["live_auth_token"]` so a page refresh inside the
 *     iframe (or a brief disconnect) doesn't lose the token.
 *
 * Why a separate localStorage key from speech-to-text?
 *   The two apps may end up at adjacent paths on the same origin
 *   (e.g. `/transcriber` and `/speech` under the MeetMind domain).
 *   Using `live_auth_token` keeps their stored tokens independent so
 *   one app clearing the token on 401 doesn't sign the other out.
 *   Both apps still receive the same MEETMIND_AUTH broadcast in real
 *   time, so they stay in sync.
 *
 * SETUP:
 *   `import "./auth";` MUST be the first import in `main.jsx`,
 *   before React mounts. The module-level postMessage listener has
 *   to be installed before any component tries to call API endpoints
 *   that need the Authorization header.
 */

// MeetMind's exact origin — the only origin we accept tokens from.
// Set `VITE_MEETMIND_ORIGIN` at build time. The default points at
// the production MeetMind URL; override locally with .env.local.
const MEETMIND_ORIGIN =
  (typeof import.meta !== "undefined" &&
    import.meta.env &&
    import.meta.env.VITE_MEETMIND_ORIGIN) ||
  "https://meetmind.vercel.app";

const LS_KEY = "live_auth_token";

let authToken = null;

// Hot pub/sub so React components can re-render when the token
// arrives, expires, or is cleared. The speech-to-text version doesn't
// need this because every API call there reads getToken() at call
// time; this app additionally gates History UI on auth, which means
// the React tree has to learn about token changes.
const subscribers = new Set();

function notify() {
  for (const cb of subscribers) {
    try {
      cb(authToken);
    } catch (e) {
      // A faulty subscriber must never break the auth pipeline.
      // eslint-disable-next-line no-console
      console.warn("[auth] subscriber threw:", e);
    }
  }
}

// On load: restore from localStorage so a page refresh inside the
// iframe doesn't kick the user out before MeetMind broadcasts again.
try {
  const stored = localStorage.getItem(LS_KEY);
  if (stored) authToken = stored;
} catch {
  /* localStorage may be disabled (private mode, third-party-cookie
     blocking inside an iframe) — fall through to memory-only. */
}

// Listen for the SSO broadcast from MeetMind.
if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    // Strict origin check — reject anything not from MeetMind.
    // Allow "*" only in dev when VITE_MEETMIND_ORIGIN is explicitly
    // set to "*" (escape hatch for local-network testing).
    if (MEETMIND_ORIGIN !== "*" && event.origin !== MEETMIND_ORIGIN) return;

    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type !== "MEETMIND_AUTH") return;
    if (typeof data.token !== "string" || data.token.length === 0) return;

    authToken = data.token;
    try {
      localStorage.setItem(LS_KEY, data.token);
    } catch {
      /* ignore — memory fallback is fine */
    }
    // eslint-disable-next-line no-console
    console.log("[auth] token received from MeetMind.");
    notify();
  });
}

/**
 * Returns the current JWT token, or `null` if the user hasn't been
 * authenticated by MeetMind yet. Reads from memory first and falls
 * back to localStorage so the very first call after a page refresh
 * (before the postMessage handler runs) still returns the saved
 * token.
 */
export function getToken() {
  if (authToken) return authToken;
  try {
    const stored = localStorage.getItem(LS_KEY);
    if (stored) {
      // Cache it back to memory so subsequent reads avoid the
      // localStorage round-trip.
      authToken = stored;
      return stored;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Drop the cached token. Call this on a 401 response so the next
 * API call doesn't re-send the bad credential, and so the UI
 * (subscribers) can flip back to its signed-out state. MeetMind can
 * then re-broadcast a fresh token without us caching the stale one.
 */
export function clearToken() {
  authToken = null;
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
  notify();
}

/**
 * Subscribe to token changes. Returns an unsubscribe function.
 * Used by the `useAuth` React hook.
 *
 *   const off = subscribe((token) => { ... });
 *   off();
 */
export function subscribe(callback) {
  if (typeof callback !== "function") return () => {};
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

/**
 * Convenience for non-React consumers. True when a token exists.
 */
export function isAuthenticated() {
  return getToken() !== null;
}

// Exposed for debugging from the browser console — never read from
// app code. Mirrors the speech-to-text affordance.
if (typeof window !== "undefined") {
  window.__liveAuth = { getToken, clearToken, isAuthenticated };
}
