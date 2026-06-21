/**
 * auth.js — AI Transcriber (embedded in MeetMind)
 *
 * Exact same architecture as the Speech-to-Text project's auth.js.
 * Receives JWT from MeetMind via postMessage (SSO bridge).
 * Stores token in memory + localStorage for page refresh survival.
 * Exports getToken() used by all API/WS calls in App.jsx.
 *
 * SETUP: import this file early in main.jsx BEFORE App renders:
 *   import "./auth";
 */

// ⚠️ SET THIS to your exact MeetMind frontend domain (no trailing slash)
// Examples:
//   "https://meetmind.vercel.app"
//   "http://localhost:3000"
const MEETMIND_ORIGIN =
  import.meta.env.VITE_MEETMIND_ORIGIN || "https://meetmind.vercel.app";

const LS_KEY = "transcriber_auth_token"; // different key from stt_auth_token to avoid collisions

let authToken = null;

// On load: restore from localStorage (handles page refresh inside iframe)
try {
  const stored = localStorage.getItem(LS_KEY);
  if (stored) authToken = stored;
} catch {}

// Listen for JWT sent from MeetMind parent window
window.addEventListener("message", (event) => {
  // Strict origin check — reject anything not from MeetMind
  if (event.origin !== MEETMIND_ORIGIN) return;

  if (
    event.data &&
    event.data.type === "MEETMIND_AUTH" &&
    typeof event.data.token === "string" &&
    event.data.token.length > 0
  ) {
    authToken = event.data.token;
    try {
      localStorage.setItem(LS_KEY, event.data.token);
    } catch {}
    console.log("[Transcriber] Auth token received from MeetMind.");
  }
});

/**
 * Returns current JWT token.
 * Used wherever an Authorization header is needed.
 */
export const getToken = () => {
  if (authToken) return authToken;
  try {
    return localStorage.getItem(LS_KEY);
  } catch {
    return null;
  }
};

/**
 * Clear token (logout / token expired handling)
 */
export const clearToken = () => {
  authToken = null;
  try {
    localStorage.removeItem(LS_KEY);
  } catch {}
};

/**
 * True only when a token is present.
 * App.jsx renders the "Please login through MeetMind" gate on false.
 */
export const isAuthenticated = () => Boolean(getToken());