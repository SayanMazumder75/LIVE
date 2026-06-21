/**
 * auth.js — LIVE Translator Frontend
 *
 * Same SSO bridge pattern speech-to-text uses, decoupled from any
 * specific parent application. A trusted parent window (whichever
 * app issues your tokens) hands us a JWT via window.postMessage,
 * we keep it in memory + localStorage, and every API request that
 * goes through `authFetch()` automatically attaches it as
 * `Authorization: Bearer <token>`.
 *
 * Why this lives at the top of the import graph
 * ---------------------------------------------
 * `main.jsx` imports this module BEFORE rendering the React tree, so
 * the postMessage listener is registered on `window` before any
 * `<App/>` mount can race with an incoming auth message. Without
 * that ordering a token sent during the very first frame could be
 * silently dropped.
 *
 * SSO contract
 * ------------
 *     Parent (whichever app issues your tokens) does:
 *         iframeRef.contentWindow.postMessage(
 *             { type: "MEETMIND_AUTH", token: "<jwt>" },
 *             "<this app's origin>"
 *         );
 *
 *     We accept the message ONLY when:
 *         - event.origin === AUTH_ORIGIN   (strict equality, no wildcards)
 *         - event.data.type === "MEETMIND_AUTH"
 *         - event.data.token is a non-empty string
 *
 *     The literal string "MEETMIND_AUTH" is preserved as the
 *     message-type discriminator so this module is drop-in
 *     compatible with the same parent that sends tokens to the
 *     speech-to-text app — the only thing you have to change is
 *     pointing AUTH_ORIGIN at YOUR parent's domain.
 *
 *     On successful receipt we cache the token, persist it, and
 *     notify any React subscribers so the UI flips from
 *     "sign-in required" to "history visible" in real time.
 *
 * Local development without a parent
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

// ⚠️ Set this to the EXACT origin of whichever parent window will
// post auth tokens to LIVE — the same source that issues tokens to
// your other apps (e.g. speech-to-text). Strict equality, no
// trailing slash, no wildcards.
//
// Configure via VITE_AUTH_ORIGIN. The legacy VITE_MEETMIND_ORIGIN
// name still works for backward compatibility with any deploy
// configs that already use it.
//
// Default is the empty string, which makes the strict-equality
// origin check fail for every incoming message — i.e. auth stays
// completely off until the env var is configured. That's
// deliberate: an unconfigured production build should never
// silently accept tokens from any random parent.
const AUTH_ORIGIN =
  import.meta.env.VITE_AUTH_ORIGIN ||
  import.meta.env.VITE_MEETMIND_ORIGIN ||
  "";

// localStorage key. Distinct from speech-to-text's "stt_auth_token"
// so the two apps can coexist on the same browser without stomping
// each other's tokens.
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
  // Without a configured SSO origin, skip wiring the listener
  // entirely. Otherwise an empty-string AUTH_ORIGIN would still
  // attach (and harmlessly reject every message), which is just
  // wasted work + noisy in stack traces during development.
  if (AUTH_ORIGIN) {
    window.addEventListener("message", (event) => {
      // Strict origin check — reject anything not from the
      // configured SSO host. This is the entire security boundary;
      // never relax it (no wildcards, no `*`, no startsWith()).
      if (event.origin !== AUTH_ORIGIN) return;

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
        console.log(`[LIVE] Auth token received from ${AUTH_ORIGIN}.`);
      }
    });
  } else if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.info(
      "[LIVE] VITE_AUTH_ORIGIN is not set; postMessage SSO is disabled. " +
        "Set it to your auth host's origin to enable the saved-history view."
    );
  }
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

/**
 * The configured SSO origin. Exposed read-only so UI components
 * can reflect "you'll be signed in once you open this app from
 * https://your-host.example.com" without hardcoding the value
 * in two places.
 */
export function getAuthOrigin() {
  return AUTH_ORIGIN;
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
    getAuthOrigin,
  };
}
