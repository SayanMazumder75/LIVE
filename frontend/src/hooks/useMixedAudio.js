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
  // Recording-side state. The recorder taps the *existing* mic /
  // system MediaStreams (which the hook already owns) via a separate
  // AudioContext and MediaStreamDestination, so the live worklet
  // pipeline that feeds AssemblyAI / Whisper is completely unaffected
  // — no second permission prompt, no double processing.
  const [recordingActive, setRecordingActive] = useState(false);

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
  // Active recording session (set by startRecording, cleared by stopRecording).
  // Shape: { ctx, dest, recorder, chunks, mimeType, startedAt, sourceNodes[] }
  const recordingRef = useRef(null);

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

  // ── recording (full-session mix) ───────────────────────────────────────
  // Taps whatever streams are active when start is called and routes
  // them through a *separate* AudioContext + MediaStreamDestination
  // into a MediaRecorder. The transcription pipeline keeps running
  // unaffected because we read from the same MediaStreams without
  // disconnecting the existing nodes.
  //
  // Picks the highest-quality MediaRecorder mime type the browser
  // supports, in this order:
  //   1. audio/webm;codecs=opus  — Chrome/Edge/Firefox
  //   2. audio/webm              — older Chromium
  //   3. audio/mp4               — Safari (macOS 14.4+)
  //   4. ""                      — let the browser default
  function _pickAudioMime() {
    if (typeof MediaRecorder === "undefined") return "";
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4;codecs=mp4a",
      "audio/mp4",
    ];
    for (const m of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(m)) return m;
      } catch { /* ignore */ }
    }
    return "";
  }

  const startRecording = useCallback(async () => {
    setError(null);
    if (recordingRef.current) return true; // already recording

    const sources = [];
    if (sysPipelineRef.current?.stream) {
      sources.push({ kind: "system", stream: sysPipelineRef.current.stream });
    }
    if (micPipelineRef.current?.stream) {
      sources.push({ kind: "mic", stream: micPipelineRef.current.stream });
    }
    if (sources.length === 0) {
      // Nothing to record yet. Caller can retry once a stream
      // becomes active.
      return false;
    }

    if (typeof MediaRecorder === "undefined") {
      setError("MediaRecorder is not supported in this browser; recording disabled.");
      return false;
    }

    let ctx;
    try {
      // 48 kHz so the recorded file sounds clean even though the
      // transcription path runs at 16 kHz. The mic/system streams
      // can be safely tapped at any sample rate; the recorder
      // resamples internally.
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      ctx = new AudioCtx({ sampleRate: 48000 });
    } catch (e) {
      setError(`Could not create recording AudioContext: ${e.message}`);
      return false;
    }

    let dest;
    try {
      dest = ctx.createMediaStreamDestination();
    } catch (e) {
      try { await ctx.close(); } catch { /* ignore */ }
      setError(`Could not create recording destination: ${e.message}`);
      return false;
    }

    // Wire each active source into the destination via its own gain
    // node so we can fade or mute individually later if needed.
    const sourceNodes = [];
    for (const { kind, stream } of sources) {
      try {
        const src = ctx.createMediaStreamSource(stream);
        const gain = ctx.createGain();
        // Slight per-source gain trim. System audio tends to come in
        // hot from getDisplayMedia, so we knock it down a bit; mic
        // gets a tiny boost so the user's voice is audible against
        // the meeting audio.
        gain.gain.value = kind === "system" ? 0.85 : 1.1;
        src.connect(gain);
        gain.connect(dest);
        sourceNodes.push({ src, gain });
      } catch (e) {
        // Skip a stream that can't be tapped (already ended, etc.)
        // rather than aborting the whole recording.
        console.warn(`[recording] could not tap ${kind} stream:`, e);
      }
    }

    if (sourceNodes.length === 0) {
      try { await ctx.close(); } catch { /* ignore */ }
      setError("No usable audio sources for recording.");
      return false;
    }

    const mimeType = _pickAudioMime();
    let recorder;
    try {
      recorder = mimeType
        ? new MediaRecorder(dest.stream, { mimeType, audioBitsPerSecond: 96000 })
        : new MediaRecorder(dest.stream, { audioBitsPerSecond: 96000 });
    } catch (e) {
      try { await ctx.close(); } catch { /* ignore */ }
      setError(`MediaRecorder init failed: ${e.message}`);
      return false;
    }

    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = (ev) => {
      console.warn("[recording] MediaRecorder error:", ev?.error || ev);
    };

    // 1-second timeslices so even a hard-killed tab leaves us with
    // most of the audio in `chunks` rather than nothing.
    try {
      recorder.start(1000);
    } catch (e) {
      try { await ctx.close(); } catch { /* ignore */ }
      setError(`MediaRecorder start failed: ${e.message}`);
      return false;
    }

    recordingRef.current = {
      ctx,
      dest,
      recorder,
      chunks,
      mimeType: recorder.mimeType || mimeType || "audio/webm",
      startedAt: Date.now(),
      sourceNodes,
    };
    setRecordingActive(true);
    return true;
  }, []);

  const stopRecording = useCallback(() => {
    return new Promise((resolve) => {
      const rec = recordingRef.current;
      recordingRef.current = null;
      if (!rec) {
        setRecordingActive(false);
        resolve(null);
        return;
      }

      const finish = async () => {
        const { ctx, sourceNodes, chunks, mimeType, startedAt } = rec;
        for (const { src, gain } of sourceNodes) {
          try { src.disconnect(); } catch { /* ignore */ }
          try { gain.disconnect(); } catch { /* ignore */ }
        }
        try { await ctx.close(); } catch { /* ignore */ }
        const blob = new Blob(chunks, { type: mimeType });
        const durationSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
        setRecordingActive(false);
        resolve({
          blob,
          mimeType,
          duration: durationSec,
          size: blob.size,
        });
      };

      const { recorder } = rec;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = () => { finish(); };
        try { recorder.stop(); }
        catch (e) { console.warn("[recording] stop failed:", e); finish(); }
      } else {
        finish();
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      // Fire-and-forget teardown — component is unmounting.
      const sys = sysPipelineRef.current;
      const mic = micPipelineRef.current;
      const rec = recordingRef.current;
      sysPipelineRef.current = null;
      micPipelineRef.current = null;
      recordingRef.current = null;
      // Recording cleanup runs first so its source nodes are
      // disconnected before the underlying MediaStreams get torn down.
      if (rec) {
        try {
          if (rec.recorder && rec.recorder.state !== "inactive") {
            rec.recorder.stop();
          }
        } catch { /* noop */ }
        for (const { src, gain } of rec.sourceNodes || []) {
          try { src.disconnect(); } catch { /* noop */ }
          try { gain.disconnect(); } catch { /* noop */ }
        }
        try { rec.ctx?.close(); } catch { /* noop */ }
      }
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
    // Recording (mic + system mix → MediaRecorder → Blob).
    recordingActive,
    startRecording,
    stopRecording,
  };
}