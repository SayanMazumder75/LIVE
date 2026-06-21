/**
 * main.jsx — AI Transcriber (embedded in MeetMind)
 *
 * auth.js is imported FIRST, before React even renders App.
 * This mirrors the exact Speech-to-Text pattern so the postMessage
 * listener is registered as early as possible — MeetMind may fire
 * the MEETMIND_AUTH message immediately after the iframe loads.
 */
import Auth from "./Auth.jsx"; // must import before App to register postMessage listener
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);