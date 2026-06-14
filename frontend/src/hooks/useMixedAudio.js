import { useCallback, useEffect, useRef, useState } from "react";

const TARGET_SAMPLE_RATE = 16000;

// Per-source gains. We keep some headroom so that mic + system summed
// together don't clip at the worklet input. With a single source
// active the gain is bumped to 1.0 so the existing English / Hindi
// pipelines see audio at the same level they did before this hook
// was introduced.
const GAIN_SINGLE = 1.0;
const GAIN_MIXED = 0.5;

/**
 * Captures **system audio** via getDisplayMedia (always required) plus
 * an **optional microphone** stream via getUserMedia, mixes them in a
 * single AudioContext, downsamples to 16 kHz mono PCM16 via the
 * existing pcm-worklet, and emits each chunk to `onAudio` as an
 * ArrayBuffer.
 *
 * Why one context + one worklet instead of two parallel hooks:
 * mic and system have to feed the SAME PCM stream so the backend can
 * run a single STT session over the combined audio. Two AudioContexts
 * can't share nodes, so we mix in-browser via a master GainNode.
 *
 * Audio graph:
 *
 *     getDisplayMedia ──► sysGain ─┐
 *                                  ├─► masterGain ─► pcm-worklet ─► onAudio
 *     getUserMedia    ──► micGain ─┘
 *
 * The mic side is built and torn down on `enableMic()` /
 * `disableMic()` so the user can flip it on and off without losing
 * the system audio capture or its AAI / Whisper pipeline.
 *
 * Returns:
 *   systemActive   : boolean — getDisplayMedia is currently running
 *   micActive      : boolean — getUserMedia is currently running
 *   error          : string | null
 *
 *   micDevices     : MediaDeviceInfo[] — available audio inputs
 *   micDeviceId    : string — currently-selected device id ("" = default)
 *   setMicDeviceId : (id: string) => void — switches device; if mic is
 *                    on, restarts it on the new device
 *
 *   startSystem()  : Promise<boolean> — opens the share-tab picker and
 *                    starts the mixed pipeline. False on cancel/error.
 *   stopSystem()   : Promise<void> — tears the whole graph down (mic
 *                    too).
 *   enableMic(id?) : Promise<boolean> — adds the mic to the existing
 *                    mix. Requires startSystem() to have succeeded.
 *   disableMic()   : Promise<void> — removes the mic from the mix.
 *
 * Browser support: Chrome / Edge desktop. Other browsers that support
 * getDisplayMedia + getUserMedia + AudioWorklet will work; the spec
 * for this app's UI specifically targets Chromium.
 */
