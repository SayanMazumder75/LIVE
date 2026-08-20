const MEETMIND_ORIGIN = import.meta.env.VITE_MEETMIND_ORIGIN || "http://localhost:5173";
const LS_KEY = "transcriber_auth_token";

let authToken = null;
const listeners = new Set(); // ← NEW

try {
  const stored = localStorage.getItem(LS_KEY);
  if (stored) authToken = stored;
} catch {}

function _notify() {
  for (const fn of listeners) {
    try { fn(authToken); } catch {}
  }
}

window.addEventListener("message", (event) => {
  if (event.origin !== MEETMIND_ORIGIN) return;
  if (event.source !== window.parent) return; // hardening from your spec

  if (
    event.data &&
    event.data.type === "MEETMIND_AUTH" &&
    typeof event.data.token === "string" &&
    event.data.token.length > 0
  ) {
    authToken = event.data.token;
    try { localStorage.setItem(LS_KEY, event.data.token); } catch {}
    console.log("[Transcriber] Auth token received from MeetMind.");
    _notify(); // ← NEW, this is what makes App.jsx re-render
  }
});

export const getToken = () => {
  if (authToken) return authToken;
  try { return localStorage.getItem(LS_KEY); } catch { return null; }
};

export const clearToken = () => {
  authToken = null;
  try { localStorage.removeItem(LS_KEY); } catch {}
  _notify();
};

export const isAuthenticated = () => Boolean(getToken());

/** Subscribe to token changes. Returns unsubscribe fn. */
export const subscribeAuth = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/**
 * Resolves with the auth token as soon as one is available.
 * If a token is already cached it resolves synchronously (next microtask).
 * Otherwise it waits up to `timeoutMs` (default 5 s) for the postMessage
 * from MeetMind before resolving with null — so callers never hang forever.
 */
export const waitForToken = (timeoutMs = 5000) => {
  const current = getToken();
  if (current) return Promise.resolve(current);

  return new Promise((resolve) => {
    let unsub;
    const timer = setTimeout(() => {
      unsub?.();
      resolve(null);
    }, timeoutMs);

    unsub = subscribeAuth((token) => {
      if (token) {
        clearTimeout(timer);
        unsub();
        resolve(token);
      }
    });
  });
};