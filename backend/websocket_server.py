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
                                                  │  Begin / Turn / Termination / Error
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
import time
from urllib.parse import urlencode

import websockets
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger("websocket_server")

# AssemblyAI Universal-Streaming v3
AAI_HOST = "wss://streaming.assemblyai.com/v3/ws"
AAI_SAMPLE_RATE = 16000
# Match the official SDK's API version pin for stability.
AAI_API_VERSION = "2025-05-12"


def _aai_url() -> str:
    """Build the v3 streaming URL with sensible defaults for live captions."""
    params = {
        "sample_rate": AAI_SAMPLE_RATE,
        "encoding": "pcm_s16le",
        # We want live partial transcripts, not just end-of-turn finals.
        "format_turns": "true",
        "include_partial_turns": "true",
    }
    return f"{AAI_HOST}?{urlencode(params)}"


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
    Headers + connect options for AssemblyAI v3.

    `additional_headers` is the websockets >= 13 spelling. We pin >= 13 in
    requirements but we still defend against older installs in callers.
    """
    return {
        "additional_headers": {
            "Authorization": api_key,
            "AssemblyAI-Version": AAI_API_VERSION,
            "User-Agent": "ai-transcriber/0.1 (raw-websocket)",
        },
        "max_size": None,
        "ping_interval": 20,
        "ping_timeout": 20,
        "open_timeout": 10,
    }


# --------------------------------------------------------------------------
# AssemblyAI -> browser
# --------------------------------------------------------------------------


async def _forward_aai_to_client(aai_ws, client_ws) -> None:
    """Translate AssemblyAI events into the browser-facing protocol."""
    try:
        async for raw in aai_ws:
            if isinstance(raw, (bytes, bytearray)):
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            mtype = msg.get("type")

            if mtype == "Begin":
                logger.info(
                    "AAI session begin: id=%s expires_at=%s",
                    msg.get("id"),
                    msg.get("expires_at"),
                )
                continue

            if mtype == "Termination":
                logger.info(
                    "AAI session terminated: audio=%ss session=%ss",
                    msg.get("audio_duration_seconds"),
                    msg.get("session_duration_seconds"),
                )
                break

            if mtype == "Turn":
                transcript = (msg.get("transcript") or "").strip()
                end_of_turn = bool(msg.get("end_of_turn"))
                formatted = bool(msg.get("turn_is_formatted"))
                logger.info(
                    "AAI Turn: end=%s formatted=%s text=%r",
                    end_of_turn,
                    formatted,
                    transcript,
                )

                if not transcript:
                    continue

                # Partial (live) update during a turn.
                if not end_of_turn:
                    await _send_json(
                        client_ws,
                        {"type": "transcript", "text": transcript, "final": False},
                    )
                    continue

                # End of turn. With format_turns=true AAI emits two
                # end-of-turn frames (unformatted then formatted). Forward
                # only the formatted one to avoid duplicate appended
                # lines. As a safety net, if for some reason only the
                # unformatted version arrives, we still want the user to
                # see something.
                if formatted:
                    await _send_json(
                        client_ws,
                        {"type": "transcript", "text": transcript, "final": True},
                    )
                # Unformatted finals are skipped; the formatted version
                # follows shortly.
                continue

            if mtype == "Error":
                err = msg.get("error") or "Unknown AssemblyAI error"
                code = msg.get("error_code")
                logger.error("AAI error: code=%s message=%s", code, err)
                await _send_json(
                    client_ws,
                    {"type": "error", "message": f"AssemblyAI: {err}"},
                )
                break

            if mtype == "Warning":
                logger.warning(
                    "AAI warning: code=%s message=%s",
                    msg.get("warning_code"),
                    msg.get("warning"),
                )
                continue

            # Unknown message types are ignored.
    except ConnectionClosed:
        pass
    except Exception:  # noqa: BLE001
        logger.exception("aai->client forwarder crashed")


# --------------------------------------------------------------------------
# one transcription session
# --------------------------------------------------------------------------


async def _open_aai(api_key: str):
    """Open the AAI websocket, falling back to older `extra_headers` API."""
    url = _aai_url()
    try:
        return await websockets.connect(url, **_aai_connect_kwargs(api_key))
    except TypeError:
        kwargs = _aai_connect_kwargs(api_key)
        kwargs["extra_headers"] = kwargs.pop("additional_headers")
        return await websockets.connect(url, **kwargs)


async def _run_session(client_ws, api_key: str) -> None:
    """
    Open one AssemblyAI session for the connected browser, pump audio
    through it, and stream transcripts back. Returns when the session
    ends (client disconnects, sends `stop`, or AAI terminates).
    """
    try:
        aai_ws = await _open_aai(api_key)
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

    # Periodic audio-flow log so we can tell at a glance whether audio is
    # actually arriving from the browser. Logged every 5 seconds.
    bytes_received = 0
    chunks_received = 0
    last_log = time.monotonic()
    LOG_EVERY_SEC = 5.0

    try:
        async for message in client_ws:
            if isinstance(message, (bytes, bytearray)):
                bytes_received += len(message)
                chunks_received += 1
                try:
                    await aai_ws.send(message)
                except ConnectionClosed:
                    break

                now = time.monotonic()
                if now - last_log >= LOG_EVERY_SEC:
                    logger.info(
                        "audio: %d chunks / %d bytes in last %.1fs",
                        chunks_received,
                        bytes_received,
                        now - last_log,
                    )
                    bytes_received = 0
                    chunks_received = 0
                    last_log = now
                continue

            # Control message
            try:
                ctrl = json.loads(message)
            except json.JSONDecodeError:
                continue
            ctype = ctrl.get("type")
            if ctype == "stop":
                logger.info("client requested stop")
                break
            if ctype == "start":
                # Already in a session — ignore re-starts so we don't open
                # a second AAI socket for the same browser tab.
                logger.debug("ignoring 'start' while already streaming")
                continue
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


async def _handler(client_ws) -> None:
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
                await _run_session(client_ws, api_key)
            elif ctype == "stop":
                # No active session; nothing to do.
                continue
            else:
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
        await asyncio.Future()
