"""
Hindi-aware translator backed by Google's Gemini API.

This module is intentionally **self-contained**. It does not touch the
transcription pipeline — `websocket_server.py` calls
`Translator.translate(text)` after a final transcript is forwarded, and
forwards the result to the browser as a separate `translation` message.

If `GEMINI_API_KEY` is not set, or `httpx` is not installed, the
translator is a no-op (`enabled == False`) and the rest of the app keeps
working exactly as before.

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
from typing import Optional

logger = logging.getLogger("translator")

GEMINI_DEFAULT_MODEL = "gemini-2.5-flash-lite"
GEMINI_ENDPOINT_TEMPLATE = (
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
)

# Kept short and explicit. The model is told to leave English alone so we
# don't end up with paraphrased English when the user wasn't speaking
# Hindi — the UI then suppresses identical translations entirely.
PROMPT_TEMPLATE = (
    "You are a Hindi-to-English translator for a live captioning app.\n"
    "\n"
    "Rules:\n"
    "- If the input is already entirely in English, return it unchanged.\n"
    "- If the input contains Hindi (Devanagari script or Romanized Hindi),\n"
    "  translate it into natural, fluent English.\n"
    "- Preserve names, numbers, and proper nouns.\n"
    "- Output ONLY the translated text. No explanations, no quotes, no labels.\n"
    "\n"
    "Input:\n"
    "{text}"
)


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

    async def translate(self, text: str) -> Optional[str]:
        """
        Translate `text` to English. Returns ``None`` if the translator is
        disabled, the input is empty, or the API call fails — never raises.
        """
        if not self._enabled or not text:
            return None
        text = text.strip()
        if not text:
            return None

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
            assert self._httpx is not None  # for type-checkers; gated by _enabled
            async with self._httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                resp = await client.post(
                    url,
                    json=payload,
                    params={"key": self.api_key},
                    headers={"Content-Type": "application/json"},
                )
            if resp.status_code != 200:
                # Don't log the full response by default — it may include
                # the API key in error envelopes from old proxies.
                logger.warning(
                    "Gemini returned HTTP %s for translation request",
                    resp.status_code,
                )
                return None
            data = resp.json()
        except Exception as e:  # noqa: BLE001
            logger.warning("translation request failed: %s", e)
            return None

        candidates = data.get("candidates") or []
        if not candidates:
            # Common cause: the prompt was blocked by safety settings.
            logger.warning(
                "Gemini returned no candidates (promptFeedback=%s)",
                data.get("promptFeedback"),
            )
            return None

        parts = ((candidates[0].get("content") or {}).get("parts")) or []
        for part in parts:
            translated = (part.get("text") or "").strip()
            if translated:
                return translated
        return None
