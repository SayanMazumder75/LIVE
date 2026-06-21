import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Floating microphone widget — Document Picture-in-Picture.
 * ---------------------------------------------------------
 * AI Transcriber can render its mic widget inside a PiP window so it
 * stays on screen while the user switches to another tab (a YouTube
 * video, a Google Meet call, the MeetMind dashboard, …).
 *
 * The component runs in **two modes**:
 *
 * 1. **Top-level page** (AI Transcriber opened in its own tab).
 *    `window.documentPictureInPicture.requestWindow()` is called
 *    directly here, and the React widget is portaled into the new
 *    window's `document.body`. Same behaviour as before.
 *
 * 2. **Embedded inside MeetMind** (or any other host page). Chrome
 *    deliberately blocks `requestWindow()` from a non-top-level
 *    browsing context (an iframe), so calling it here always
 *    rejects. Instead we **delegate to the parent** via
 *    `postMessage`. The host page is expected to load
 *    `/meetmind-pip-host.js`, which:
 *
 *      - Calls `documentPictureInPicture.requestWindow()` itself
 *        (synchronously, while the user-activation that propagated
 *        from the iframe click is still active).
 *      - Renders a small vanilla-JS widget UI inside the PiP window
 *        using the state we send across.
 *      - Forwards user interactions (mic toggle, close) back to the
 *        iframe so this component can drive the underlying audio
 *        pipeline.
 *
 *    If the host script is **not** present (no `pip-pong` reply
 *    within HOST_PING_TIMEOUT_MS), the trigger button stays
 *    disabled and the tooltip explains why — that's option B from
 *    the spec ("disable the PiP button and show a tooltip").
 *
 * Wire protocol — all envelopes carry `source` so unrelated
 * postMessage traffic (Vite HMR, analytics, etc.) is ignored:
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
 * Browser support: Chrome 116+ / Edge 116+ for the Document PiP API.
 *
 * Props:
 *   micActive          : boolean — current mic state (driven by App)
 *   onMicToggle        : () => void | Promise<void> — flip mic on/off
 *   onClose            : () => void — fires once when the PiP window
 *                        is closed (by the user or programmatically).
 *                        App uses this to disable the mic so we never
 *                        keep capturing without a visible widget.
 *   translationActive  : boolean — true while system audio is running.
 *                        When false, the Mic ON/OFF button is disabled
 *                        in the widget UI.
 *   wsConnected        : boolean — drives the Connected/Disconnected
 *                        status line.
 *   micError           : string | null — last mic-related error.
 */

// ── postMessage protocol constants ───────────────────────────────────
const MSG_FROM_IFRAME = "ai-transcriber";
const MSG_FROM_HOST = "ai-transcriber-host";

// Configure VITE_PARENT_ORIGIN at build time so messages are targeted
// at the known host. Default "*" works for development / when the
// parent's origin isn't known ahead of time.
const PARENT_ORIGIN =
  (typeof import.meta !== "undefined" &&
    import.meta.env &&
    import.meta.env.VITE_PARENT_ORIGIN) ||
  "*";

// How long to wait for the host script to acknowledge our probe
// before falling back to the disabled-button + tooltip UX. 600ms is
// long enough for cold-start scripts on slow networks but short
// enough that a missing host script feels prompt to the user.
const HOST_PING_TIMEOUT_MS = 600;

// Cross-origin-safe iframe detection. Reading `window.top` from a
// cross-origin parent throws a SecurityError — that still means
// we're embedded.
function detectIframe() {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch (_e) {
    return true;
  }
}

