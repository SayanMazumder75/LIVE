"""
Entry point for the AI Transcriber backend.

Starts two long-running services in the same event loop:

1. **WebSocket server** (port WS_PORT, default 8001) — the existing
   bridge between browser microphones and AssemblyAI / Groq Whisper.
   Untouched by the session-persistence migration.

2. **HTTP REST server** (port HTTP_PORT, default 8000) — the four
   session-storage routes ported over from the old MeetMind
   `server.js`: /start-session, /push, /transcripts,
   /transcript/:session_id.

Both servers share a single MongoDB connection (see `db.py`). If
`MONGO_URI` is unset the persistence routes return 503 but the
WebSocket transcription path keeps working — the audio pipeline has
no hard dependency on the database.

Run:
    python main.py
"""

from __future__ import annotations

import asyncio
import logging
import os

from dotenv import load_dotenv

import db
from http_server import start_http_server
from websocket_server import start_server

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("main")


def _ws_host() -> str:
    return os.getenv("WS_HOST", "0.0.0.0")


def _ws_port() -> int:
    try:
        return int(os.getenv("WS_PORT", "8001"))
    except ValueError:
        logger.warning("invalid WS_PORT, falling back to 8001")
        return 8001


def _http_host() -> str:
    return os.getenv("HTTP_HOST", "0.0.0.0")


def _http_port() -> int:
    try:
        return int(os.getenv("HTTP_PORT", "8000"))
    except ValueError:
        logger.warning("invalid HTTP_PORT, falling back to 8000")
        return 8000


async def _run() -> None:
    # Connect to MongoDB once at startup. Never raises — see db.py.
    await db.start_db()

    # Start the HTTP REST server. We hold on to the runner so we can
    # shut it down cleanly when the WS server exits.
    http_runner = await start_http_server(host=_http_host(), port=_http_port())

    try:
        # The WebSocket server runs forever; this returns only on
        # KeyboardInterrupt or fatal error. The HTTP server keeps
        # serving as long as this coroutine is alive.
        await start_server(host=_ws_host(), port=_ws_port())
    finally:
        try:
            await http_runner.cleanup()
        except Exception:  # noqa: BLE001
            pass
        try:
            await db.close_db()
        except Exception:  # noqa: BLE001
            pass


def main() -> None:
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        logger.info("shutting down (KeyboardInterrupt)")


if __name__ == "__main__":
    main()
