import { useCallback, useEffect, useRef, useState } from "react";

const TARGET_SAMPLE_RATE = 16000;

/**
 * Captures microphone audio via getUserMedia, runs it through an
 * AudioWorklet that downsamples to 16 kHz mono PCM16, and delivers each
 * chunk (an ArrayBuffer) via the `onAudio` callback.
 *
 * Returns:
 *   active : boolean  - whether the mic is currently capturing
 *   error  : string|null
 *   start  : () => Promise<void>
 *   stop   : () => Promise<void>
 *
 * `getUserMedia` requires a secure context (HTTPS or localhost) and a
 * user gesture, so always call `start()` from a button click.
 */
export function useMicrophone(onAudio) {
  const [active, setActive] = useState(false);
  const [error, setError] = useState(null);

  // Keep a stable ref so the worklet's onmessage doesn't capture a stale
  // callback after re-renders.
  const onAudioRef = useRef(onAudio);
  useEffect(() => {
    onAudioRef.current = onAudio;
  }, [onAudio]);

  const audioCtxRef = useRef(null);
  const streamRef = useRef(null);
  const sourceRef = useRef(null);
  const workletRef = useRef(null);

  const stop = useCallback(async () => {
    if (workletRef.current) {
      try {
        workletRef.current.port.onmessage = null;
      } catch {
        /* noop */
      }
      try {
        workletRef.current.disconnect();
      } catch {
        /* noop */
      }
      workletRef.current = null;
    }
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch {
        /* noop */
      }
      sourceRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* noop */
        }
      });
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      try {
        await audioCtxRef.current.close();
      } catch {
        /* noop */
      }
      audioCtxRef.current = null;
    }
    setActive(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia
    ) {
      setError(
        "Microphone access is not supported in this browser, or the page is not served over HTTPS/localhost."
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      streamRef.current = stream;

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        throw new Error("AudioContext is not available in this browser");
      }
      const audioCtx = new AudioCtx();
      audioCtxRef.current = audioCtx;
      // Some browsers create the context in "suspended" state.
      if (audioCtx.state === "suspended") {
        try {
          await audioCtx.resume();
        } catch {
          /* noop */
        }
      }

      await audioCtx.audioWorklet.addModule("/pcm-worklet.js");

      const source = audioCtx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const worklet = new AudioWorkletNode(audioCtx, "pcm-downsampler", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE },
      });
      workletRef.current = worklet;

      worklet.port.onmessage = (event) => {
        const cb = onAudioRef.current;
        if (cb && event.data) {
          cb(event.data); // ArrayBuffer of Int16 little-endian PCM
        }
      };

      source.connect(worklet);
      // Intentionally NOT connected to `audioCtx.destination` — we don't
      // want to play the user's voice back through their speakers.

      setActive(true);
    } catch (e) {
      setError(e?.message || String(e));
      await stop();
    }
  }, [stop]);

  // Always release the mic when the component unmounts.
  useEffect(() => {
    return () => {
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { active, error, start, stop };
}
