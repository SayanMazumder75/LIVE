/**
 * main.jsx — AI Transcriber (embedded in MeetMind)
 *
 * Imports auth.js FIRST to register postMessage listener before any renders.
 * Sets up global Axios interceptor that auto-attaches Bearer token.
 */

import "./auth"; // ← MUST be first import — registers postMessage listener

import React from "react";
import ReactDOM from "react-dom/client";
import axios from "axios";
import { getToken, clearToken } from "./auth";
import App from "./App.jsx";
import "./index.css";

// ── Global Axios Interceptor ──────────────────────────────────────────────────
// Attaches Authorization: Bearer <token> to every outgoing request automatically.
// No need to manually add headers in any API call throughout the app.

axios.interceptors.request.use(
  (config) => {
    const token = getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// ── Response Interceptor — handle 401 ────────────────────────────────────────
// If token expired or invalid, clear it so user gets re-authenticated.

axios.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      console.warn("[Transcriber] 401 received — token invalid or expired. Clearing.");
      clearToken();
    }
    return Promise.reject(error);
  }
);

// ── Mount App ─────────────────────────────────────────────────────────────────

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);