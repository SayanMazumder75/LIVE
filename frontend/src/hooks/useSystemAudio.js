import { useCallback, useEffect, useRef, useState } from "react";

const TARGET_SAMPLE_RATE = 16000;

/**
 * Captures **system audio** — tab audio (e.g. YouTube, Google Meet) or
 * full-screen audio — via `getDisplayMedia`, runs it through the same
 * AudioWorklet pipeline as `useMicrophone`, and delivers each chunk
 * (an ArrayBuffer of 16 kHz mono int16 LE PCM) via the `onAudio`
 * callback.
 *
 * Returns:
 *   active : boolean  - whether system audio is currently being captured
 *   error  : string|null
 *   start  : () => Promise<boolean>   - resolves false if the user
 *                                       cancelled the share picker or
 *                                       the platform doesn't support
 *                                       audio capture; true on success
 *   stop   : () => Promise<void>
 *
 * Browser support
 * ---------------
 * - Chrome / Edge (desktop): tab audio (any tab) and system audio
 *   (Entire Screen) are both supported. Window-sharing has no audio.
 * - Firefox: limited; tab audio works on some platforms.
 * - Safari: not supported in most versions.
 *
 * What the user must do
 * ---------------------
 * In the browser's share picker:
 *   1. Pick a Tab or Entire Screen (Window mode has no audio).
 *   2. Tick "Share tab audio" or "Share system audio" before clicking
 *      Share.
 *
 * If the resulting MediaStream has no audio tracks, we surface a clear
 * error and stop without setting up the worklet.
 *
 * The hook is parallel to `useMicrophone` — neither depends on the
 * other; the host (App.jsx) starts whichever one matches the user's
 * selection. Both hooks can be instantiated simultaneously without
 * conflict because each owns its own AudioContext + stream + worklet
 * and only allocates them on `start()`.
 */
export function useSystemAudio(onAudio) {
  const [active, setActive] = useState(false);
  const [error, setError] = useState(null);

  // Stable ref so the worklet's onmessage doesn't capture a stale
  // callback after re-renders.
  const onAudioRef = useRef(onAudio);
  useEffect(() => {
    onAudioRef.current = onAudio;
  }, [onAudio]);

  const audioCtxRef = useRef(null);
  const streamRef = useRef(null);
  const sourceRef = useRef(null);
  const workletRef = useRef(null);
  const sentChunksRef = useRef(0);
  // Holds the listener we attached to the audio track's `ended` event,
  // so `stop()` can detach it before tearing down the stream and we
  // don't recurse.
  const onTrackEndedRef = useRef(null);

  const stop = useCallback(async () => {
    // Detach the 'ended' listener BEFORE stopping the tracks, otherwise
    // calling `track.stop()` would fire it and recurse into `stop()`.
    if (streamRef.current && onTrackEndedRef.current) {
      const handler = onTrackEndedRef.current;
      streamRef.current.getTracks().forEach((t) => {
        try {
          t.removeEventListener("ended", handler);
        } catch {
          /* noop */
        }
      });
      onTrackEndedRef.current = null;
    }

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
      !navigator.mediaDevices.getDisplayMedia
    ) {
      setError(
        "System audio capture isn't supported in this browser. Use Chrome or Edge on a desktop OS."
      );
      return false;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        // The spec requires `video: true` for getDisplayMedia even when
        // we only want audio. We discard the video track immediately
        // below so it doesn't waste resources.
        video: true,
        audio: {
          // Don't apply browser-side processing — the source (YouTube,
          // Meet, podcast, etc.) is already clean and EC/NS would only
          // make it worse.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (e) {
      // The user clicking "Cancel" in the share picker rejects with
      // NotAllowedError. Treat that as a silent no-op so we don't show
      // a scary error for a normal user choice.
      if (e?.name === "NotAllowedError") {
        return false;
      }
      setError(e?.message || String(e));
      return false;
    }

    // The stream may or may not include an audio track:
    // - Sharing a Window never produces an audio track.
    // - Sharing a Tab/Screen without ticking "Share audio" leaves the
    //   audio out of the stream.
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* noop */
        }
      });
      setError(
        'No audio was shared. In the picker, choose a Tab or Entire Screen, then tick "Share tab audio" or "Share system audio".'
      );
      return false;
    }

    // Drop the video track — we don't need it. This frees screen
    // capture resources and removes the blue "sharing" border around
    // the captured surface in some browsers.
    stream.getVideoTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* noop */
      }
    });

    // The browser shows a persistent "Stop sharing" indicator. When the
    // user clicks it, the audio track fires 'ended'. Auto-stop so the
    // UI flips back to the idle state without the user having to click
    // our Stop button too.
    const handleEnded = () => {
      Promise.resolve().then(() => stop());
    };
    onTrackEndedRef.current = handleEnded;
    audioTracks.forEach((t) => t.addEventListener("ended", handleEnded));

    streamRef.current = stream;

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        throw new Error("AudioContext is not available in this browser");
      }

      // Prefer a 16 kHz AudioContext so the browser does the
      // anti-aliased resampling itself and the worklet only has to
      // convert float32 → int16 LE.
      let audioCtx;
      try {
        audioCtx = new AudioCtx({ sampleRate: TARGET_SAMPLE_RATE });
      } catch {
        audioCtx = new AudioCtx();
      }
      audioCtxRef.current = audioCtx;
      if (audioCtx.state === "suspended") {
        try {
          await audioCtx.resume();
        } catch {
          /* noop */
        }
      }
      // eslint-disable-next-line no-console
      console.info(
        `[sysaudio] AudioContext sampleRate=${audioCtx.sampleRate} (target=${TARGET_SAMPLE_RATE})`
      );

      await audioCtx.audioWorklet.addModule("/pcm-worklet.js");

      const source = audioCtx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const worklet = new AudioWorkletNode(audioCtx, "pcm-downsampler", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE },
      });
      workletRef.current = worklet;

      sentChunksRef.current = 0;

      worklet.port.onmessage = (event) => {
        const cb = onAudioRef.current;
        const data = event.data;
        if (data && data.type === "init") {
          // eslint-disable-next-line no-console
          console.info("[sysaudio] worklet init:", data);
          return;
        }
        if (cb && data instanceof ArrayBuffer) {
          cb(data); // Int16 little-endian PCM
          const n = ++sentChunksRef.current;
          if (n === 1 || n % 100 === 0) {
            // eslint-disable-next-line no-console
            console.info(`[sysaudio] sent ${n} audio chunks`);
          }
        }
      };

      source.connect(worklet);
      // Intentionally NOT connected to `audioCtx.destination` — we
      // don't want to re-play system audio out the speakers (it's
      // already playing through the system's own audio path).

      setActive(true);
      return true;
    } catch (e) {
      setError(e?.message || String(e));
      await stop();
      return false;
    }
  }, [stop]);

  // Always release on unmount.
  useEffect(() => {
    return () => {
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { active, error, start, stop };
}
