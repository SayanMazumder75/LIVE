/* eslint-disable no-console */
/**
 * meetmind-pip-host.js
 * --------------------
 * Drop-in script for the **MeetMind parent page** that hosts an
 * embedded AI Transcriber iframe. Document Picture-in-Picture cannot
 * be opened from inside an iframe (Chrome only allows
 * `documentPictureInPicture.requestWindow()` from a top-level
 * browsing context), so this script does it on the iframe's behalf.
 *
 * Usage on the MeetMind page:
 *
 *     <iframe
 *       src="https://ai-transcriber.example.com/"
 *       allow="microphone; display-capture; picture-in-picture; clipboard-write"
 *     ></iframe>
 *     <script src="/meetmind-pip-host.js"></script>
 *
 * That's it — the script auto-installs a postMessage listener and
 * answers any AI Transcriber iframe that probes for it. To restrict
 * which origins are allowed to open a PiP window, configure before
 * load:
 *
 *     <script>
 *       window.MeetMindAITranscriberPiPConfig = {
 *         allowedOrigins: ["https://ai-transcriber.example.com"],
 *       };
 *     </script>
 *     <script src="/meetmind-pip-host.js"></script>
 *
 * Wire protocol — messages must carry a known `source` value to be
 * processed:
 *
 *   iframe → host : { source: "ai-transcriber", type: "pip-ping" }
 *   host   → iframe: { source: "ai-transcriber-host", type: "pip-pong" }
 *   host   → iframe: { source: "ai-transcriber-host", type: "pip-unsupported" }
 *
 *   iframe → host : { source: "ai-transcriber", type: "pip-open", state }
 *   host   → iframe: { source: "ai-transcriber-host", type: "pip-opened" }
 *   host   → iframe: { source: "ai-transcriber-host", type: "pip-open-failed", error }
 *
 *   iframe → host : { source: "ai-transcriber", type: "pip-state", state }
 *   iframe → host : { source: "ai-transcriber", type: "pip-close" }
 *
 *   host   → iframe: { source: "ai-transcriber-host", type: "pip-mic-toggle" }
 *   host   → iframe: { source: "ai-transcriber-host", type: "pip-closed" }
 *
 * `state` shape:
 *   { micActive, translationActive, wsConnected, micError, statusLine }
 *
 * The widget UI rendered into the PiP window is intentionally
 * styled inline so it doesn't depend on the parent page's CSS.
 */
