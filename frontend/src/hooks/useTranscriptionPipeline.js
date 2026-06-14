import { useCallback, useEffect, useRef } from "react";
import { useTranscriptSocket } from "./useTranscriptSocket.js";

// Same Hindi chunking parameters as the prior single-pipeline App. They
// live here now so each pipeline instance uses identical timing and
// silence-gating, and the values are easy to tune in one place.
const HINDI_CHUNK_MS = 4000;
const HINDI_MIN_BYTES = 16000 * 2 * 0.3;
const HINDI_SILENCE_RMS = (() => {
  // eslint-disable-next-line no-undef
  const raw = import.meta.env.VITE_HINDI_SILENCE_RMS;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0.01;
})();

function computePcm16Rms(arrayBuffer) {
  const view = new Int16Array(arrayBuffer);
  if (view.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < view.length; i++) {
    const v = view[i] / 32768;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / view.length);
}

/**
 * One transcription pipeline = one WebSocket + its own AAI session
 * (English) or its own Hindi-chunk buffer (Hindi). The two-column UI
 * runs ONE of these per source — system audio gets one instance,
 * microphone gets another — so transcripts arrive tagged with the
 * source they were spoken into.
 *
 * The backend doesn't need any source-awareness: each pipeline opens
 * its own WS and the server treats them as independent clients.
 *
 * Args:
 *   wsUrl    : where the backend lives (same for every pipeline)
 *   language : "en" | "hi"
 *   active   : controls whether the periodic Hindi flush timer runs.
 *              Pass the source's "is currently capturing" flag.
 *   sourceTag: short string used in log lines / chunk ids so two
 *              concurrent pipelines are distinguishable in the
 *              browser console.
 *
 * Returns the standard useTranscriptSocket surface plus
 *   sendAudio(buffer)  — language-aware: PCM streams to AAI in
 *                        English mode, gets buffered for Whisper in
 *                        Hindi mode. The host calls this from its
 *                        audio capture's onAudio callback.
 *   resetBuffer()      — drops any queued Hindi tail. Useful when
 *                        the host stops a session abruptly.
 */
export function useTranscriptionPipeline({
  wsUrl,
  language,
  active,
  sourceTag,
}) {
  const socket = useTranscriptSocket(wsUrl);
  const bufferRef = useRef([]);
  const langRef = useRef(language);
  useEffect(() => {
    langRef.current = language;
  }, [language]);

  const flushHindiChunk = useCallback(() => {
    const chunks = bufferRef.current;
    if (chunks.length === 0) return;
    bufferRef.current = [];

    const totalBytes = chunks.reduce((s, c) => s + c.byteLength, 0);
    if (totalBytes < HINDI_MIN_BYTES) return;

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const c of chunks) {
      combined.set(new Uint8Array(c), offset);
      offset += c.byteLength;
    }

    // Voice-activity gate. Whisper hallucinates short Hindi or English
    // credit-tail words on near-silent audio; if RMS is below the
    // threshold we drop the chunk before spending a Groq request.
    const rms = computePcm16Rms(combined.buffer);
    if (rms < HINDI_SILENCE_RMS) {
      // eslint-disable-next-line no-console
      console.info(
        `[hindi:${sourceTag}] skipping silent chunk (rms=${rms.toFixed(4)} < ${HINDI_SILENCE_RMS})`
      );
      return;
    }

    const id = `${sourceTag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    socket.requestHindiChunk(id, combined.buffer);
  }, [socket, sourceTag]);

  const sendAudio = useCallback(
    (buffer) => {
      if (langRef.current === "hi") {
        bufferRef.current.push(buffer);
      } else {
        socket.sendAudio(buffer);
      }
    },
    [socket]
  );

  const resetBuffer = useCallback(() => {
    bufferRef.current = [];
  }, []);

  // Flush timer runs only while the source is capturing AND we're in
  // Hindi mode. Cleanup does a final flush so the tail of the
  // recording isn't lost.
  useEffect(() => {
    if (!(active && language === "hi")) return;
    const t = setInterval(flushHindiChunk, HINDI_CHUNK_MS);
    return () => {
      clearInterval(t);
      flushHindiChunk();
      bufferRef.current = [];
    };
  }, [active, language, flushHindiChunk]);

  // When language switches mid-life, drop any queued tail so we don't
  // ship Hindi-mode chunks with English-mode-buffered audio.
  useEffect(() => {
    bufferRef.current = [];
  }, [language]);

  return {
    ...socket,
    sendAudio,
    resetBuffer,
    chunkIntervalMs: HINDI_CHUNK_MS,
  };
}
