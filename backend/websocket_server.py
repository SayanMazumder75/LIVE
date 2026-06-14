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
                       {"type": "hindi_chunk", "id": "<id>"}
                         followed immediately by ONE binary frame of
                         16 kHz mono int16 LE PCM (~0.3 – 30 seconds).

Server → browser protocol
-------------------------
    {"type": "status", "status": "connected" | "ready" | "stopped"}
    {"type": "transcript", "text": "...", "final": bool, "id": "..."}
    {"type": "translation", "id": "<matching transcript id>", "text": "..."}
    {"type": "error", "message": "..."}

Each browser tab gets its own AssemblyAI session, opened on "start" and
closed on "stop" (or when the websocket drops). The API key never leaves
the server.

Translation policy
------------------
This server uses TWO independent APIs with TWO non-overlapping jobs:

    AssemblyAI key  →  English speech         →  English text
    Groq key        →  Hindi text / Hindi audio →  English text

We deliberately do NOT call Groq on AssemblyAI's English finals — AAI
already returns clean English, and an LLM round-trip would just burn
free-tier quota. The only paths that talk to Groq are:

  * `{type:"translate", id, text}`     — Hindi text  → English text
                                         (used by Hindi + Microphone:
                                         the browser's Web Speech API
                                         did the STT.)
  * `{type:"hindi_chunk", id}` + binary — Hindi audio → English text
                                         (used by Hindi + System Audio:
                                         the browser can't feed system
                                         audio into the Web Speech API,
                                         so we send PCM chunks to Groq
                                         Whisper, then feed the
                                         resulting Hindi text into the
                                         same translator.)

When Groq returns a real failure (most commonly HTTP 429 rate limit),
the server forwards a `{type:"error", message:...}` frame so the user
sees *why* a transcript / translation didn't appear instead of silently
missing.
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

