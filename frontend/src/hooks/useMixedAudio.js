import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useMixedAudio
 * -------------
 * Manages two completely independent audio capture pipelines:
 *
 *   System audio  – getDisplayMedia() screen-share track
 *                   → its own AudioWorklet → onSystemAudio(ArrayBuffer)
 *
 *   Microphone    – getUserMedia() mic track
 *                   → its own AudioWorklet → onMicAudio(ArrayBuffer)
 *
 * No master gain, no mixing, no summing. Each source is processed and
 * delivered independently so callers can route them to separate
 * WebSocket connections / AAI sessions.
 *
 * API
 * ---
 *   systemActive  bool    screen-share is live
 *   micActive     bool    mic is live
 *   error         string|null
 *   micDevices    MediaDeviceInfo[]
 *   micDeviceId   string
 *   setMicDeviceId(id)
 *   startSystem() → Promise<bool>
 *   stopSystem()  → Promise<void>
 *   enableMic(deviceId?) → Promise<bool>
 *   disableMic()  → Promise<void>
 *
 * @param {(buf: ArrayBuffer) => void} onSystemAudio
 * @param {(buf: ArrayBuffer) => void} onMicAudio
 */

const SAMPLE_RATE = 16000;
const CHUNK_FRAMES = 4096; // ~256 ms at 16 kHz

/** Inline AudioWorklet processor source (data URI). */
const WORKLET_SRC = /* js */ `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._frames = 0;
    this._chunk = ${CHUNK_FRAMES};
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    this._buf.push(new Float32Array(ch));
    this._frames += ch.length;
    if (this._frames >= this._chunk) {
      const out = new Int16Array(this._frames);
      let offset = 0;
      for (const f of this._buf) {
        for (let i = 0; i < f.length; i++) {
          out[offset++] = Math.max(-32768, Math.min(32767, f[i] * 32768));
        }
      }
      this.port.postMessage(out.buffer, [out.buffer]);
      this._buf = [];
      this._frames = 0;
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
`;

const WORKLET_URL = URL.createObjectURL(
  new Blob([WORKLET_SRC], { type: "application/javascript" })
);

/** Build an AudioContext + worklet node for one MediaStream. */
async function buildPipeline(stream, onChunk) {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await ctx.audioWorklet.addModule(WORKLET_URL);
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm-capture");
  node.port.onmessage = (e) => onChunk(e.data);
  src.connect(node);
  // Do NOT connect node to ctx.destination — we don't want to hear it.
  return { ctx, src, node };
}

/** Tear down a pipeline built by buildPipeline. */
async function teardownPipeline(pipeline) {
  if (!pipeline) return;
  const { ctx, src, node } = pipeline;
  try { src.disconnect(); } catch { /* noop */ }
  try { node.disconnect(); } catch { /* noop */ }
  try { await ctx.close(); } catch { /* noop */ }
}

export function useMixedAudio(onSystemAudio, onMicAudio) {
  const [systemActive, setSystemActive] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const [error, setError] = useState(null);
  const [micDevices, setMicDevices] = useState([]);
  const [micDeviceId, setMicDeviceId] = useState("");

  // Stable refs for callbacks so pipelines never need to be rebuilt
  // just because the parent re-renders with a new function identity.
  const onSystemAudioRef = useRef(onSystemAudio);
  const onMicAudioRef = useRef(onMicAudio);
  useEffect(() => { onSystemAudioRef.current = onSystemAudio; }, [onSystemAudio]);
  useEffect(() => { onMicAudioRef.current = onMicAudio; }, [onMicAudio]);

  // Live pipeline refs — never stored in state to avoid React re-renders
  // on every audio chunk.
  const sysPipelineRef = useRef(null);  // { ctx, src, node, stream }
  const micPipelineRef = useRef(null);

  // ── device enumeration ─────────────────────────────────────────────────

  const refreshDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMicDevices(devices.filter((d) => d.kind === "audioinput"));
    } catch {
      /* permission not yet granted — list stays empty */
    }
  }, []);

  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
    return () =>
      navigator.mediaDevices.removeEventListener("devicechange", refreshDevices);
  }, [refreshDevices]);

  // ── system audio ───────────────────────────────────────────────────────

  const startSystem = useCallback(async () => {
    setError(null);
    if (sysPipelineRef.current) return true; // already running

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true, // required by browsers even though we discard it
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          sampleRate: SAMPLE_RATE,
          channelCount: 1,
        },
      });
    } catch (e) {
      setError(`Screen share denied: ${e.message}`);
      return false;
    }

    // User may cancel the share picker without choosing audio — bail out.
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      setError(
        "No audio track in the share. Make sure you tick" + "Share tab audio" + " or " + "Share system audio" + "."
      );
      return false;
    }

    // When the user clicks the browser's built-in "Stop sharing" button
    // we clean up gracefully.
    audioTracks[0].addEventListener("ended", () => {
      stopSystem();
    });

    let pipeline;
    try {
      pipeline = await buildPipeline(stream, (buf) =>
        onSystemAudioRef.current?.(buf)
      );
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      setError(`Audio pipeline error: ${e.message}`);
      return false;
    }

    sysPipelineRef.current = { ...pipeline, stream };
    setSystemActive(true);
    return true;
  }, []);

  const stopSystem = useCallback(async () => {
    const pipeline = sysPipelineRef.current;
    sysPipelineRef.current = null;
    if (!pipeline) return;

    pipeline.stream?.getTracks().forEach((t) => t.stop());
    await teardownPipeline(pipeline);
    setSystemActive(false);
  }, []);

  // ── microphone ─────────────────────────────────────────────────────────

  const enableMic = useCallback(async (deviceId) => {
    setError(null);
    if (micPipelineRef.current) return true; // already running

    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: SAMPLE_RATE,
        channelCount: 1,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      setError(`Microphone access denied: ${e.message}`);
      return false;
    }

    // Refresh the device list now that we have permission.
    await refreshDevices();

    let pipeline;
    try {
      pipeline = await buildPipeline(stream, (buf) =>
        onMicAudioRef.current?.(buf)
      );
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      setError(`Mic audio pipeline error: ${e.message}`);
      return false;
    }

    micPipelineRef.current = { ...pipeline, stream };
    setMicActive(true);
    return true;
  }, [refreshDevices]);

  const disableMic = useCallback(async () => {
    const pipeline = micPipelineRef.current;
    micPipelineRef.current = null;
    if (!pipeline) return;

    pipeline.stream?.getTracks().forEach((t) => t.stop());
    await teardownPipeline(pipeline);
    setMicActive(false);
  }, []);

  // ── cleanup on unmount ─────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      // Fire-and-forget teardown — component is unmounting.
      const sys = sysPipelineRef.current;
      const mic = micPipelineRef.current;
      sysPipelineRef.current = null;
      micPipelineRef.current = null;
      if (sys) {
        sys.stream?.getTracks().forEach((t) => t.stop());
        teardownPipeline(sys);
      }
      if (mic) {
        mic.stream?.getTracks().forEach((t) => t.stop());
        teardownPipeline(mic);
      }
    };
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
  };
}