(function () {
  "use strict";

  if (typeof window === "undefined") return;

  // Idempotent install — multiple <script> tags or framework HMR
  // shouldn't double-install the listener.
  if (window.__meetMindAITranscriberPiPInstalled) return;
  window.__meetMindAITranscriberPiPInstalled = true;

  // ── Configuration ──────────────────────────────────────────────────
  // Read at install time. Defaults are permissive so the script
  // "just works" in development; production users should set
  // allowedOrigins to lock down which iframes can drive PiP here.
  var userConfig =
    (window.MeetMindAITranscriberPiPConfig &&
      typeof window.MeetMindAITranscriberPiPConfig === "object" &&
      window.MeetMindAITranscriberPiPConfig) ||
    {};

  // List of origins (or "*") that are allowed to talk to this host.
  // If "*" or empty, every origin is accepted — fine for dev, NOT
  // recommended for production.
  var allowedOrigins = Array.isArray(userConfig.allowedOrigins)
    ? userConfig.allowedOrigins.slice()
    : ["*"];

  function originAllowed(origin) {
    if (allowedOrigins.indexOf("*") !== -1) return true;
    return allowedOrigins.indexOf(origin) !== -1;
  }

  // ── Constants ──────────────────────────────────────────────────────
  var MSG_FROM_IFRAME = "ai-transcriber";
  var MSG_FROM_HOST = "ai-transcriber-host";

  var apiSupported =
    typeof window !== "undefined" && "documentPictureInPicture" in window;

  // ── Active session state ───────────────────────────────────────────
  // Only one PiP can be open at a time per browser tab, so we hold
  // a single active record. If a second iframe tries to open while
  // one is active, we close the first.
  //
  // active = {
  //   pipWindow: Window,          // the PiP window
  //   sourceWindow: Window,       // the iframe's window (postMessage target)
  //   sourceOrigin: string,       // origin to send messages to
  //   render: (state) => void,    // refresh the PiP DOM with new state
  // }
  var active = null;

  // ── Top-level postMessage listener ─────────────────────────────────
  window.addEventListener("message", function (event) {
    var data = event && event.data;
    if (!data || typeof data !== "object") return;
    if (data.source !== MSG_FROM_IFRAME) return;
    if (!originAllowed(event.origin)) {
      console.warn(
        "[meetmind-pip-host] ignoring message from unallowed origin:",
        event.origin
      );
      return;
    }
    var src = event.source;
    if (!src) return;
    var origin = event.origin || "*";

    switch (data.type) {
      case "pip-ping":
        replyToPing(src, origin);
        break;
      case "pip-open":
        // Critical: open the PiP window SYNCHRONOUSLY inside this
        // message handler so the user activation propagated from
        // the iframe click is still alive when requestWindow() is
        // called.
        handleOpen(src, origin, data.state);
        break;
      case "pip-state":
        handleState(src, data.state);
        break;
      case "pip-close":
        handleClose(src);
        break;
      default:
        /* ignore */
        break;
    }
  });

  function replyToPing(sourceWindow, sourceOrigin) {
    try {
      sourceWindow.postMessage(
        {
          source: MSG_FROM_HOST,
          type: apiSupported ? "pip-pong" : "pip-unsupported",
        },
        sourceOrigin
      );
    } catch (e) {
      console.warn("[meetmind-pip-host] failed to reply to ping:", e);
    }
  }

  function postToIframe(sourceWindow, sourceOrigin, payload) {
    try {
      sourceWindow.postMessage(payload, sourceOrigin);
    } catch (e) {
      console.warn("[meetmind-pip-host] failed to postMessage to iframe:", e);
    }
  }

  // ── Open the PiP window (sync inside message handler) ──────────────
  function handleOpen(sourceWindow, sourceOrigin, state) {
    if (!apiSupported) {
      postToIframe(sourceWindow, sourceOrigin, {
        source: MSG_FROM_HOST,
        type: "pip-open-failed",
        error: "documentPictureInPicture is not available in this browser",
      });
      return;
    }
    // If another session is already active, close it first. Browser
    // limits to one PiP window per tab anyway.
    if (active) {
      try {
        active.pipWindow.close();
      } catch (_e) {
        /* noop */
      }
      active = null;
    }

    // Synchronous call — must NOT be awaited before the request, or
    // user activation will be consumed.
    var requestPromise;
    try {
      requestPromise = window.documentPictureInPicture.requestWindow({
        width: 320,
        height: 220,
      });
    } catch (e) {
      postToIframe(sourceWindow, sourceOrigin, {
        source: MSG_FROM_HOST,
        type: "pip-open-failed",
        error: (e && e.message) || String(e),
      });
      return;
    }

    requestPromise.then(
      function (pipWindow) {
        var record = mountWidget(pipWindow, sourceWindow, sourceOrigin, state);
        active = record;

        // 'pagehide' is the reliable signal that the PiP window
        // closed — by user, OS, or our own close() call.
        pipWindow.addEventListener("pagehide", function () {
          if (active && active.pipWindow === pipWindow) {
            active = null;
          }
          postToIframe(sourceWindow, sourceOrigin, {
            source: MSG_FROM_HOST,
            type: "pip-closed",
          });
        });

        postToIframe(sourceWindow, sourceOrigin, {
          source: MSG_FROM_HOST,
          type: "pip-opened",
        });
      },
      function (err) {
        postToIframe(sourceWindow, sourceOrigin, {
          source: MSG_FROM_HOST,
          type: "pip-open-failed",
          error: (err && err.message) || String(err),
        });
      }
    );
  }

  function handleState(sourceWindow, state) {
    if (!active) return;
    if (active.sourceWindow !== sourceWindow) return;
    if (!state || typeof state !== "object") return;
    try {
      active.render(state);
    } catch (e) {
      console.warn("[meetmind-pip-host] render failed:", e);
    }
  }

  function handleClose(sourceWindow) {
    if (!active) return;
    if (active.sourceWindow !== sourceWindow) return;
    try {
      active.pipWindow.close();
    } catch (_e) {
      /* noop — pagehide will still fire and clean up */
    }
  }

  // ── Widget UI in the PiP window (vanilla JS) ───────────────────────
  // Mirrors the React WidgetContent in
  // frontend/src/components/FloatingMicWidget.jsx — keep visually in
  // sync if either changes.
  function mountWidget(pipWindow, sourceWindow, sourceOrigin, initialState) {
    var doc = pipWindow.document;
    doc.title = "AI Translator — Mic";

    // Inline styles only, so the widget renders consistently
    // regardless of what stylesheets the parent page does or
    // doesn't have. The PiP doc starts empty in any case.
    var body = doc.body;
    body.style.margin = "0";
    body.style.padding = "0";
    body.style.background = "#0f172a";
    body.style.color = "#ffffff";
    body.style.fontFamily =
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
    body.style.height = "100vh";
    body.style.boxSizing = "border-box";

    // Container
    var root = doc.createElement("div");
    root.style.height = "100%";
    root.style.width = "100%";
    root.style.padding = "16px";
    root.style.display = "flex";
    root.style.flexDirection = "column";
    root.style.gap = "12px";
    root.style.boxSizing = "border-box";
    body.appendChild(root);

    // Header row
    var header = doc.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";

    var title = doc.createElement("h2");
    title.textContent = "AI Translator";
    title.style.margin = "0";
    title.style.fontSize = "16px";
    title.style.fontWeight = "600";
    title.style.letterSpacing = "-0.01em";
    header.appendChild(title);

    var statusDot = doc.createElement("span");
    statusDot.setAttribute("aria-hidden", "true");
    statusDot.style.display = "inline-block";
    statusDot.style.width = "8px";
    statusDot.style.height = "8px";
    statusDot.style.borderRadius = "9999px";
    statusDot.style.background = "#ef4444";
    header.appendChild(statusDot);

    root.appendChild(header);

    // Mic toggle button (the big square one)
    var micBtn = doc.createElement("button");
    micBtn.type = "button";
    micBtn.style.flex = "1";
    micBtn.style.borderRadius = "16px";
    micBtn.style.border = "none";
    micBtn.style.color = "#ffffff";
    micBtn.style.cursor = "pointer";
    micBtn.style.display = "flex";
    micBtn.style.flexDirection = "column";
    micBtn.style.alignItems = "center";
    micBtn.style.justifyContent = "center";
    micBtn.style.gap = "4px";
    micBtn.style.padding = "12px";
    micBtn.style.transition = "background-color 0.15s ease";
    micBtn.style.fontFamily = "inherit";

    var micIcon = doc.createElement("span");
    micIcon.setAttribute("aria-hidden", "true");
    micIcon.textContent = "🎤";
    micIcon.style.fontSize = "32px";
    micIcon.style.lineHeight = "1";
    micBtn.appendChild(micIcon);

    var micLabel = doc.createElement("span");
    micLabel.style.fontSize = "24px";
    micLabel.style.fontWeight = "700";
    micLabel.style.letterSpacing = "0.02em";
    micLabel.textContent = "OFF";
    micBtn.appendChild(micLabel);

    micBtn.addEventListener("click", function () {
      // Forward to the iframe; the iframe owns the audio pipeline.
      try {
        sourceWindow.postMessage(
          { source: MSG_FROM_HOST, type: "pip-mic-toggle" },
          sourceOrigin
        );
      } catch (e) {
        console.warn(
          "[meetmind-pip-host] failed to forward mic toggle:",
          e
        );
      }
    });

    root.appendChild(micBtn);

    // Status line
    var status = doc.createElement("p");
    status.style.margin = "0";
    status.style.fontSize = "12px";
    status.style.color = "#94a3b8";
    root.appendChild(status);

    // ── Render function: paints `state` onto the existing DOM ──────
    function render(state) {
      var s = state || {};
      var micActive = !!s.micActive;
      var translationActive = !!s.translationActive;
      var wsConnected = !!s.wsConnected;
      var micError = s.micError || null;
      var statusLine =
        s.statusLine ||
        computeStatusLine(
          micActive,
          translationActive,
          wsConnected,
          micError
        );

      // Status dot
      statusDot.style.background = wsConnected ? "#10b981" : "#ef4444";
      statusDot.title = wsConnected ? "Connected" : "Disconnected";

      // Mic button
      var disabled = !translationActive;
      micBtn.disabled = disabled;
      micLabel.textContent = micActive ? "ON" : "OFF";
      if (disabled) {
        micBtn.style.background = "#1e293b";
        micBtn.style.color = "#64748b";
        micBtn.style.cursor = "not-allowed";
      } else if (micActive) {
        micBtn.style.background = "#059669";
        micBtn.style.color = "#ffffff";
        micBtn.style.cursor = "pointer";
      } else {
        micBtn.style.background = "#334155";
        micBtn.style.color = "#ffffff";
        micBtn.style.cursor = "pointer";
      }

      // Status line
      status.textContent = statusLine;
      if (micError) {
        status.style.color = "#fca5a5";
      } else if (micActive) {
        status.style.color = "#6ee7b7";
      } else {
        status.style.color = "#94a3b8";
      }
    }

    render(initialState);

    return {
      pipWindow: pipWindow,
      sourceWindow: sourceWindow,
      sourceOrigin: sourceOrigin,
      render: render,
    };
  }

  function computeStatusLine(
    micActive,
    translationActive,
    wsConnected,
    micError
  ) {
    if (!wsConnected) return "Reconnecting…";
    if (!translationActive) return "Translation not started";
    if (micError) return micError;
    if (micActive) return "Listening (mic + system)…";
    return "System audio only";
  }

  // ── Public API for debugging / explicit control ────────────────────
  window.MeetMindAITranscriberPiP = {
    /**
     * Programmatically close any active PiP window. Useful when the
     * parent page tears down the iframe and wants to make sure no
     * orphan widget remains.
     */
    closeActive: function () {
      if (!active) return;
      try {
        active.pipWindow.close();
      } catch (_e) {
        /* noop */
      }
    },
    /** True if at least one AI Transcriber PiP window is open. */
    hasActive: function () {
      return active !== null;
    },
    /** Update the allowed-origins list at runtime. */
    setAllowedOrigins: function (origins) {
      if (!Array.isArray(origins)) return;
      allowedOrigins = origins.slice();
    },
    /** True if `documentPictureInPicture` is available in this browser. */
    apiSupported: apiSupported,
  };
})();
