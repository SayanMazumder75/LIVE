"""
WebSocket bridge between browser microphones and AssemblyAI's
Universal-Streaming v3 API.

Per-client flow
---------------

    Browser  ──(JSON control + binary PCM16)──►  this server
                                                  │
                                                  │  per-client
                                                  ▼
                              AssemblyAI Universal-Streaming v3
                                                  │
                                                  │  Turn / Begin / Termination
                                                  ▼
    Browser  ◄──(JSON transcripts/status)──   this server

Browser → server protocol
-------------------------
    Binary frames    : 16-bit signed little-endian PCM, mono, 16 kHz
    Control messages : {"type": "start"} | {"type": "stop"}

Server → browser protocol
-------------------------
    {"type": "status", "status": "connected" | "ready" | "stopped"}
    {"type": "transcript", "text": "...", "final": bool}
    {"type": "error", "message": "..."}

Each browser tab gets its own AssemblyAI session, opened on "start" and
closed on "stop" (or when the websocket drops). The API key never leaves
the server.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Optional

import websockets
from websockets.exceptions import ConnectionClosed
from websockets.legacy.client import WebSocketClientProtocol  # type: ignore
from websockets.legacy.server import WebSocketServerProtocol  # type: ignore

logger = logging.getLogger("websocket_server")

# AssemblyAI Universal-Streaming v3
AAI_SAMPLE_RATE = 16000
AAI_URL = (
    "wss://streaming.assemblyai.com/v3/ws"
    f"?sample_rate={AAI_SAMPLE_RATE}"
    "&encoding=pcm_s16le"
    "&format_turns=true"
)


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


async def _send_json(ws, payload: dict) -> None:
    """Send JSON to a websocket, swallowing close errors."""
    try:
        await ws.send(json.dumps(payload))
    except ConnectionClosed:
        pass
    except Exception:  # noqa: BLE001
        logger.exception("failed to send json to client")


def _aai_connect_kwargs(api_key: str) -> dict:
    """
    Build the kwargs for `websockets.connect` so it works on both the
    websockets v13+ (`additional_headers`) and the older `extra_headers`
    parameter name. We try the new name first.
    """
    # websockets >= 13 accepts `additional_headers`. Older versions accept
    # `extra_headers`. We pin >= 13 in requirements but stay defensive.
    return {
        "additional_headers": {"Authorization": api_key},
        "max_size": None,
        "ping_interval": 20,
        "ping_timeout": 20,
        "open_timeout": 10,
    }


# --------------------------------------------------------------------------
# AssemblyAI -> browser
# --------------------------------------------------------------------------


async def _forward_aai_to_client(
    aai_ws: WebSocketClientProtocol,
    client_ws: WebSocketServerProtocol,
) -> None:
    """Translate AssemblyAI events into the browser-facing protocol."""
    try:
        async for raw in aai_ws:
            if isinstance(raw, (bytes, bytearray)):
                # AAI never sends binary on this channel; ignore.
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            mtype = msg.get("type")

            if mtype == "Begin":
                logger.info("AssemblyAI session begin: id=%s", msg.get("id"))
                continue

            if mtype == "Termination":
                logger.info("AssemblyAI session terminated")
                break

            if mtype == "Turn":
                transcript = (msg.get("transcript") or "").strip()
                if not transcript:
                    continue
                end_of_turn = bool(msg.get("end_of_turn"))
                formatted = bool(msg.get("turn_is_formatted"))

                # Live partials while the user is speaking.
                if not end_of_turn:
                    await _send_json(
                        client_ws,
                        {"type": "transcript", "text": transcript, "final": False},
                    )
                    continue

                # End of turn: prefer the formatted version. Skip the raw
                # final to avoid duplicate appends in the UI.
                if end_of_turn and formatted:
                    await _send_json(
                        client_ws,
                        {"type": "transcript", "text": transcript, "final": True},
                    )
                    continue

                # end_of_turn=True but unformatted: ignore (formatted will
                # arrive next).
                continue

            # Unknown message types are ignored.
    except ConnectionClosed:
        pass
    except Exception:  # noqa: BLE001
        logger.exception("aai->client forwarder crashed")


# --------------------------------------------------------------------------
# one transcription session
# --------------------------------------------------------------------------


async def _run_session(client_ws: WebSocketServerProtocol, api_key: str) -> None:
    """
    Open one AssemblyAI session for the connected browser, pump audio
    through it, and stream transcripts back. Returns when the session
    ends (client disconnects, sends `stop`, or AAI terminates).
    """
    try:
        aai_ws = await websockets.connect(AAI_URL, **_aai_connect_kwargs(api_key))
    except TypeError:
        # Fallback for older websockets versions that use `extra_headers`.
        kwargs = _aai_connect_kwargs(api_key)
        kwargs["extra_headers"] = kwargs.pop("additional_headers")
        aai_ws = await websockets.connect(AAI_URL, **kwargs)
    except Exception as e:  # noqa: BLE001
        logger.exception("Failed to connect to AssemblyAI")
        await _send_json(
            client_ws,
            {"type": "error", "message": f"AssemblyAI connection failed: {e}"},
        )
        return

    await _send_json(client_ws, {"type": "status", "status": "ready"})

    forwarder = asyncio.create_task(
        _forward_aai_to_client(aai_ws, client_ws),
        name="aai-forwarder",
    )

    try:
        async for message in client_ws:
            if isinstance(message, (bytes, bytearray)):
                # Forward audio frames straight through.
                try:
                    await aai_ws.send(message)
                except ConnectionClosed:
                    break
                continue

            # Control message
            try:
                ctrl = json.loads(message)
            except json.JSONDecodeError:
                continue
            if ctrl.get("type") == "stop":
                break
            # Other control messages are ignored mid-session.
    except ConnectionClosed:
        pass
    finally:
        # Politely terminate the AssemblyAI session.
        try:
            await aai_ws.send(json.dumps({"type": "Terminate"}))
        except Exception:  # noqa: BLE001
            pass
        try:
            await aai_ws.close()
        except Exception:  # noqa: BLE001
            pass

        forwarder.cancel()
        try:
            await forwarder
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass

    await _send_json(client_ws, {"type": "status", "status": "stopped"})


# --------------------------------------------------------------------------
# top-level handler
# --------------------------------------------------------------------------


async def _handler(client_ws: WebSocketServerProtocol) -> None:
    peer = getattr(client_ws, "remote_address", None)
    logger.info("client connected: %s", peer)

    api_key = os.getenv("ASSEMBLYAI_API_KEY", "").strip()

    await _send_json(client_ws, {"type": "status", "status": "connected"})

    if not api_key:
        await _send_json(
            client_ws,
            {
                "type": "error",
                "message": "Server is missing ASSEMBLYAI_API_KEY. "
                "Set it in backend/.env and restart.",
            },
        )

    try:
        async for message in client_ws:
            if isinstance(message, (bytes, bytearray)):
                # No active session; drop audio silently.
                continue

            try:
                ctrl = json.loads(message)
            except json.JSONDecodeError:
                continue

            ctype = ctrl.get("type")
            if ctype == "start":
                if not api_key:
                    await _send_json(
                        client_ws,
                        {
                            "type": "error",
                            "message": "Cannot start: ASSEMBLYAI_API_KEY is not set "
                            "on the server.",
                        },
                    )
                    continue
                # Run one session; when it returns, loop and wait for
                # another "start".
                await _run_session(client_ws, api_key)
            elif ctype == "stop":
                # No active session; nothing to do.
                continue
            else:
                # Unknown control type; ignore.
                continue
    except ConnectionClosed:
        pass
    except Exception:  # noqa: BLE001
        logger.exception("client handler crashed")
    finally:
        logger.info("client disconnected: %s", peer)


# --------------------------------------------------------------------------
# public entry point
# --------------------------------------------------------------------------


async def start_server(host: str = "0.0.0.0", port: int = 8001) -> None:
    """Start the websocket server and run forever."""
    logger.info("transcriber WS server listening on ws://%s:%d", host, port)
    if not os.getenv("ASSEMBLYAI_API_KEY", "").strip():
        logger.warning(
            "ASSEMBLYAI_API_KEY is not set; clients will receive an error "
            "when they try to start a session."
        )
    async with websockets.serve(
        _handler,
        host,
        port,
        max_size=None,
        ping_interval=20,
        ping_timeout=20,
    ):
        await asyncio.Future()  # run until cancelled
