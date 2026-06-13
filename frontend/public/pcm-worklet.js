// AudioWorkletProcessor: takes the AudioContext's float32 mono input,
// (optionally) resamples to a target rate, converts each sample to
// 16-bit signed little-endian PCM, and posts the resulting ArrayBuffer
// back to the main thread.
//
// AssemblyAI Universal-Streaming expects exactly this format
// (encoding=pcm_s16le, mono, sample_rate=16000) on its WebSocket.
//
// Best case: the host page already created an AudioContext at 16 kHz,
// so the browser does the (high-quality, anti-aliased) resampling for
// us and this worklet just runs the float→int16 conversion. If the
// browser refuses 16 kHz, we fall back to a small block-average
// downsampler that's good enough for speech.

class PCMDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetSampleRate = opts.targetSampleRate || 16000;
    // `sampleRate` is a global in the AudioWorklet scope — the
    // AudioContext's actual sample rate.
    this.inputSampleRate = sampleRate;

    this.passthrough = this.inputSampleRate === this.targetSampleRate;
    this.ratio = this.inputSampleRate / this.targetSampleRate;

    // Target ~50 ms of audio per emitted chunk at the target rate.
    this.targetChunk = Math.max(1, Math.floor(this.targetSampleRate * 0.05));
    this.inputNeeded = this.passthrough
      ? this.targetChunk
      : Math.ceil(this.targetChunk * this.ratio);

    this.buffer = new Float32Array(0);

    this.port.postMessage({
      type: "init",
      inputSampleRate: this.inputSampleRate,
      targetSampleRate: this.targetSampleRate,
      passthrough: this.passthrough,
    });
  }

  _appendToBuffer(samples) {
    const merged = new Float32Array(this.buffer.length + samples.length);
    merged.set(this.buffer, 0);
    merged.set(samples, this.buffer.length);
    this.buffer = merged;
  }

  _emit(segment) {
    const out = new Int16Array(this.targetChunk);

    if (this.passthrough) {
      for (let i = 0; i < this.targetChunk; i++) {
        let s = segment[i];
        if (s < -1) s = -1;
        else if (s > 1) s = 1;
        out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
      }
    } else {
      // Block-average downsample. Each output sample is the mean of the
      // corresponding window of input samples — cheap low-pass that
      // avoids the obvious aliasing of plain sample-and-hold.
      for (let i = 0; i < this.targetChunk; i++) {
        const startF = i * this.ratio;
        const endF = (i + 1) * this.ratio;
        const start = Math.floor(startF);
        const end = Math.min(this.inputNeeded, Math.max(start + 1, Math.ceil(endF)));
        let sum = 0;
        let count = 0;
        for (let j = start; j < end; j++) {
          sum += segment[j];
          count++;
        }
        let s = count > 0 ? sum / count : 0;
        if (s < -1) s = -1;
        else if (s > 1) s = 1;
        out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
      }
    }

    this.port.postMessage(out.buffer, [out.buffer]);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) {
      return true;
    }
    const channel = input[0];
    this._appendToBuffer(channel);

    while (this.buffer.length >= this.inputNeeded) {
      const segment = this.buffer.subarray(0, this.inputNeeded);
      this._emit(segment);
      this.buffer = this.buffer.slice(this.inputNeeded);
    }

    return true;
  }
}

registerProcessor("pcm-downsampler", PCMDownsampler);
