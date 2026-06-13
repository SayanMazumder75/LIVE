"""
Entry point for the AI Transcriber backend.

Loads environment variables and starts the WebSocket bridge that connects
browser microphones to AssemblyAI's Universal-Streaming v3 API.

Run:
    python main.py
"""

from __future__ import annotations

import asyncio
import logging
import os

from dotenv import load_dotenv

from websocket_server import start_server

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("main")


def _host() -> str:
    return os.getenv("WS_HOST", "0.0.0.0")


def _port() -> int:
    try:
        return int(os.getenv("WS_PORT", "8001"))
    except ValueError:
        logger.warning("invalid WS_PORT, falling back to 8001")
        return 8001


def main() -> None:
    try:
        asyncio.run(start_server(host=_host(), port=_port()))
    except KeyboardInterrupt:
        logger.info("shutting down (KeyboardInterrupt)")


if __name__ == "__main__":
    main()
