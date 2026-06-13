"""
Hindi → English translator backed by Google's Gemini API.

This module is **only** invoked when the client explicitly asks for a
translation via the `{type:"translate"}` WebSocket control message
(used by Hindi mode, where the browser does the speech-to-text itself
because AssemblyAI's streaming model doesn't yet support Hindi).

It is deliberately **not** wired into the AssemblyAI final-transcript
path: AAI already returns clean English for English audio, so calling
Gemini there is pure waste of your free-tier quota. Each API does its
job:

    AssemblyAI key  →  English speech → English text
    Gemini key      →  Hindi text     → English text

If `GEMINI_API_KEY` is not set, or `httpx` is not installed, the
translator is a no-op (`enabled == False`) and the standalone translate
control message is rejected with a clear error.

Environment variables
---------------------
    GEMINI_API_KEY   required to enable translations
                     get a free key: https://aistudio.google.com/app/apikey
    GEMINI_MODEL     optional, defaults to "gemini-2.5-flash-lite"
                     (15 RPM / 1000 req-per-day on the free tier as of 2026)

Wire format
-----------
    request:  POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=...
              {"contents":[{"parts":[{"text": prompt}]}], "generationConfig":{...}}
    response: {"candidates":[{"content":{"parts":[{"text": "..."}]}}]}
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger("translator")

GEMINI_DEFAULT_MODEL = "gemini-2.5-flash-lite"
GEMINI_ENDPOINT_TEMPLATE = (
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
)

# Hindi-only translator. The defensive "English stays English" rule
# protects against any stray English text reaching this code path.
PROMPT_TEMPLATE = (
    "You are translating Hindi (Devanagari script or Romanized Hindi) "
    "to natural, fluent English for a live captioning app.\n"
    "\n"
    "Rules:\n"
    "- Translate the input into natural, fluent English.\n"
    "- If the input is already entirely in English, return it unchanged.\n"
    "- Preserve names, numbers, and proper nouns.\n"
    "- Output ONLY the translated text. No explanations, no quotes, no labels.\n"
    "\n"
    "Input:\n"
    "{text}"
)


@dataclass(frozen=True)
class TranslationResult:
    """
    Outcome of a translate call. Callers should check fields in order:
        - if `text`     : success — show the translation
        - elif `error`  : real API failure — surface to the user
        - else          : nothing to translate (empty input or disabled)
    """

    text: Optional[str] = None
    error: Optional[str] = None
    # HTTP status code (when the failure was an HTTP response).
    error_code: Optional[int] = None


def _http_status_message(status: int) -> str:
    """Map common Gemini failure codes to friendly user-facing messages."""
    if status == 429:
        return (
            "Gemini rate limit reached. The free tier allows about 15 requests "
            "per minute and 1000 per day; wait a moment or switch GEMINI_MODEL."
        )
    if status in (401, 403):
        return (
            "Gemini API key was rejected. Check GEMINI_API_KEY in backend/.env."
        )
    if status == 400:
        return "Gemini rejected the request as malformed (HTTP 400)."
    if status == 404:
        return (
            "Gemini model not found. Check GEMINI_MODEL — defaults to "
            "gemini-2.5-flash-lite."
        )
    if status >= 500:
        return f"Gemini is temporarily unavailable (HTTP {status}). Try again."
    return f"Gemini error: HTTP {status}."


class Translator:
    """
    Thin async wrapper around Gemini's `generateContent` REST endpoint.

    Construct once per session (or once per process — it's stateless).
    Always call `if translator.enabled:` before scheduling work; that way
    callers don't need to know how the translator is configured.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        timeout_seconds: float = 10.0,
    ) -> None:
        self.api_key = (api_key or os.getenv("GEMINI_API_KEY", "")).strip()
        self.model = (
            (model or os.getenv("GEMINI_MODEL", "")).strip() or GEMINI_DEFAULT_MODEL
        )
        self.timeout_seconds = timeout_seconds
        self._enabled = bool(self.api_key)

        # Lazy / optional import — keep the rest of the server runnable
        # even if the user hasn't installed httpx yet.
        try:
            import httpx  # type: ignore

            self._httpx = httpx
        except ImportError:
            if self._enabled:
                logger.warning(
                    "GEMINI_API_KEY is set but `httpx` is not installed — "
                    "translation disabled. Run `pip install httpx`."
                )
            self._httpx = None
            self._enabled = False

        if self._enabled:
            logger.info("translator enabled (model=%s)", self.model)
        else:
            logger.info("translator disabled (set GEMINI_API_KEY to enable)")

    @property
    def enabled(self) -> bool:
        return self._enabled

    async def translate(self, text: str) -> TranslationResult:
        """
        Translate `text` from Hindi to English.

        Never raises. Returns a `TranslationResult`:
        - `.text` set on success.
        - `.error` set when the API call itself failed (rate limit, auth,
          network, safety block). The caller is expected to surface this
          to the user.
        - both `.text` and `.error` left unset when the input was empty
          or the translator is disabled — callers can treat this as a
          silent no-op.
        """
        if not self._enabled:
            return TranslationResult()
        if not text:
            return TranslationResult()
        text = text.strip()
        if not text:
            return TranslationResult()

        url = GEMINI_ENDPOINT_TEMPLATE.format(model=self.model)
        prompt = PROMPT_TEMPLATE.format(text=text)
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.1,
                # Caption-sized outputs. Translations don't need long
                # generations, and capping this protects the rate limit.
                "maxOutputTokens": 256,
            },
        }

        try:
            assert self._httpx is not None  # gated by _enabled
            async with self._httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                resp = await client.post(
                    url,
                    json=payload,
                    params={"key": self.api_key},
                    headers={"Content-Type": "application/json"},
                )
            if resp.status_code != 200:
                # Don't log the full response body — it can contain the
                # API key in error envelopes from old proxies.
                msg = _http_status_message(resp.status_code)
                logger.warning(
                    "Gemini returned HTTP %s: %s", resp.status_code, msg
                )
                return TranslationResult(error=msg, error_code=resp.status_code)
            data = resp.json()
        except Exception as e:  # noqa: BLE001
            logger.warning("translation request failed: %s", e)
            return TranslationResult(error=f"Gemini request failed: {e}")

        candidates = data.get("candidates") or []
        if not candidates:
            # Common cause: the prompt was blocked by safety settings.
            feedback = data.get("promptFeedback")
            logger.warning("Gemini returned no candidates (promptFeedback=%s)", feedback)
            block_reason = (
                (feedback or {}).get("blockReason") if isinstance(feedback, dict) else None
            )
            return TranslationResult(
                error=(
                    f"Gemini blocked the request ({block_reason})"
                    if block_reason
                    else "Gemini returned no result."
                )
            )

        parts = ((candidates[0].get("content") or {}).get("parts")) or []
        for part in parts:
            translated = (part.get("text") or "").strip()
            if translated:
                return TranslationResult(text=translated)
        # Empty parts — treat like "no result".
        return TranslationResult(error="Gemini returned an empty translation.")