from translator import Translator, TranslationResult
from stt import WhisperSTT, TranscriptionResult

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
    """
    Translate AssemblyAI events into the browser-facing protocol.

    AAI handles English natively, so we forward its finals straight
    through. **No Gemini round-trip happens here.** Translation only
    runs on explicit `{type:"translate"}` requests from the client.
    """
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
                # end-of-turn frames (unformatted then formatted). Only
                # forward the formatted one to avoid duplicate appended
                # lines.
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
    Run a Gemini translation in the background and post the result back
    to the browser. Never raises.

    Outcome handling:
    - success: emit {type:"translation", id, text, source_text}
    - real failure (e.g. 429): emit {type:"error", message:...} so the
      user sees a clear cause instead of a silently missing translation
    - blank input or disabled translator: do nothing
    """
    result: TranslationResult
    try:
        result = await translator.translate(text)
    except Exception:  # noqa: BLE001
        logger.exception("translator raised; skipping translation")
        return

    if result.text:
        translated = result.text
        # Defensive: if Gemini returned the input unchanged (the user
        # spoke English in Hindi mode by mistake, for instance), don't
        # add a no-op "translation" line.
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
        return

    if result.error:
        # Real failure (rate limit, auth, network, safety). Surface it.
        await _send_json(
            client_ws,
            {"type": "error", "message": f"Translation: {result.error}"},
        )
        return

    # Otherwise translator was disabled or input was blank — silent no-op.


# --------------------------------------------------------------------------
# Hindi system-audio chunk processing
# --------------------------------------------------------------------------


async def _transcribe_and_send(
    stt: WhisperSTT,
    translator: Translator,
    client_ws,
    chunk_id: str,
    pcm_bytes: bytes,
) -> None:
    """
    Run a Hindi audio chunk through Whisper, emit the transcript, then
    run the resulting Hindi text through the existing Translator and
    emit the translation. Never raises.

    Frames are emitted in this order:

        {type:"transcript", final:true, id, text:<hindi>}    (always)
        {type:"translation", id, text:<english>, ...}        (if enabled
                                                              and Groq
                                                              succeeded)

    On any real Whisper / translator failure (rate limit, auth, …) we
    emit a `{type:"error", message:...}` frame so the user sees why a
    caption / translation didn't appear.
    """
    try:
        result: TranscriptionResult = await stt.transcribe(pcm_bytes, language="hi")
    except Exception:  # noqa: BLE001
        logger.exception("whisper raised; skipping chunk id=%s", chunk_id)
        return

    if result.error:
        await _send_json(
            client_ws,
            {"type": "error", "message": f"Hindi STT: {result.error}"},
        )
        return

    if not result.text:
        # Empty / silent chunk — silent no-op.
        return

    hindi_text = result.text
    logger.info("whisper: id=%s text=%r", chunk_id, hindi_text)
    await _send_json(
        client_ws,
        {
            "type": "transcript",
            "text": hindi_text,
            "final": True,
            "id": chunk_id,
        },
    )

    # Re-use the existing translation path so Hindi + System Audio
    # produces the same UI shape (Hindi line + English under it) as
    # Hindi + Microphone.
    if translator.enabled:
        await _translate_and_send(translator, client_ws, chunk_id, hindi_text)


async def _hindi_chunk_loop(
    stt: WhisperSTT,
    translator: Translator,
    client_ws,
    queue: "asyncio.Queue",
) -> None:
    """
    Single per-client consumer that processes Hindi audio chunks in
    arrival order. Sequential by design so the captions appear in the
    same order the user heard them, even when Whisper / Groq response
    times jitter a bit.
    """
    while True:
        item = await queue.get()
        if item is None:
            return
        chunk_id, pcm_bytes = item
        try:
            await _transcribe_and_send(
                stt, translator, client_ws, chunk_id, pcm_bytes
            )
        except Exception:  # noqa: BLE001
            logger.exception("hindi chunk processing failed id=%s", chunk_id)


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

    AAI handles English transcription only — Gemini is **not** invoked
    here. Translations are dispatched separately from the outer
    `_handler` when the client sends an explicit `{type:"translate"}`.
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
            # Other control messages (including 'translate') are ignored
            # mid-session; the outer handler picks them up after this
            # session returns. Hindi mode and English mode are mutually
            # exclusive in the UI anyway, so this never matters in
            # practice.
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

    # One translator + one Whisper STT per browser tab. Constructed
    # eagerly so the "translate" and "hindi_chunk" control paths work
    # without opening an AAI session first.
    translator = Translator()
    stt = WhisperSTT()

    # In-flight background translations triggered by "translate"
    # control messages. Cleaned up on client disconnect.
    translation_tasks: "set[asyncio.Task]" = set()

    # Hindi system-audio chunks are processed sequentially by a single
    # consumer task so the captions arrive in the order they were
    # spoken. The handler enqueues (id, pcm_bytes) tuples; the
    # consumer drains them one at a time and posts both the transcript
    # and (optionally) translation back to the client.
    hindi_queue: "asyncio.Queue" = asyncio.Queue()
    hindi_consumer = asyncio.create_task(
        _hindi_chunk_loop(stt, translator, client_ws, hindi_queue),
        name="hindi-chunk-loop",
    )

    # When a "hindi_chunk" JSON arrives, we stash its metadata here
    # and wait for the very next binary frame on the same WebSocket
    # to carry the audio payload. WebSocket guarantees frame order on
    # a single connection, so this two-step protocol is robust.
    pending_chunk_meta: "dict | None" = None

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
                if pending_chunk_meta is not None:
                    # This binary frame is the audio payload for the
                    # last hindi_chunk JSON we just received.
                    meta = pending_chunk_meta
                    pending_chunk_meta = None
                    chunk_id = meta.get("id")
                    if not isinstance(chunk_id, str) or not chunk_id:
                        continue
                    if not stt.enabled:
                        await _send_json(
                            client_ws,
                            {
                                "type": "error",
                                "message": "Hindi system-audio mode requested, "
                                "but GROQ_API_KEY is not set on the server.",
                            },
                        )
                        continue
                    # Hand off to the sequential consumer. The consumer
                    # owns the I/O latency budget — the message loop
                    # stays free for the next chunk.
                    await hindi_queue.put((chunk_id, bytes(message)))
                    continue
                # Otherwise we're outside an AAI session and there's no
                # pending hindi chunk — drop the bytes silently.
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
                # Defensive: clear any stale chunk meta when a new
                # session starts. The mic / system-audio English flow
                # never sends hindi_chunk, but this guards against
                # weird client bugs.
                pending_chunk_meta = None
                await _run_session(client_ws, api_key)
            elif ctype == "stop":
                # No active session; nothing to do.
                continue
            elif ctype == "translate":
                # Hindi + Microphone path: the browser already did the
                # speech-to-text via the Web Speech API and is only
                # asking us to translate.
                text = (ctrl.get("text") or "").strip()
                msg_id = ctrl.get("id")
                if not text or not isinstance(msg_id, str) or not msg_id:
                    continue
                if not translator.enabled:
                    await _send_json(
                        client_ws,
                        {
                            "type": "error",
                            "message": "Translation requested, but GROQ_API_KEY "
                            "is not set on the server.",
                        },
                    )
                    continue
                task = asyncio.create_task(
                    _translate_and_send(translator, client_ws, msg_id, text),
                    name=f"translate-{msg_id}",
                )
                translation_tasks.add(task)
                task.add_done_callback(translation_tasks.discard)
            elif ctype == "hindi_chunk":
                # Hindi + System Audio path: the next message will be
                # a binary PCM blob to feed through Whisper. We just
                # remember the metadata; the binary handler above does
                # the work.
                msg_id = ctrl.get("id")
                if not isinstance(msg_id, str) or not msg_id:
                    continue
                pending_chunk_meta = ctrl
            else:
                continue
    except ConnectionClosed:
        pass
    except Exception:  # noqa: BLE001
        logger.exception("client handler crashed")
    finally:
        # Drain any in-flight translations briefly so the client gets
        # the last few results, then cancel the rest.
        if translation_tasks:
            try:
                await asyncio.wait(
                    list(translation_tasks),
                    timeout=1.0,
                    return_when=asyncio.ALL_COMPLETED,
                )
            except Exception:  # noqa: BLE001
                pass
            for t in list(translation_tasks):
                if not t.done():
                    t.cancel()

        # Stop the Hindi chunk consumer with a sentinel so any chunks
        # still in the queue are skipped (the connection is going
        # away — the client wouldn't see them anyway).
        try:
            await asyncio.wait_for(hindi_queue.put(None), timeout=0.5)
        except Exception:  # noqa: BLE001
            pass
        try:
            await asyncio.wait_for(hindi_consumer, timeout=0.5)
        except Exception:  # noqa: BLE001
            hindi_consumer.cancel()

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
