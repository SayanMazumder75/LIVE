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
    Control messages : {"type": "start"}
                       {"type": "stop"}
                       {"type": "translate", "id": "<id>", "text": "<text>"}

Server → browser protocol
-------------------------
    {"type": "status", "status": "connected" | "ready" | "stopped"}
    {"type": "transcript", "text": "...", "final": bool, "id": "..."}
    {"type": "translation", "id": "<matching transcript id>", "text": "..."}
    {"type": "error", "message": "..."}

Each browser tab gets its own AssemblyAI session, opened on "start" and
closed on "stop" (or when the websocket drops). The API key never leaves
the server.

Translation (optional, enabled by setting `GEMINI_API_KEY`) runs in a
fire-and-forget background task per finalized transcript. It never
blocks transcripts and never modifies them — translations arrive as
their own message frame keyed to the transcript's `id`.

The "translate" control message is for clients that did the speech-to-
text themselves (e.g. browser Web Speech API for Hindi, since AAI's
streaming model doesn't yet support Hindi). The server treats it as a
standalone "please translate this text" request — it does NOT echo back
a transcript frame, only the translation. The browser is expected to
have already rendered the original line with `id` locally.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from urllib.parse import urlencode

import websockets
from websockets.exceptions import ConnectionClosed

from translator import Translator

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


async def _forward_aai_to_client(
    aai_ws,
    client_ws,
    translator: Translator,
    translation_tasks: "set[asyncio.Task]",
) -> None:
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
                    transcript_id = uuid.uuid4().hex[:12]
                    await _send_json(
                        client_ws,
                        {
                            "type": "transcript",
                            "text": transcript,
                            "final": True,
                            "id": transcript_id,
                        },
                    )
                    # Fire-and-forget translation. Never blocks the
                    # transcript path; if it fails, the original line
                    # still stands on its own.
                    if translator.enabled:
                        task = asyncio.create_task(
                            _translate_and_send(
                                translator, client_ws, transcript_id, transcript
                            ),
                            name=f"translate-{transcript_id}",
                        )
                        translation_tasks.add(task)
                        task.add_done_callback(translation_tasks.discard)
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


async def _translate_and_send(
    translator: Translator,
    client_ws,
    transcript_id: str,
    text: str,
) -> None:
    """
    Run a translation in the background and post it back to the browser.
    Errors are logged but never propagated — translation is best-effort.
    """
    try:
        translated = await translator.translate(text)
    except Exception:  # noqa: BLE001
        logger.exception("translator raised; skipping translation")
        return

    if not translated:
        return

    # Skip when the translator returned the same text — the user spoke
    # English and the prompt told the model to leave it alone. Comparing
    # case-insensitively trimmed avoids spurious "translations" that just
    # rephrase whitespace or capitalization.
    if translated.strip().lower() == text.strip().lower():
        return

    logger.info("translation: id=%s text=%r", transcript_id, translated)
    await _send_json(
        client_ws,
        {
            "type": "translation",
            "id": transcript_id,
            "text": translated,
            "source_text": text,
        },
    )


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


async def _run_session(
    client_ws,
    api_key: str,
    translator: Translator,
) -> None:
    """
    Open one AssemblyAI session for the connected browser, pump audio
    through it, and stream transcripts back. Returns when the session
    ends (client disconnects, sends `stop`, or AAI terminates).

    `translator` is provided by the caller so locally-recognized
    transcripts (e.g. Hindi via the browser's Web Speech API) can share
    the same Gemini configuration without opening a separate AAI
    session.
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

    # Tracks in-flight background translation tasks so we can clean them
    # up when the session ends.
    translation_tasks: "set[asyncio.Task]" = set()

    forwarder = asyncio.create_task(
        _forward_aai_to_client(aai_ws, client_ws, translator, translation_tasks),
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

        # Drain any in-flight translation tasks. Give them a brief grace
        # period so a slow Gemini response can still reach the browser
        # before we declare the session stopped, then cancel the rest.
        if translation_tasks:
            try:
                await asyncio.wait(
                    list(translation_tasks),
                    timeout=2.0,
                    return_when=asyncio.ALL_COMPLETED,
                )
            except Exception:  # noqa: BLE001
                pass
            for t in list(translation_tasks):
                if not t.done():
                    t.cancel()

    await _send_json(client_ws, {"type": "status", "status": "stopped"})


# --------------------------------------------------------------------------
# top-level handler
# --------------------------------------------------------------------------


async def _handler(client_ws) -> None:
    peer = getattr(client_ws, "remote_address", None)
    logger.info("client connected: %s", peer)

    api_key = os.getenv("ASSEMBLYAI_API_KEY", "").strip()

    # One translator per browser tab. Constructed eagerly so the
    # "translate" control path (used by Hindi mode) works without
    # opening an AAI session first.
    translator = Translator()

    # In-flight background translations triggered by "translate"
    # control messages outside of any AAI session. Cleaned up on
    # client disconnect.
    standalone_translations: "set[asyncio.Task]" = set()

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
                await _run_session(client_ws, api_key, translator)
            elif ctype == "stop":
                # No active session; nothing to do.
                continue
            elif ctype == "translate":
                # Standalone translation request — used by Hindi mode
                # where the browser does the recognition itself.
                text = (ctrl.get("text") or "").strip()
                msg_id = ctrl.get("id")
                if not text or not isinstance(msg_id, str) or not msg_id:
                    continue
                if not translator.enabled:
                    await _send_json(
                        client_ws,
                        {
                            "type": "error",
                            "message": "Translation requested, but GEMINI_API_KEY "
                            "is not set on the server.",
                        },
                    )
                    continue
                task = asyncio.create_task(
                    _translate_and_send(translator, client_ws, msg_id, text),
                    name=f"standalone-translate-{msg_id}",
                )
                standalone_translations.add(task)
                task.add_done_callback(standalone_translations.discard)
            else:
                continue
    except ConnectionClosed:
        pass
    except Exception:  # noqa: BLE001
        logger.exception("client handler crashed")
    finally:
        # Drain any in-flight standalone translations briefly so the
        # client gets the last few results, then cancel the rest.
        if standalone_translations:
            try:
                await asyncio.wait(
                    list(standalone_translations),
                    timeout=1.0,
                    return_when=asyncio.ALL_COMPLETED,
                )
            except Exception:  # noqa: BLE001
                pass
            for t in list(standalone_translations):
                if not t.done():
                    t.cancel()
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