export function useMixedAudio(onAudio) {
  const [systemActive, setSystemActive] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const [error, setError] = useState(null);
  const [micDevices, setMicDevices] = useState([]);
  const [micDeviceId, setMicDeviceIdState] = useState("");

  // Stable ref so the worklet's onmessage doesn't capture a stale
  // callback after re-renders.
  const onAudioRef = useRef(onAudio);
  useEffect(() => {
    onAudioRef.current = onAudio;
  }, [onAudio]);

  // Audio plumbing
  const audioCtxRef = useRef(null);
  const masterGainRef = useRef(null);
  const workletRef = useRef(null);

  // System audio side
  const sysStreamRef = useRef(null);
  const sysSourceRef = useRef(null);
  const sysGainRef = useRef(null);
  const sysOnEndedRef = useRef(null);

  // Mic side
  const micStreamRef = useRef(null);
  const micSourceRef = useRef(null);
  const micGainRef = useRef(null);

  const sentChunksRef = useRef(0);

  // ---- mic device enumeration --------------------------------------------

  const refreshMicDevices = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === "audioinput");
      setMicDevices(inputs);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[mixed] enumerateDevices failed:", e);
    }
  }, []);

  useEffect(() => {
    refreshMicDevices();
    if (navigator.mediaDevices?.addEventListener) {
      const handler = () => refreshMicDevices();
      navigator.mediaDevices.addEventListener("devicechange", handler);
      return () =>
        navigator.mediaDevices.removeEventListener("devicechange", handler);
    }
    return undefined;
  }, [refreshMicDevices]);

  // ---- internal gain rebalancing -----------------------------------------
  // When mic is added/removed we adjust per-source gains so the worklet
  // input stays roughly inside [-1, 1] regardless of how many sources
  // are live. Using setValueAtTime so changes don't click.

  const _rebalanceGains = useCallback((micOn) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    const t = ctx.currentTime;
    const sysG = micOn ? GAIN_MIXED : GAIN_SINGLE;
    const micG = GAIN_MIXED;
    if (sysGainRef.current) {
      sysGainRef.current.gain.setValueAtTime(sysG, t);
    }
    if (micGainRef.current) {
      micGainRef.current.gain.setValueAtTime(micG, t);
    }
  }, []);

  // ---- mic enable / disable ---------------------------------------------

  const _disableMicInternal = useCallback(async () => {
    if (micSourceRef.current) {
      try {
        micSourceRef.current.disconnect();
      } catch {
        /* noop */
      }
      micSourceRef.current = null;
    }
    if (micGainRef.current) {
      try {
        micGainRef.current.disconnect();
      } catch {
        /* noop */
      }
      micGainRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* noop */
        }
      });
      micStreamRef.current = null;
    }
    setMicActive(false);
    _rebalanceGains(false);
  }, [_rebalanceGains]);

  const enableMic = useCallback(
    async (deviceId) => {
      setError(null);
      const audioCtx = audioCtxRef.current;
      const masterGain = masterGainRef.current;
      if (!audioCtx || !masterGain) {
        setError(
          "Cannot enable microphone: translation isn't running. Click Start Translation first."
        );
        return false;
      }
      if (micSourceRef.current) {
        // Already on — caller may be requesting a device switch via
        // setMicDeviceId; that path handles its own teardown.
        return true;
      }

      let stream;
      try {
        const audioConstraints = {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        };
        if (deviceId) {
          audioConstraints.deviceId = { exact: deviceId };
        }
        stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: false,
        });
      } catch (e) {
        // User denied permission, device unavailable, etc.
        const name = e?.name || "";
        if (name === "NotAllowedError") {
          setError(
            "Microphone permission denied. Allow mic access for this site and try again."
          );
        } else {
          setError(`Microphone error: ${e?.message || String(e)}`);
        }
        return false;
      }

      try {
        const micGain = audioCtx.createGain();
        micGain.gain.value = GAIN_MIXED;
        const micSource = audioCtx.createMediaStreamSource(stream);
        micSource.connect(micGain).connect(masterGain);

        micGainRef.current = micGain;
        micSourceRef.current = micSource;
        micStreamRef.current = stream;

        // eslint-disable-next-line no-console
        console.info("[mixed] mic enabled");
        setMicActive(true);
        _rebalanceGains(true);
        // Re-enumerate now that the user has granted permission — the
        // browser exposes real device labels only after at least one
        // grant.
        refreshMicDevices();
        return true;
      } catch (e) {
        stream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            /* noop */
          }
        });
        setError(e?.message || String(e));
        return false;
      }
    },
    [_rebalanceGains, refreshMicDevices]
  );

  const disableMic = useCallback(async () => {
    await _disableMicInternal();
    // eslint-disable-next-line no-console
    console.info("[mixed] mic disabled");
  }, [_disableMicInternal]);

  // setMicDeviceId — if mic is currently on, restart it on the new device.
  const setMicDeviceId = useCallback(
    (id) => {
      const newId = id || "";
      setMicDeviceIdState(newId);
      if (micSourceRef.current) {
        // Restart on the new device. Fire-and-forget; errors flow into
        // `error` state via enableMic().
        (async () => {
          await _disableMicInternal();
          await enableMic(newId || undefined);
        })();
      }
    },
    [_disableMicInternal, enableMic]
  );

  // ---- system audio start / stop ----------------------------------------

  const stopSystem = useCallback(async () => {
    // Mic first so it doesn't try to reach a torn-down master.
    await _disableMicInternal();

    if (sysStreamRef.current && sysOnEndedRef.current) {
      const handler = sysOnEndedRef.current;
      sysStreamRef.current.getTracks().forEach((t) => {
        try {
          t.removeEventListener("ended", handler);
        } catch {
          /* noop */
        }
      });
      sysOnEndedRef.current = null;
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
    if (sysSourceRef.current) {
      try {
        sysSourceRef.current.disconnect();
      } catch {
        /* noop */
      }
      sysSourceRef.current = null;
    }
    if (sysGainRef.current) {
      try {
        sysGainRef.current.disconnect();
      } catch {
        /* noop */
      }
      sysGainRef.current = null;
    }
    if (masterGainRef.current) {
      try {
        masterGainRef.current.disconnect();
      } catch {
        /* noop */
      }
      masterGainRef.current = null;
    }
    if (sysStreamRef.current) {
      sysStreamRef.current.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* noop */
        }
      });
      sysStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      try {
        await audioCtxRef.current.close();
      } catch {
        /* noop */
      }
      audioCtxRef.current = null;
    }
    setSystemActive(false);
  }, [_disableMicInternal]);

  const startSystem = useCallback(async () => {
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
        // Required by spec; the video track is dropped immediately.
        video: true,
        audio: {
          // Don't apply browser DSP to system audio — the source
          // (YouTube, Meet, etc.) is already clean.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (e) {
      if (e?.name === "NotAllowedError") {
        // User cancelled the share picker — silent no-op.
        return false;
      }
      setError(e?.message || String(e));
      return false;
    }

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
        'No audio was shared. In the picker, choose a Tab or Entire Screen, then tick "Share tab audio" / "Share system audio".'
      );
      return false;
    }

    // Drop the video track — we only want audio.
    stream.getVideoTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* noop */
      }
    });

    // Auto-stop when the user clicks the browser's "Stop sharing"
    // banner (or the source tab is closed).
    const handleEnded = () => {
      Promise.resolve().then(() => stopSystem());
    };
    sysOnEndedRef.current = handleEnded;
    audioTracks.forEach((t) => t.addEventListener("ended", handleEnded));

    sysStreamRef.current = stream;

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        throw new Error("AudioContext is not available in this browser");
      }
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

      await audioCtx.audioWorklet.addModule("/pcm-worklet.js");

      const masterGain = audioCtx.createGain();
      masterGain.gain.value = 1.0;
      masterGainRef.current = masterGain;

      const sysGain = audioCtx.createGain();
      sysGain.gain.value = GAIN_SINGLE; // bumped down later when mic joins
      sysGainRef.current = sysGain;

      const sysSource = audioCtx.createMediaStreamSource(stream);
      sysSourceRef.current = sysSource;
      sysSource.connect(sysGain).connect(masterGain);

      const worklet = new AudioWorkletNode(audioCtx, "pcm-downsampler", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE },
      });
      workletRef.current = worklet;
      masterGain.connect(worklet);

      sentChunksRef.current = 0;
      worklet.port.onmessage = (event) => {
        const cb = onAudioRef.current;
        const data = event.data;
        if (data && data.type === "init") {
          // eslint-disable-next-line no-console
          console.info("[mixed] worklet init:", data);
          return;
        }
        if (cb && data instanceof ArrayBuffer) {
          cb(data); // mixed PCM16 little-endian
          const n = ++sentChunksRef.current;
          if (n === 1 || n % 100 === 0) {
            // eslint-disable-next-line no-console
            console.info(`[mixed] sent ${n} mixed audio chunks`);
          }
        }
      };

      // Intentionally NOT connecting masterGain to audioCtx.destination —
      // we don't want to play the captured audio back through speakers.

      // eslint-disable-next-line no-console
      console.info(
        `[mixed] system audio capturing; sampleRate=${audioCtx.sampleRate}`
      );

      setSystemActive(true);
      // Now that there's any media permission active, browser may
      // populate device labels.
      refreshMicDevices();
      return true;
    } catch (e) {
      setError(e?.message || String(e));
      await stopSystem();
      return false;
    }
  }, [stopSystem, refreshMicDevices]);

  // Always release on unmount.
  useEffect(() => {
    return () => {
      stopSystem();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    systemActive,
    micActive,
    error,
    micDevices,
    micDeviceId,
    setMicDeviceId,
    startSystem,
    stopSystem,
    enableMic,
    disableMic,
    refreshMicDevices,
  };
}
