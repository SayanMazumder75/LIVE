"""
Cloudinary upload service for full-session audio recordings.

Mirrors the upload-to-Cloudinary block from the old MeetMind
`server.js` but in async-friendly Python: the official `cloudinary`
SDK only ships a sync `upload()` API, so we wrap each call in
`asyncio.to_thread` to keep the aiohttp event loop unblocked.

Configuration
-------------
    CLOUDINARY_CLOUD_NAME
    CLOUDINARY_API_KEY
    CLOUDINARY_API_SECRET

If any of those are missing the service reports as *not configured*
and the `/upload-audio` route returns a friendly 503 — same
gracefully-degraded pattern used for missing `MONGO_URI`. Live
transcription, session save/load, and AI insights all keep working;
only persistent recordings are unavailable until the env vars are
filled in.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional

logger = logging.getLogger("cloudinary_service")

_configured: bool = False
_config_error: str = ""


def is_configured() -> bool:
    """True when all three CLOUDINARY_* env vars are present."""
    return bool(
        (os.getenv("CLOUDINARY_CLOUD_NAME") or "").strip()
        and (os.getenv("CLOUDINARY_API_KEY") or "").strip()
        and (os.getenv("CLOUDINARY_API_SECRET") or "").strip()
    )


def configuration_error() -> str:
    """Human-readable reason why upload would fail right now."""
    if _config_error:
        return _config_error
    if not is_configured():
        missing = [
            name
            for name in ("CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET")
            if not (os.getenv(name) or "").strip()
        ]
        return (
            "Cloudinary is not configured. Missing env var"
            + ("s" if len(missing) > 1 else "")
            + ": "
            + ", ".join(missing)
        )
    return ""


def _ensure_configured() -> None:
    """Lazy-init the cloudinary SDK with current env values."""
    global _configured, _config_error
    if _configured:
        return
    try:
        import cloudinary  # type: ignore
    except ImportError:
        _config_error = (
            "`cloudinary` Python package is not installed. Run "
            "`pip install -r backend/requirements.txt` and restart the server."
        )
        logger.warning(_config_error)
        return

    cloudinary.config(
        cloud_name=os.getenv("CLOUDINARY_CLOUD_NAME"),
        api_key=os.getenv("CLOUDINARY_API_KEY"),
        api_secret=os.getenv("CLOUDINARY_API_SECRET"),
        secure=True,
    )
    _configured = True
    _config_error = ""
    logger.info(
        "Cloudinary configured (cloud_name=%s)",
        os.getenv("CLOUDINARY_CLOUD_NAME"),
    )


async def upload_audio(
    audio_bytes: bytes,
    public_id: str,
    folder: str = "live_translator_audio",
) -> dict:
    """
    Upload one audio file to Cloudinary, blocking only on the
    network call (offloaded to a worker thread).

    Parameters
    ----------
    audio_bytes : raw bytes of the recorded audio (webm/opus or wav).
    public_id   : the session_id — used as the Cloudinary public_id so
                  re-uploads for the same session overwrite the
                  previous file rather than piling up.
    folder      : Cloudinary folder name. Defaults to a project-
                  specific folder so admin clean-up is easy.

    Returns
    -------
    {"url": str, "duration": int}

    Raises
    ------
    RuntimeError if Cloudinary isn't configured / SDK isn't installed.
    Underlying cloudinary errors propagate as-is so the HTTP layer can
    map them to 5xx with the original message.
    """
    if not is_configured():
        raise RuntimeError(configuration_error())
    _ensure_configured()
    if not _configured:
        raise RuntimeError(configuration_error() or "Cloudinary not initialised")

    import cloudinary.uploader  # type: ignore

    def _do_upload():
        return cloudinary.uploader.upload(
            audio_bytes,
            resource_type="auto",  # 'auto' so audio + video both work
            folder=folder,
            public_id=public_id,
            overwrite=True,
            invalidate=True,
        )

    result = await asyncio.to_thread(_do_upload)

    return {
        "url": result.get("secure_url") or result.get("url") or "",
        "duration": int(result.get("duration") or 0),
        "format": result.get("format") or "",
        "bytes": int(result.get("bytes") or 0),
    }


def diagnostics() -> dict:
    """Snapshot used by GET / for the frontend banner."""
    return {
        "enabled": is_configured(),
        "error": configuration_error(),
        "cloud_name": (os.getenv("CLOUDINARY_CLOUD_NAME") or "").strip(),
    }