export default function FloatingMicWidget({
  micActive,
  onMicToggle,
  onClose,
  translationActive,
  wsConnected,
  micError,
}) {
  // Pinned at first render: changing iframe-ness mid-session is
  // impossible without a full reload anyway.
  const isEmbeddedRef = useRef(detectIframe());
  const isEmbedded = isEmbeddedRef.current;

  const apiSupportedHere =
    typeof window !== "undefined" && "documentPictureInPicture" in window;

  // ── Mode 1 (top-level) state ────────────────────────────────────────
  const [pipWindow, setPipWindow] = useState(null);

  // ── Mode 2 (embedded) state ─────────────────────────────────────────
  // hostStatus tracks whether the parent has the host script loaded:
  //   "probing"     — sent ping, waiting for pong
  //   "ready"       — host replied, PiP available
  //   "unsupported" — host replied "no PiP" or never replied at all
  const [hostStatus, setHostStatus] = useState(
    isEmbedded ? "probing" : "ready"
  );
  const [embeddedPipOpen, setEmbeddedPipOpen] = useState(false);

  // Latest props as a ref so message handlers always see fresh values
  // without re-binding event listeners on every prop change.
  const onCloseRef = useRef(onClose);
  const onMicToggleRef = useRef(onMicToggle);
  useEffect(() => {
    onCloseRef.current = onClose;
    onMicToggleRef.current = onMicToggle;
  }, [onClose, onMicToggle]);

  // Build the state payload the host renders. Recomputed on prop
  // change; the effect below pushes it across when we're embedded.
  const widgetState = useMemo(
    () => ({
      micActive: !!micActive,
      translationActive: !!translationActive,
      wsConnected: !!wsConnected,
      micError: micError || null,
      statusLine: computeStatusLine({
        micActive,
        translationActive,
        wsConnected,
        micError,
      }),
    }),
    [micActive, translationActive, wsConnected, micError]
  );

  // ─────────────────────────────────────────────────────────────────────
  //  Embedded mode: postMessage plumbing
  // ─────────────────────────────────────────────────────────────────────

  // Probe the host on mount. If it doesn't answer in
  // HOST_PING_TIMEOUT_MS, mark as unsupported so the button shows the
  // "PiP unavailable in embedded mode" tooltip.
  useEffect(() => {
    if (!isEmbedded) return undefined;

    let timeout;
    const onMessage = (event) => {
      const data = event?.data;
      if (!data || typeof data !== "object") return;
      if (data.source !== MSG_FROM_HOST) return;

      switch (data.type) {
        case "pip-pong":
          setHostStatus("ready");
          break;
        case "pip-unsupported":
          setHostStatus("unsupported");
          break;
        case "pip-opened":
          setEmbeddedPipOpen(true);
          break;
        case "pip-open-failed":
          // Host tried, browser refused. Treat as unsupported for
          // this session so the user gets a clear tooltip instead of
          // a button that silently does nothing.
          setEmbeddedPipOpen(false);
          setHostStatus("unsupported");
          // eslint-disable-next-line no-console
          console.warn(
            "[mic-widget] host failed to open PiP:",
            data.error || "(no reason given)"
          );
          break;
        case "pip-closed":
          setEmbeddedPipOpen(false);
          if (onCloseRef.current) {
            try {
              onCloseRef.current();
            } catch {
              /* noop */
            }
          }
          break;
        case "pip-mic-toggle":
          if (onMicToggleRef.current) {
            try {
              onMicToggleRef.current();
            } catch {
              /* noop */
            }
          }
          break;
        default:
          /* ignore unknown messages */
          break;
      }
    };

    window.addEventListener("message", onMessage);

    // Send the probe. We post to window.parent because window.top
    // may be a deeper grandparent in nested frames; the message
    // protocol only contracts with the immediate parent.
    try {
      window.parent.postMessage(
        { source: MSG_FROM_IFRAME, type: "pip-ping" },
        PARENT_ORIGIN
      );
    } catch (e) {
      // postMessage to a cross-origin parent shouldn't throw, but if
      // it does we have no host — flip straight to unsupported.
      // eslint-disable-next-line no-console
      console.warn("[mic-widget] failed to ping parent:", e);
      setHostStatus("unsupported");
    }

    timeout = window.setTimeout(() => {
      // Use the functional setter so we don't clobber a "ready"
      // status that arrived just before the timeout fired.
      setHostStatus((prev) => (prev === "probing" ? "unsupported" : prev));
    }, HOST_PING_TIMEOUT_MS);

    return () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timeout);
    };
  }, [isEmbedded]);

  // Stream state updates to the host so its PiP UI tracks the live
  // mic / translation status. Only fires while a PiP window is
  // actually open — there's no point updating something that isn't
  // rendered.
  useEffect(() => {
    if (!isEmbedded) return;
    if (!embeddedPipOpen) return;
    try {
      window.parent.postMessage(
        {
          source: MSG_FROM_IFRAME,
          type: "pip-state",
          state: widgetState,
        },
        PARENT_ORIGIN
      );
    } catch {
      /* noop */
    }
  }, [isEmbedded, embeddedPipOpen, widgetState]);

  // If the component unmounts while the embedded PiP is open, ask
  // the host to close it so we don't leave a floating window with
  // nothing driving its state.
  useEffect(() => {
    if (!isEmbedded) return undefined;
    return () => {
      if (embeddedPipOpen) {
        try {
          window.parent.postMessage(
            { source: MSG_FROM_IFRAME, type: "pip-close" },
            PARENT_ORIGIN
          );
        } catch {
          /* noop */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEmbedded]);

  // ─────────────────────────────────────────────────────────────────────
  //  Top-level mode: open / close the PiP window in this tab directly
  // ─────────────────────────────────────────────────────────────────────

  // Must run inside the same user-gesture activation as the click,
  // so we call requestWindow synchronously here without going through
  // state-then-effect.
  const handleOpenTopLevel = useCallback(async () => {
    if (!apiSupportedHere) return;
    if (pipWindow) return;
    try {
      const w = await window.documentPictureInPicture.requestWindow({
        width: 320,
        height: 220,
      });
      copyStylesIntoPipWindow(w);

      // Make the PiP body match the dark theme so brief flashes of
      // unstyled content don't show before React mounts the portal.
      w.document.title = "AI Translator — Mic";
      const body = w.document.body;
      body.style.margin = "0";
      body.style.padding = "0";
      body.style.background = "#0f172a";
      body.style.color = "#ffffff";
      body.style.fontFamily =
        'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
      body.style.height = "100vh";

      // 'pagehide' is the reliable signal that the PiP window has
      // been closed — by the user, by the OS, or by programmatic
      // close(). React's portal target goes away with it, so we
      // null out state (which unmounts the portal) and notify the
      // host so it can disable the mic.
      w.addEventListener("pagehide", () => {
        setPipWindow(null);
        if (onCloseRef.current) {
          try {
            onCloseRef.current();
          } catch {
            /* noop */
          }
        }
      });

      setPipWindow(w);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[mic-widget] failed to open PiP:", e);
    }
  }, [apiSupportedHere, pipWindow]);

  const handleCloseTopLevel = useCallback(() => {
    if (pipWindow) {
      try {
        pipWindow.close();
      } catch {
        /* noop */
      }
      // Don't null state here; let pagehide do it so the close path
      // is the same whether the user closes from inside the widget
      // or via the OS chrome.
    }
  }, [pipWindow]);

  // If the component unmounts (App tear-down), close the top-level
  // PiP window so we don't leak a floating window with no React
  // behind it. Embedded teardown is handled in its own effect above.
  useEffect(() => {
    return () => {
      const w = pipWindow;
      if (w) {
        try {
          w.close();
        } catch {
          /* noop */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─────────────────────────────────────────────────────────────────────
  //  Embedded mode: open / close requests to host
  // ─────────────────────────────────────────────────────────────────────

  const handleOpenEmbedded = useCallback(() => {
    if (hostStatus !== "ready") return;
    if (embeddedPipOpen) return;
    try {
      // Send the open request synchronously inside the click so the
      // user activation propagates from this iframe to the parent.
      // The parent's host script will then call requestWindow() while
      // activation is still hot. (Chrome propagates user activation
      // from descendant frames; the parent's own activation flag is
      // set when this click is dispatched.)
      window.parent.postMessage(
        {
          source: MSG_FROM_IFRAME,
          type: "pip-open",
          state: widgetState,
        },
        PARENT_ORIGIN
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[mic-widget] failed to request PiP open:", e);
    }
  }, [hostStatus, embeddedPipOpen, widgetState]);

  const handleCloseEmbedded = useCallback(() => {
    if (!embeddedPipOpen) return;
    try {
      window.parent.postMessage(
        { source: MSG_FROM_IFRAME, type: "pip-close" },
        PARENT_ORIGIN
      );
    } catch {
      /* noop */
    }
    // Optimistically close locally; the host will follow up with
    // pip-closed which idempotently resets state.
  }, [embeddedPipOpen]);

  // ─────────────────────────────────────────────────────────────────────
  //  Render
  // ─────────────────────────────────────────────────────────────────────

  // Effective "is the floating widget visible right now?"
  const widgetOpen = isEmbedded ? embeddedPipOpen : !!pipWindow;

  // Effective "is the open-button usable?"
  const supported = isEmbedded
    ? hostStatus === "ready"
    : apiSupportedHere;

  const buttonTitle = (() => {
    if (!isEmbedded && !apiSupportedHere) {
      return "Document Picture-in-Picture not supported. Use Chrome 116+ or Edge 116+.";
    }
    if (isEmbedded) {
      if (hostStatus === "probing") {
        return "Detecting host page support for the floating mic widget…";
      }
      if (hostStatus === "unsupported") {
        return (
          "Picture-in-Picture is unavailable in embedded mode. " +
          "Open AI Transcriber in its own tab to use the floating mic widget, " +
          "or ask the host page to load /meetmind-pip-host.js."
        );
      }
    }
    if (widgetOpen) return "Close the floating mic widget";
    return "Open the floating mic widget — stays on top of other tabs/windows";
  })();

  const onClick = () => {
    if (widgetOpen) {
      if (isEmbedded) handleCloseEmbedded();
      else handleCloseTopLevel();
    } else {
      if (isEmbedded) handleOpenEmbedded();
      else handleOpenTopLevel();
    }
  };

  // While probing in embedded mode, keep the button disabled so the
  // user can't fire an open before we know whether the host can
  // honour it. Once probed, `supported` reflects the real answer.
  const buttonDisabled =
    !supported || (isEmbedded && hostStatus === "probing");

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={buttonDisabled}
        title={buttonTitle}
        className="px-4 py-2 rounded-md text-sm font-medium bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors"
      >
        {widgetOpen ? "Close Mic Widget" : "Open Mic Widget"}
      </button>

      {/* Top-level mode renders the React widget into the PiP
          window's DOM via a portal. Embedded mode does NOT render
          here — the host script paints its own widget UI from the
          state we postMessage across, because cross-origin React
          portals into another window's document aren't possible. */}
      {!isEmbedded && pipWindow
        ? createPortal(
            <WidgetContent
              micActive={micActive}
              onMicToggle={onMicToggle}
              translationActive={translationActive}
              wsConnected={wsConnected}
              micError={micError}
            />,
            pipWindow.document.body
          )
        : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────

function computeStatusLine({
  micActive,
  translationActive,
  wsConnected,
  micError,
}) {
  if (!wsConnected) return "Reconnecting…";
  if (!translationActive) return "Translation not started";
  if (micError) return micError;
  if (micActive) return "Listening (mic + system)…";
  return "System audio only";
}

// Inner widget UI rendered into the PiP window in **top-level mode**.
// Embedded mode's host script paints its own equivalent UI in vanilla
// JS — keep the two visually in sync if either changes.
function WidgetContent({
  micActive,
  onMicToggle,
  translationActive,
  wsConnected,
  micError,
}) {
  const disabled = !translationActive;
  const statusLine = computeStatusLine({
    micActive,
    translationActive,
    wsConnected,
    micError,
  });

  return (
    <div
      className="h-full w-full p-4 flex flex-col gap-3"
      style={{ backgroundColor: "#0f172a", color: "#ffffff" }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold tracking-tight">AI Translator</h2>
        <span
          aria-hidden="true"
          className={`inline-block h-2 w-2 rounded-full ${
            wsConnected ? "bg-emerald-500" : "bg-red-500"
          }`}
          title={wsConnected ? "Connected" : "Disconnected"}
        />
      </div>

      <button
        type="button"
        onClick={onMicToggle}
        disabled={disabled}
        className={`flex-1 rounded-2xl flex flex-col items-center justify-center gap-1 transition-colors text-white ${
          disabled
            ? "bg-slate-800 text-slate-500 cursor-not-allowed"
            : micActive
            ? "bg-emerald-600 hover:bg-emerald-500"
            : "bg-slate-700 hover:bg-slate-600"
        }`}
      >
        <span style={{ fontSize: "2rem", lineHeight: 1 }} aria-hidden="true">
          🎤
        </span>
        <span className="text-2xl font-bold tracking-wide">
          {micActive ? "ON" : "OFF"}
        </span>
      </button>

      <p
        className={`text-xs ${
          micError
            ? "text-red-300"
            : micActive
            ? "text-emerald-300"
            : "text-slate-400"
        }`}
      >
        {statusLine}
      </p>
    </div>
  );
}

/**
 * Copy stylesheets from the host document into the PiP document so
 * Tailwind utility classes work the same in the floating window.
 *
 * Inline `<style>` rules and same-origin `<link rel="stylesheet">`
 * sheets can be read out as cssText and re-inserted as <style> tags.
 * Cross-origin sheets throw on `cssRules` access — we fall back to a
 * fresh <link> in that case.
 */
function copyStylesIntoPipWindow(pipWindow) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const cssText = Array.from(sheet.cssRules || [])
        .map((r) => r.cssText)
        .join("\n");
      if (cssText) {
        const style = pipWindow.document.createElement("style");
        style.textContent = cssText;
        pipWindow.document.head.appendChild(style);
        continue;
      }
    } catch (_e) {
      // Cross-origin / opaque sheet — fall through to <link>.
    }
    if (sheet.href) {
      const link = pipWindow.document.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      if (sheet.media && sheet.media.mediaText) {
        link.media = sheet.media.mediaText;
      }
      pipWindow.document.head.appendChild(link);
    }
  }
}
