"""
Hindi speech-to-text via Groq's Whisper API.

This module is **only** invoked for Hindi + System Audio mode, where
the browser captures audio via `getDisplayMedia` (e.g. a YouTube tab,
a Google Meet call) and the browser's Web Speech API can't be used —
it only listens to the microphone, not arbitrary streams.

Pipeline for that mode:

    Browser:  getDisplayMedia → AudioWorklet → PCM16 16 kHz mono
              → buffer ~4 s of audio
              → WS: {"type":"hindi_chunk","id":"…"} + binary PCM bytes
                                                  │
                                                  ▼
    Backend:  WhisperSTT.transcribe(WAV-wrapped PCM, language="hi")
              → Hindi text
              → Translator.translate(Hindi text)  (existing module)
              → English text
                                                  │
                                                  ▼
    Browser:  {"type":"transcript","final":true,"id":"…","text":"<hindi>"}
              {"type":"translation","id":"…","text":"<english>"}

The class API mirrors `translator.Translator` so callers can treat
both as "Groq-backed Hindi helpers": construct, check `.enabled`,
await an async method, branch on `text`/`error` of the returned
dataclass.

Environment variables
---------------------
    GROQ_API_KEY      same key already used by the translator;
                      get a free key at https://console.groq.com/keys
    WHISPER_MODEL     optional, defaults to "whisper-large-v3"
                      (multilingual; supports Hindi well; free tier).
                      For lower latency at slightly lower accuracy:
                      "whisper-large-v3-turbo".
"""

from __future__ import annotations

import logging
import os
import struct
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger("stt")

WHISPER_DEFAULT_MODEL = "whisper-large-v3"
WHISPER_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions"


@dataclass(frozen=True)
class TranscriptionResult:
    """
    Outcome of a transcribe call. Callers should check fields in order:
        - if `text`     : success — show the transcript
        - elif `error`  : real API failure — surface to the user
        - else          : nothing to transcribe (empty audio or disabled)
    """

    text: Optional[str] = None
    error: Optional[str] = None
    # HTTP status code (when the failure was an HTTP response).
    error_code: Optional[int] = None


def _http_status_message(status: int) -> str:
    """Map common Groq Whisper failure codes to friendly messages."""
    if status == 429:
        return (
            "Groq rate limit reached. Free tier allows ~30 requests per "
            "minute and 14,400 per day across the account; wait a moment "
            "and try again, or pick a different WHISPER_MODEL."
        )
    if status in (401, 403):
        return (
            "Groq API key was rejected. Check GROQ_API_KEY in backend/.env "
            "(get a free key at https://console.groq.com/keys)."
        )
    if status == 400:
        return (
            "Groq Whisper rejected the audio chunk as malformed (HTTP 400). "
            "This usually means the audio was too short or in the wrong format."
        )
    if status == 404:
        return (
            "Groq Whisper model not found. Check WHISPER_MODEL — defaults "
            "to whisper-large-v3."
        )
    if status == 413:
        return (
            "Audio chunk is too large for Groq Whisper (HTTP 413). Lower "
            "the chunk size on the frontend."
        )
    if status >= 500:
        return f"Groq is temporarily unavailable (HTTP {status}). Try again."
    return f"Groq Whisper error: HTTP {status}."


def pcm16_to_wav_bytes(
    pcm: bytes, sample_rate: int = 16000, num_channels: int = 1
) -> bytes:
    """
    Wrap raw 16-bit signed little-endian PCM in a minimal WAV (RIFF)
    container so Whisper's audio decoder can read it.

    The PCM the browser sends comes from our existing `pcm-worklet.js`
    pipeline (16 kHz mono int16 LE), so the defaults match by design.
    """
    bits_per_sample = 16
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    data_size = len(pcm)

    header = b"".join(
        [
            b"RIFF",
            struct.pack("<I", 36 + data_size),
            b"WAVE",
            b"fmt ",
            struct.pack("<I", 16),  # fmt chunk size
            struct.pack("<H", 1),  # PCM format
            struct.pack("<H", num_channels),
            struct.pack("<I", sample_rate),
            struct.pack("<I", byte_rate),
            struct.pack("<H", block_align),
            struct.pack("<H", bits_per_sample),
            b"data",
            struct.pack("<I", data_size),
        ]
    )
    return header + pcm


