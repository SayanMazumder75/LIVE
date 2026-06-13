import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Wraps the browser's Web Speech API (`SpeechRecognition` /
 * `webkitSpeechRecognition`) for languages that AssemblyAI's streaming
 * model does not yet support — most importantly Hindi.
 *
 * Why this exists
 * ---------------
 * AAI Universal-Streaming currently only transcribes English, Spanish,
 * French, German, Italian, and Portuguese (Hindi is on their roadmap
 * but not yet shipped). When the user picks Hindi, we let the browser
 * do the recognition locally and then ship the resulting text to the
 * backend just for Gemini translation.
 *
 * Behaviour
 * ---------
 * - `continuous = true`, `interimResults = true`.
 * - `lang` is taken from the `lang` option (e.g. `"hi-IN"`).
 * - On `onresult`, finalized chunks are flushed via `onFinal(text)` and
 *   the rolling interim string is pushed via `onInterim(text)`. When a
 *   final lands, `onInterim("")` is called immediately afterwards.
 * - `onend` auto-restarts as long as the user didn't press Stop —
 *   Chrome's continuous mode self-terminates on long silences.
 * - Errors arrive on `onerror`; permission denials and unsupported
 *   languages are surfaced through the returned `error` field.
 *
 * Browser support
 * ---------------
 * Best on Chrome and Edge (Chrome routes audio through Google's STT
 * service and supports `hi-IN` natively). Safari has partial support;
 * Firefox doesn't currently expose continuous recognition. The
 * returned `supported` boolean lets the UI gate the feature
 * accordingly.
 */
export function useSpeechRecognition({ lang, onFinal, onInterim } = {}) {
  const [supported, setSupported] = useState(() => {
    if (typeof window === "undefined") return false;
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  });
  const [active, setActive] = useState(false);
  const [error, setError] = useState(null);

  // Stable refs so the recognition callbacks don't capture stale
  // closures when the parent re-renders.
  const onFinalRef = useRef(onFinal);
  const onInterimRef = useRef(onInterim);
  const langRef = useRef(lang || "en-US");
  useEffect(() => {
    onFinalRef.current = onFinal;
  }, [onFinal]);
  useEffect(() => {
    onInterimRef.current = onInterim;
  }, [onInterim]);
  useEffect(() => {
    if (lang) langRef.current = lang;
  }, [lang]);

  const recognitionRef = useRef(null);
  const userStoppedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setSupported(
      !!(window.SpeechRecognition || window.webkitSpeechRecognition)
    );
  }, []);

  const start = useCallback(async () => {
    setError(null);

    const SR =
      (typeof window !== "undefined" &&
        (window.SpeechRecognition || window.webkitSpeechRecognition)) ||
      null;
    if (!SR) {
      setError(
        "Speech recognition isn't available in this browser. Please use Chrome or Edge for Hindi mode."
      );
      return;
    }

    if (recognitionRef.current) {
      // Already running; treat as no-op.
      return;
    }

    const rec = new SR();
    rec.lang = langRef.current;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    let lastInterim = "";

    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const alt = result[0];
        const transcript = (alt && alt.transcript) || "";
        if (result.isFinal) {
          const text = transcript.trim();
          if (text && onFinalRef.current) {
            onFinalRef.current(text);
          }
        } else {
          interim += transcript;
        }
      }
      const trimmed = interim.trim();
      if (trimmed !== lastInterim) {
        lastInterim = trimmed;
        if (onInterimRef.current) onInterimRef.current(trimmed);
      }
    };

    rec.onerror = (event) => {
      // 'no-speech' is fired by Chrome on silence; not really an error
      // for a continuous transcriber. 'aborted' is the user-stopped
      // case. Both should be silent.
      const err = event && event.error;
      if (err && err !== "no-speech" && err !== "aborted") {
        // 'not-allowed' / 'service-not-allowed' = mic permission denied
        // or page not in a secure context.
        if (err === "not-allowed" || err === "service-not-allowed") {
          setError(
            "Microphone permission denied. Allow mic access and try again."
          );
        } else if (err === "language-not-supported") {
          setError(
            `Language "${rec.lang}" isn't supported by this browser's speech recognition.`
          );
        } else if (err === "network") {
          setError(
            "Speech recognition lost network connectivity. It will reconnect automatically."
          );
        } else {
          setError(`Speech recognition error: ${err}`);
        }
      }
    };

    rec.onend = () => {
      // Auto-restart unless the user pressed Stop or we've been
      // replaced. Chrome's `continuous=true` still ends after long
      // silences, and we want long-form transcription to feel seamless.
      if (recognitionRef.current !== rec) return;
      if (userStoppedRef.current) {
        recognitionRef.current = null;
        setActive(false);
        return;
      }
      try {
        rec.start();
      } catch {
        recognitionRef.current = null;
        setActive(false);
      }
    };

    userStoppedRef.current = false;
    recognitionRef.current = rec;

    try {
      rec.start();
      setActive(true);
    } catch (e) {
      // `start()` throws InvalidStateError if called too soon after a
      // previous instance ended; surface a friendly message.
      recognitionRef.current = null;
      setActive(false);
      setError(e?.message || String(e));
    }
  }, []);

  const stop = useCallback(() => {
    userStoppedRef.current = true;
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      try {
        rec.stop();
      } catch {
        /* noop */
      }
    }
    setActive(false);
    if (onInterimRef.current) onInterimRef.current("");
  }, []);

  // Always release on unmount.
  useEffect(() => {
    return () => {
      userStoppedRef.current = true;
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      if (rec) {
        try {
          rec.stop();
        } catch {
          /* noop */
        }
      }
    };
  }, []);

  return { supported, active, error, start, stop };
}
