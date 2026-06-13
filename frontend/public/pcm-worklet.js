// AudioWorkletProcessor that takes the AudioContext's float32 mono input,
// resamples it to a target sample rate (default 16 kHz), converts each
// sample to 16-bit signed little-endian PCM, and posts the resulting
// ArrayBuffer back to the main thread.
//
// AssemblyAI Universal-Streaming expects exactly this format
// (encoding=pcm_s16le, mono, sample_rate=16000) on its WebSocket.

class PCMDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetSampleRate = opts.targetSampleRate || 16000;
    // `sampleRate` is a global in the AudioWorklet scope — it's the
    // AudioContext's sample rate (commonly 44100 or 48000).
    this.inputSampleRate = sampleRate;
    this.ratio = this.inputSampleRate / this.targetSampleRate;
    // ~50 ms of audio per emitted chunk at the target rate.
    this.targetChunk = Math.floor(this.targetSampleRate * 0.05);
    this.inputNeeded = Math.ceil(this.targetChunk * this.ratio);
    this.buffer = new Float32Array(0);
  }

  // Append `samples` to `this.buffer` without unbounded growth.
  _appendToBuffer(samples) {
    const merged = new Float32Array(this.buffer.length + samples.length);
    merged.set(this.buffer, 0);
    merged.set(samples, this.buffer.length);
    this.buffer = merged;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) {
      return true;
    }
    const channel = input[0]; // mono (first channel)
    this._appendToBuffer(channel);

    while (this.buffer.length >= this.inputNeeded) {
      const segment = this.buffer.subarray(0, this.inputNeeded);
      const out = new Int16Array(this.targetChunk);

      // Linear sample-and-hold downsample. Good enough for STT at 16 kHz;
      // proper anti-alias filtering would be overkill for speech here.
      for (let i = 0; i < this.targetChunk; i++) {
        const idx = Math.min(
          this.inputNeeded - 1,
          Math.floor(i * this.ratio)
        );
        let s = segment[idx];
        if (s < -1) s = -1;
        else if (s > 1) s = 1;
        out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
      }

      this.port.postMessage(out.buffer, [out.buffer]);

      // Drop the consumed prefix.
      this.buffer = this.buffer.slice(this.inputNeeded);
    }

    return true;
  }
}

registerProcessor("pcm-downsampler", PCMDownsampler);