class WhisperSTT:
    """
    Thin async wrapper around Groq's `/openai/v1/audio/transcriptions`.

    Construct once per session (or once per process — it's stateless).
    Always check `if stt.enabled:` before scheduling work.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        timeout_seconds: float = 30.0,
    ) -> None:
        self.api_key = (api_key or os.getenv("GROQ_API_KEY", "")).strip()
        self.model = (
            (model or os.getenv("WHISPER_MODEL", "")).strip() or WHISPER_DEFAULT_MODEL
        )
        # Whisper requests can be slower than chat completions on very
        # busy minutes, so give them more breathing room.
        self.timeout_seconds = timeout_seconds
        self._enabled = bool(self.api_key)

        try:
            import httpx  # type: ignore

            self._httpx = httpx
        except ImportError:
            if self._enabled:
                logger.warning(
                    "GROQ_API_KEY is set but `httpx` is not installed — "
                    "Whisper STT disabled. Run `pip install httpx`."
                )
            self._httpx = None
            self._enabled = False

        if self._enabled:
            logger.info("whisper STT enabled (model=%s)", self.model)
        else:
            logger.info(
                "whisper STT disabled (set GROQ_API_KEY to enable Hindi system-audio mode)"
            )

    @property
    def enabled(self) -> bool:
        return self._enabled

    async def transcribe(
        self,
        pcm_bytes: bytes,
        language: str = "hi",
        sample_rate: int = 16000,
    ) -> TranscriptionResult:
        """
        Transcribe one chunk of audio.

        `pcm_bytes` is raw 16-bit signed little-endian PCM at
        `sample_rate` Hz mono. We wrap it in a WAV header before
        uploading because Whisper's decoder needs a container format.

        Never raises. Returns a `TranscriptionResult`:
        - `.text`   set on success.
        - `.error`  set when the API call itself failed (rate limit,
          auth, network). Caller should surface to the user.
        - both unset when the input was empty / disabled (silent no-op).
        """
        if not self._enabled:
            return TranscriptionResult()
        if not pcm_bytes:
            return TranscriptionResult()
        # Whisper struggles with very short clips; <0.3 s is rarely
        # useful and just wastes a request.
        min_bytes = int(sample_rate * 2 * 0.3)
        if len(pcm_bytes) < min_bytes:
            return TranscriptionResult()

        wav_bytes = pcm16_to_wav_bytes(pcm_bytes, sample_rate=sample_rate)

        files = {"file": ("audio.wav", wav_bytes, "audio/wav")}
        data = {
            "model": self.model,
            # Hint the language so Whisper doesn't waste time on
            # auto-detection and doesn't accidentally guess wrong on
            # short / ambient clips.
            "language": language,
            "response_format": "json",
            # Slightly higher temperature than 0 helps Whisper avoid
            # repetitive hallucinations on near-silent chunks. Groq's
            # default is fine; we keep it explicit.
            "temperature": "0",
        }

        try:
            assert self._httpx is not None  # gated by _enabled
            async with self._httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                resp = await client.post(
                    WHISPER_ENDPOINT,
                    files=files,
                    data=data,
                    headers={"Authorization": f"Bearer {self.api_key}"},
                )
            if resp.status_code != 200:
                msg = _http_status_message(resp.status_code)
                logger.warning(
                    "Groq Whisper returned HTTP %s: %s", resp.status_code, msg
                )
                return TranscriptionResult(error=msg, error_code=resp.status_code)
            payload = resp.json()
        except Exception as e:  # noqa: BLE001
            logger.warning("whisper request failed: %s", e)
            return TranscriptionResult(error=f"Groq Whisper request failed: {e}")

        text = (payload.get("text") or "").strip() if isinstance(payload, dict) else ""
        if not text:
            return TranscriptionResult()
        return TranscriptionResult(text=text)
