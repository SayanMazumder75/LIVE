/**
 * auth.js — LIVE Translator Frontend
 *
 * Same SSO bridge pattern used by the standalone speech-to-text app:
 * a parent window (MeetMind) hands us a JWT via window.postMessage,
 * we keep it in memory + localStorage, and every API request that
 * goes through `authFetch()` automatically attaches it as
 * `Authorization: Bearer <token>`.
 *
 * Why this lives at the top of the import graph
 * ---------------------------------------------
 * `main.jsx` imports this module BEFORE rendering the React tree, so
 * the postMessage listener is registered on `window` before any
 * `<App/>` mount can race with an incoming MEETMIND_AUTH message.
 * Without that ordering a token sent during the very first frame
 * could be silently dropped.
 *
 * SSO contract (matches speech-to-text byte-for-byte)
 * ---------------------------------------------------
 *     Parent (MeetMind) does:
 *         iframeRef.contentWindow.postMessage(
 *             { type: "MEETMIND_AUTH", token: "<jwt>" },
 *             "<this app's origin>"
 *         );
 *
 *     We accept the message ONLY when:
 *         - event.origin === MEETMIND_ORIGIN  (strict equality, no wildcards)
 *         - event.data.type === "MEETMIND_AUTH"
 *         - event.data.token is a non-empty string
 *
 *     On successful receipt we cache the token, persist it, and
 *     notify any React subscribers so the UI can flip from
 *     "sign-in required" to "history visible" in real time.
 *
 * Local development without MeetMind
 * ----------------------------------
 * To unblock testing while running standalone, drop a token into
 * localStorage from DevTools:
 *
 *     localStorage.setItem("live_auth_token", "dev-token")
 *     location.reload()
 *
 * Or, in dev builds, call window.__liveAuth.setToken("dev-token")
 * — see the dev-only attachment at the bottom of this file.
 */

// ⚠️ Set this to your exact MeetMind frontend origin (no trailing slash).
// Override per environment via VITE_MEETMIND_ORIGIN in frontend/.env.
const MEETMIND_ORIGIN =
  import.meta.env.VITE_MEETMIND_ORIGIN || "https://meetmind.vercel.app";

const LS_KEY = "live_auth_token";

// In-memory cache so we don't hit localStorage on every request.
// Always treated as the source of truth; localStorage is only a
// fallback for page refresh.
let authToken = null;

// Subscribers are React hook callbacks (see useAuthToken). Plain
// `Set` of zero-arg functions; we ignore the new value on
// notification because subscribers re-read via `getToken()` for
// `useSyncExternalStore` snapshot stability.
const subscribers = new Set();

// ── boot: rehydrate from localStorage ────────────────────────────────────
try {
  const stored = localStorage.getItem(LS_KEY);
  if (stored) authToken = stored;
} catch {
  /* SSR / iframe with disabled storage — ignore */
}

// ── postMessage listener (the actual SSO bridge) ─────────────────────────
if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    // Strict origin check — reject anything not from MeetMind.
    if (event.origin !== MEETMIND_ORIGIN) return;

    if (
      event.data &&
      event.data.type === "MEETMIND_AUTH" &&
      typeof event.data.token === "string" &&
      event.data.token.length > 0
    ) {
      _setToken(event.data.token);
      // Surface in the dev console so deploying engineers can
      // verify the handshake worked without rebuilding the app.
      // eslint-disable-next-line no-console
      console.log("[LIVE] Auth token received from MeetMind.");
    }
  });
}

// ── internal mutator + subscriber notification ───────────────────────────
function _setToken(token) {
  const next = token || null;
  if (next === authToken) return; // identity gate — avoid wakeful re-renders
  authToken = next;
  try {
    if (next) localStorage.setItem(LS_KEY, next);
    else localStorage.removeItem(LS_KEY);
  } catch {
    /* storage disabled — token still works in memory */
  }
  for (const fn of subscribers) {
    try {
      fn(next);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[auth] subscriber threw:", e);
    }
  }
}

// ── public API ───────────────────────────────────────────────────────────

/**
 * Returns the current JWT, or null. Falls back to localStorage so a
 * fresh page load picks up the previously-stored token before any
 * subscriber registers.
 */
export function getToken() {
  if (authToken) return authToken;
  try {
    return localStorage.getItem(LS_KEY);
  } catch {
    return null;
  }
}

/** Set the token from anywhere (dev console, custom login UI, …). */
export function setToken(token) {
  _setToken(token);
}

/** Clear the token — used on logout and on every 401 response. */
export function clearToken() {
  _setToken(null);
}

/** True iff a non-empty token is currently held. */
export function isAuthenticated() {
  return Boolean(getToken());
}

/**
 * Subscribe to token changes. Returns an unsubscribe function so
 * `useSyncExternalStore` can clean up on unmount.
 */
export function subscribe(listener) {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

/**
 * Drop-in replacement for `fetch()` that:
 *   - auto-attaches `Authorization: Bearer <token>` when one is held
 *     (and the caller hasn't already set their own Authorization
 *     header — caller wins for non-standard auth schemes),
 *   - clears the cached token on 401 so the UI flips back to
 *     unauthenticated state without the caller having to remember.
 *
 * The body / method / signal / etc. all pass through unchanged.
 */
export async function authFetch(input, init = {}) {
  const token = getToken();
  const headers = new Headers(init.headers || {});
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    // eslint-disable-next-line no-console
    console.warn("[LIVE] 401 received — token invalid or expired. Clearing.");
    clearToken();
  }
  return res;
}

// ── dev-only convenience handle ──────────────────────────────────────────
// Lets you flip auth state from DevTools without reloading the page,
// which is the difference between testing this feature in 3 seconds
// vs 30 seconds. Tree-shaken out of production builds because Vite
// inlines `import.meta.env.DEV` to `false`.
if (import.meta.env.DEV && typeof window !== "undefined") {
  window.__liveAuth = {
    setToken,
    clearToken,
    getToken,
    isAuthenticated,
  };
}
