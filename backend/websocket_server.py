"""
Lightweight WebSocket broadcast server.

Runs an asyncio websockets server in a dedicated background thread so it
can coexist peacefully with the LiveKit worker's own event loop.

Public API:
    start_websocket_server(host="0.0.0.0", port=8001)
    await broadcast_transcript(text)

Wire format:
    {"type": "transcript", "text": "<utterance>"}
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from typing import Optional, Set

import websockets
from websockets.exceptions import ConnectionClosed
from websockets.server import WebSocketServerProtocol

logger = logging.getLogger("websocket_server")

# --- module state ----------------------------------------------------------

_clients: Set[WebSocketServerProtocol] = set()
_clients_lock = threading.Lock()

_loop: Optional[asyncio.AbstractEventLoop] = None
_server_thread: Optional[threading.Thread] = None
_start_lock = threading.Lock()


# --- internal --------------------------------------------------------------


async def _handler(websocket: WebSocketServerProtocol) -> None:
    """Track a connected client until it disconnects."""
    with _clients_lock:
        _clients.add(websocket)
        count = len(_clients)
    logger.info("websocket client connected (%d total)", count)

    try:
        # We don't expect inbound messages from the UI, but we drain them
        # so the connection stays healthy.
        async for _ in websocket:
            pass
    except ConnectionClosed:
        pass
    except Exception:  # noqa: BLE001
        logger.exception("websocket handler error")
    finally:
        with _clients_lock:
            _clients.discard(websocket)
            count = len(_clients)
        logger.info("websocket client disconnected (%d remaining)", count)


async def _broadcast(message: str) -> None:
    """Send `message` to every connected client; prune dead ones."""
    with _clients_lock:
        targets = list(_clients)

    if not targets:
        return

    dead: list[WebSocketServerProtocol] = []
    for ws in targets:
        try:
            await ws.send(message)
        except ConnectionClosed:
            dead.append(ws)
        except Exception:  # noqa: BLE001
            logger.exception("failed to send to a client; dropping it")
            dead.append(ws)

    if dead:
        with _clients_lock:
            for ws in dead:
                _clients.discard(ws)


async def _run_server(host: str, port: int) -> None:
    async with websockets.serve(_handler, host, port, ping_interval=20, ping_timeout=20):
        logger.info("websocket server listening on ws://%s:%d", host, port)
        # Run forever
        await asyncio.Future()


# --- public API ------------------------------------------------------------


def start_websocket_server(host: str = "0.0.0.0", port: int = 8001) -> None:
    """Start the websocket server in a background thread.

    Idempotent: calling more than once is a no-op.
    """
    global _loop, _server_thread

    with _start_lock:
        if _server_thread and _server_thread.is_alive():
            return

        ready = threading.Event()

        def _thread_target() -> None:
            global _loop
            loop = asyncio.new_event_loop()
            _loop = loop
            asyncio.set_event_loop(loop)
            ready.set()
            try:
                loop.run_until_complete(_run_server(host, port))
            except Exception:  # noqa: BLE001
                logger.exception("websocket server crashed")
            finally:
                try:
                    loop.close()
                finally:
                    pass

        _server_thread = threading.Thread(
            target=_thread_target, daemon=True, name="ws-broadcast-server"
        )
        _server_thread.start()
        # Wait until the loop has been created so broadcast_transcript()
        # called immediately afterwards has somewhere to schedule onto.
        ready.wait()


async def broadcast_transcript(text: str) -> None:
    """Broadcast a transcript line to every connected websocket client.

    Safe to call from any asyncio loop; the actual send happens on the
    server's own loop in the background thread.
    """
    if _loop is None or not _loop.is_running():
        logger.warning("websocket server not running; dropping transcript")
        return

    if not text:
        return

    payload = json.dumps({"type": "transcript", "text": text})

    fut = asyncio.run_coroutine_threadsafe(_broadcast(payload), _loop)
    try:
        # Bridge a concurrent.futures.Future into the caller's loop.
        await asyncio.wrap_future(fut)
    except Exception:  # noqa: BLE001
        logger.exception("broadcast_transcript failed")
