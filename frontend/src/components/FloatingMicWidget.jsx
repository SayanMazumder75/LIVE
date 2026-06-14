import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Floating microphone widget rendered into a Document
 * Picture-in-Picture window so it stays visible even after the user
 * switches to another tab (a YouTube video, a Meet call, etc.) — which
 * is the whole point of Mic+System mode.
 *
 * Browser support: Chrome 116+ / Edge 116+ (Document PiP API). On
 * unsupported browsers the trigger button is disabled with a tooltip;
 * the rest of the app keeps working with mic stuck off (system audio
 * still gets transcribed).
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
 *                        (mic only makes sense when there's a pipeline
 *                        to feed it into).
 *   wsConnected        : boolean — drives the Connected/Disconnected
 *                        status line. Auto-reconnect is handled by
 *                        useTranscriptSocket; the widget just reads
 *                        the latest status so it shows "Reconnecting…"
 *                        through brief drops.
 *   micError           : string | null — last mic-related error
 *
 * Layout: trigger button is rendered inline (caller controls position).
 * The PiP window content is portaled into pipWindow.document.body.
 */
export default function FloatingMicWidget({
  micActive,
  onMicToggle,
  onClose,
  translationActive,
  wsConnected,
  micError,
}) {
  const supported =
    typeof window !== "undefined" && "documentPictureInPicture" in window;

  const [pipWindow, setPipWindow] = useState(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Open PiP. Must run inside the same user-gesture activation as the
  // click that triggered it, so we call requestWindow synchronously
  // here without going through state-then-effect.
  const handleOpen = useCallback(async () => {
    if (!supported) return;
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
      // null out the state (which unmounts the portal) and notify
      // the host so it can disable the mic per spec item 8.
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
  }, [supported, pipWindow]);

  const handleClose = useCallback(() => {
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

  // If the component unmounts (App tear-down), close the PiP window
  // so we don't leak a floating window with no React behind it.
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

  return (
    <>
      <button
        type="button"
        onClick={pipWindow ? handleClose : handleOpen}
        disabled={!supported}
        title={
          !supported
            ? "Document Picture-in-Picture not supported. Use Chrome 116+ or Edge 116+."
            : pipWindow
            ? "Close the floating mic widget"
            : "Open the floating mic widget — stays on top of other tabs/windows"
        }
        className="px-4 py-2 rounded-md text-sm font-medium bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors"
      >
        {pipWindow ? "Close Mic Widget" : "Open Mic Widget"}
      </button>

      {pipWindow
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

// Inner widget UI rendered into the PiP window. Uses the same Tailwind
// classes as the main app; styles are copied across in
// copyStylesIntoPipWindow.
function WidgetContent({
  micActive,
  onMicToggle,
  translationActive,
  wsConnected,
  micError,
}) {
  const disabled = !translationActive;
  const statusLine = (() => {
    if (!wsConnected) return "Reconnecting…";
    if (!translationActive) return "Translation not started";
    if (micError) return micError;
    if (micActive) return "Listening (mic + system)…";
    return "System audio only";
  })();

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
