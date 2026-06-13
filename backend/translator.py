"""
Hindi → English translator backed by Groq's OpenAI-compatible API.

This module is **only** invoked when the client explicitly asks for a
translation via the `{type:"translate"}` WebSocket control message
(used by Hindi mode, where the browser does the speech-to-text itself
because AssemblyAI's streaming model doesn't yet support Hindi).

It is deliberately **not** wired into the AssemblyAI final-transcript
path: AAI already returns clean English for English audio, so calling
an LLM there is pure waste of free-tier quota. Each API does its job:

    AssemblyAI key  →  English speech → English text
    Groq key        →  Hindi   text   → English text

Why Groq instead of Gemini
--------------------------
Gemini's free tier is ~15 RPM / 1000 requests/day, which is easy to
exhaust in interactive testing. Groq's free tier is ~30 RPM and
**14,400 requests/day**, which is closer to "effectively unlimited"
for a single user. Groq is OpenAI-compatible, so swapping the API was
mostly a one-file change.

If `GROQ_API_KEY` is not set, or `httpx` is not installed, the
translator is a no-op (`enabled == False`) and the standalone
`translate` control message is rejected with a clear error.

Environment variables
---------------------
    GROQ_API_KEY     required to enable translations
                     get a free key: https://console.groq.com/keys
    GROQ_MODEL       optional, defaults to "llama-3.3-70b-versatile"
                     (multilingual, supports Hindi well, free tier)

Wire format (OpenAI Chat Completions, hosted by Groq)
-----------------------------------------------------
    POST https://api.groq.com/openai/v1/chat/completions
    Authorization: Bearer $GROQ_API_KEY
    {
      "model": "...",
      "messages": [{"role":"system",...}, {"role":"user",...}],
      "temperature": 0.1,
      "max_tokens": 256
    }
    -> {"choices":[{"message":{"role":"assistant","content":"..."}}], ...}
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger("translator")

GROQ_DEFAULT_MODEL = "llama-3.3-70b-versatile"
GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"

# Hindi-only translator. The defensive "English stays English" rule
# protects against any stray English text reaching this code path.
SYSTEM_PROMPT = (
    "You are a translator that converts Hindi (Devanagari script or "
    "Romanized Hindi) into natural, fluent English for a live "
    "captioning app.\n"
    "\n"
    "Rules:\n"
    "- Translate the user's input into natural, fluent English.\n"
    "- If the input is already entirely in English, return it unchanged.\n"
    "- Preserve names, numbers, and proper nouns.\n"
    "- Output ONLY the translated text. No explanations, no quotes, no "
    "labels, no quotation marks around the result."
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
    """Map common Groq failure codes to friendly user-facing messages."""
    if status == 429:
        return (
            "Groq rate limit reached. The free tier allows about 30 requests "
            "per minute and 14,400 per day; wait a moment and try again, or "
            "switch GROQ_MODEL."
        )
    if status in (401, 403):
        return (
            "Groq API key was rejected. Check GROQ_API_KEY in backend/.env "
            "(get a free key at https://console.groq.com/keys)."
        )
    if status == 400:
        return "Groq rejected the request as malformed (HTTP 400)."
    if status == 404:
        return (
            "Groq model not found. Check GROQ_MODEL — defaults to "
            "llama-3.3-70b-versatile."
        )
    if status >= 500:
        return f"Groq is temporarily unavailable (HTTP {status}). Try again."
    return f"Groq error: HTTP {status}."


class Translator:
    """
    Thin async wrapper around Groq's OpenAI-compatible
    `chat/completions` endpoint.

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
        self.api_key = (api_key or os.getenv("GROQ_API_KEY", "")).strip()
        self.model = (
            (model or os.getenv("GROQ_MODEL", "")).strip() or GROQ_DEFAULT_MODEL
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
                    "GROQ_API_KEY is set but `httpx` is not installed — "
                    "translation disabled. Run `pip install httpx`."
                )
            self._httpx = None
            self._enabled = False

        if self._enabled:
            logger.info("translator enabled (provider=groq, model=%s)", self.model)
        else:
            logger.info("translator disabled (set GROQ_API_KEY to enable)")

    @property
    def enabled(self) -> bool:
        return self._enabled

    async def translate(self, text: str) -> TranslationResult:
        """
        Translate `text` from Hindi to English using Groq.

        Never raises. Returns a `TranslationResult`:
        - `.text` set on success.
        - `.error` set when the API call itself failed (rate limit,
          auth, network, safety block). The caller is expected to
          surface this to the user.
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

        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
            "temperature": 0.1,
            # Caption-sized outputs. Translations don't need long
            # generations, and capping this protects the rate limit.
            "max_tokens": 256,
        }

        try:
            assert self._httpx is not None  # gated by _enabled
            async with self._httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                resp = await client.post(
                    GROQ_ENDPOINT,
                    json=payload,
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                )
            if resp.status_code != 200:
                # Don't log the full response body — it can echo headers
                # in error envelopes from some proxies.
                msg = _http_status_message(resp.status_code)
                logger.warning(
                    "Groq returned HTTP %s: %s", resp.status_code, msg
                )
                return TranslationResult(error=msg, error_code=resp.status_code)
            data = resp.json()
        except Exception as e:  # noqa: BLE001
            logger.warning("translation request failed: %s", e)
            return TranslationResult(error=f"Groq request failed: {e}")

        choices = data.get("choices") or []
        if not choices:
            logger.warning("Groq returned no choices: %s", data)
            return TranslationResult(error="Groq returned no result.")

        message = (choices[0].get("message") or {}) if isinstance(choices[0], dict) else {}
        content = (message.get("content") or "").strip()
        if not content:
            return TranslationResult(error="Groq returned an empty translation.")

        # Strip any leading/trailing quotation marks the model might add
        # despite the prompt instruction.
        if (content.startswith('"') and content.endswith('"')) or (
            content.startswith("'") and content.endswith("'")
        ):
            content = content[1:-1].strip()

        return TranslationResult(text=content)
