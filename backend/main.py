"""
Entry point for the AI Transcriber backend.

Can run in three modes via the RUN_MODE env var:

    RUN_MODE=all   (default) — both servers in one process.
                                Used for local development, where you
                                want a single `python main.py` to bring
                                everything up.

    RUN_MODE=http  — HTTP REST server only (port HTTP_PORT or PORT,
                     default 8000). Sessions, insights, audio upload.

    RUN_MODE=ws    — WebSocket server only (port WS_PORT or PORT,
                     default 8001). Live AssemblyAI / Whisper bridge.

The split modes exist so the project can be deployed on hosts that
expose exactly ONE port per service (Render free tier, Fly.io, etc.).
On those hosts you create two services pointing at the same repo,
set RUN_MODE accordingly, and the host's `PORT` env var picks up
automatically.

Both servers share a single MongoDB connection (see `db.py`). If
`MONGO_URI` is unset the persistence routes return 503 but the
WebSocket transcription path keeps working — the audio pipeline has
no hard dependency on the database.

Run:
    python main.py                          # local dev: both servers
    RUN_MODE=http PORT=8000 python main.py  # HTTP only (Render service A)
    RUN_MODE=ws   PORT=8001 python main.py  # WS only   (Render service B)
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

# ── env helpers ──────────────────────────────────────────────────────────────

# Hosts that expose a single port (Render, Heroku-style PaaS) usually
# inject it via the bare `PORT` env var. We honour that as a fallback
# for whichever mode the process is running in, so the same Dockerfile
# / start command works on every platform without per-host rewiring.

def _run_mode() -> str:
    raw = (os.getenv("RUN_MODE") or "all").strip().lower()
    if raw not in ("all", "http", "ws"):
        logger.warning("invalid RUN_MODE=%r, falling back to 'all'", raw)
        return "all"
    return raw


def _ws_host() -> str:
    return os.getenv("WS_HOST", "0.0.0.0")


def _ws_port(mode: str) -> int:
    """
    Pick the port for the WS server.
    - RUN_MODE=ws  → prefer WS_PORT, then PORT, then default 8001.
    - RUN_MODE=all → prefer WS_PORT, then default 8001 (PORT is HTTP's).
    """
    candidates = [os.getenv("WS_PORT")]
    if mode == "ws":
        candidates.append(os.getenv("PORT"))
    candidates.append("8001")
    for raw in candidates:
        if raw is None:
            continue
        try:
            return int(raw)
        except ValueError:
            logger.warning("invalid WS port value %r, trying next", raw)
    return 8001


def _http_host() -> str:
    return os.getenv("HTTP_HOST", "0.0.0.0")


def _http_port(mode: str) -> int:
    """
    Pick the port for the HTTP server.
    - RUN_MODE=http → prefer HTTP_PORT, then PORT, then default 8000.
    - RUN_MODE=all  → prefer HTTP_PORT, then PORT, then default 8000.
                       (PORT is the more common single-port host
                        convention; if the user only wants one server
                        they typically set HTTP_PORT explicitly.)
    """
    candidates = [os.getenv("HTTP_PORT")]
    if mode == "http" or mode == "all":
        candidates.append(os.getenv("PORT"))
    candidates.append("8000")
    for raw in candidates:
        if raw is None:
            continue
        try:
            return int(raw)
        except ValueError:
            logger.warning("invalid HTTP port value %r, trying next", raw)
    return 8000


# ── runners ──────────────────────────────────────────────────────────────────


async def _run_all() -> None:
    """Both servers in one process — local development default."""
    await db.start_db()
    http_runner = await start_http_server(host=_http_host(), port=_http_port("all"))
    try:
        # The WebSocket server runs forever; returns only on
        # KeyboardInterrupt or fatal error. HTTP keeps serving as long
        # as this coroutine is alive.
        await start_server(host=_ws_host(), port=_ws_port("all"))
    finally:
        try:
            await http_runner.cleanup()
        except Exception:  # noqa: BLE001
            pass
        try:
            await db.close_db()
        except Exception:  # noqa: BLE001
            pass


async def _run_http_only() -> None:
    """HTTP REST server only — Render free-tier 'service A'."""
    await db.start_db()
    runner = await start_http_server(host=_http_host(), port=_http_port("http"))
    logger.info("running in HTTP-only mode (RUN_MODE=http)")
    try:
        # Sleep forever; aiohttp serves in the background.
        while True:
            await asyncio.sleep(3600)
    finally:
        try:
            await runner.cleanup()
        except Exception:  # noqa: BLE001
            pass
        try:
            await db.close_db()
        except Exception:  # noqa: BLE001
            pass


async def _run_ws_only() -> None:
    """WebSocket server only — Render free-tier 'service B'.

    We still call db.start_db() so cross-cutting concerns (like
    logging the masked Mongo URI) behave consistently between modes;
    the WS path itself doesn't write to Mongo, so a missing MONGO_URI
    is a no-op here.
    """
    await db.start_db()
    logger.info("running in WS-only mode (RUN_MODE=ws)")
    try:
        await start_server(host=_ws_host(), port=_ws_port("ws"))
    finally:
        try:
            await db.close_db()
        except Exception:  # noqa: BLE001
            pass


# ── main ─────────────────────────────────────────────────────────────────────


def main() -> None:
    mode = _run_mode()
    coro = (
        _run_http_only()
        if mode == "http"
        else _run_ws_only()
        if mode == "ws"
        else _run_all()
    )
    try:
        asyncio.run(coro)
    except KeyboardInterrupt:
        logger.info("shutting down (KeyboardInterrupt)")


if __name__ == "__main__":
    main()
