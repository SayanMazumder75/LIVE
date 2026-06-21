"""
HTTP REST server for session persistence.

Auth model
----------
Every session-related endpoint now requires a valid MeetMind JWT:

    Authorization: Bearer <token>

The token is verified by auth.require_auth(), which mirrors the old
MeetMind Node.js `protect` middleware.  On success it returns the
caller's user_id (decoded["id"]).  On failure it raises HTTP 401.

Ownership invariant
-------------------
Every new session is tagged with the creating user's userId.  All
subsequent reads, writes, and deletes verify that the authenticated
user's id matches the document's userId field — a hard equality check
with no $or fallback.  Old records that lack a userId are inaccessible
through this API; they are never returned or mutated.

Public endpoint
---------------
GET /  (liveness probe) — unauthenticated, returns service diagnostics.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any

from aiohttp import web

import auth
import db
import cloudinary_service

logger = logging.getLogger("http_server")


# ── CORS ─────────────────────────────────────────────────────────────────────

@web.middleware
async def cors_middleware(request: web.Request, handler):
    if request.method == "OPTIONS":
        return _with_cors(web.Response(status=204))
    try:
        response = await handler(request)
    except web.HTTPException as ex:
        return _with_cors(ex)
    return _with_cors(response)


def _with_cors(resp: web.StreamResponse) -> web.StreamResponse:
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    return resp


# ── helpers ───────────────────────────────────────────────────────────────────

def _json_error(status: int, message: str) -> web.Response:
    return web.json_response({"error": message}, status=status)


def _503_if_no_db() -> web.Response | None:
    if db.is_enabled():
        return None
    err = db.connection_error()
    if err:
        message = f"Session persistence is disabled. {err}"
    else:
        message = (
            "Session persistence is disabled. Set MONGO_URI in backend/.env "
            "and restart the server to enable /start-session, /push, "
            "/transcripts, and /transcript/:session_id."
        )
    return web.json_response(
        {"error": message, "diagnostics": db.diagnostics()},
        status=503,
    )


def _new_session_id() -> str:
    return f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"


# ── routes ────────────────────────────────────────────────────────────────────

async def post_start_session(request: web.Request) -> web.Response:
    """
    POST /start-session  [protected]

    Creates a new session owned by the authenticated user.
    Body (optional): {"session_id": "..."}
    """
    user_id = await auth.require_auth(request)

    if (resp := _503_if_no_db()) is not None:
        return resp

    body = await _read_json(request)
    session_id = (
        (body.get("session_id") if isinstance(body, dict) else None)
        or _new_session_id()
    )

    try:
        await db.create_session(session_id, user_id=user_id)
    except ValueError as e:
        return _json_error(409, str(e))
    except db.MongoNotConfigured as e:
        return _json_error(503, str(e))
    except Exception as e:  # noqa: BLE001
        logger.exception("start-session failed")
        return _json_error(500, str(e))

    return web.json_response({"success": True, "session_id": session_id})


async def get_start_session(request: web.Request) -> web.Response:
    """
    GET /start-session  [protected]

    Convenience endpoint — creates a fresh session for the caller.
    """
    user_id = await auth.require_auth(request)

    if (resp := _503_if_no_db()) is not None:
        return resp

    session_id = _new_session_id()
    try:
        await db.create_session(session_id, user_id=user_id)
    except Exception as e:  # noqa: BLE001
        logger.exception("GET start-session failed")
        return _json_error(500, str(e))

    return web.json_response({"success": True, "session_id": session_id})


async def post_push(request: web.Request) -> web.Response:
    """
    POST /push  [protected]

    Body: {"session_id": "...", "text": "..."}

    Appends a finalised transcript line to the session.
    Ownership is verified before the write — users cannot push to
    sessions they don't own.
    """
    user_id = await auth.require_auth(request)

    if (resp := _503_if_no_db()) is not None:
        return resp

    body = await _read_json(request)
    if not isinstance(body, dict):
        return _json_error(400, "missing fields")

    session_id = (
        body.get("session_id", "").strip()
        if isinstance(body.get("session_id"), str)
        else ""
    )
    text = body.get("text")
    if not session_id or not isinstance(text, str) or not text:
        return _json_error(400, "missing fields")

    # Ownership check — returns None for missing OR wrong owner
    session = await db.find_session_for_user(session_id, user_id)
    if session is None:
        return _json_error(404, "session not found")

    try:
        ok = await db.append_text(session_id, text)
    except db.MongoNotConfigured as e:
        return _json_error(503, str(e))
    except Exception as e:  # noqa: BLE001
        logger.exception("push failed")
        return _json_error(500, str(e))

    if not ok:
        return _json_error(404, "session not found")
    return web.json_response({"ok": True})


async def get_transcripts(request: web.Request) -> web.Response:
    """
    GET /transcripts  [protected]

    Returns only the authenticated user's sessions, newest first.
    No other user's data is ever included in the response.
    """
    user_id = await auth.require_auth(request)

    if (resp := _503_if_no_db()) is not None:
        return resp

    try:
        items = await db.list_sessions(user_id)
    except db.MongoNotConfigured as e:
        return _json_error(503, str(e))
    except Exception as e:  # noqa: BLE001
        logger.exception("transcripts list failed")
        return _json_error(500, str(e))

    return web.json_response(items)


async def get_transcript(request: web.Request) -> web.Response:
    """
    GET /transcript/{session_id}  [protected]

    Returns the full session (transcript + insights + audio) only if it
    belongs to the authenticated user.  Returns 403 for sessions that
    exist but belong to someone else — matching the old MeetMind
    behaviour — so the caller cannot distinguish "not mine" from "wrong
    id" and cannot enumerate other users' session ids.
    """
    user_id = await auth.require_auth(request)

    if (resp := _503_if_no_db()) is not None:
        return resp

    session_id = request.match_info.get("session_id", "").strip()
    if not session_id:
        return _json_error(400, "session_id required")

    try:
        full = await db.find_session_for_user(session_id, user_id)
    except db.MongoNotConfigured as e:
        return _json_error(503, str(e))
    except Exception as e:  # noqa: BLE001
        logger.exception("transcript fetch failed")
        return _json_error(500, str(e))

    if full is None:
        return _json_error(404, "session not found")

    response: dict = {"text": full.get("text", "") or ""}
    if "insights" in full and full["insights"] is not None:
        response["insights"] = full["insights"]
    if full.get("audioUrl"):
        response["audioUrl"] = full["audioUrl"]
    if full.get("audioDuration"):
        response["audioDuration"] = full["audioDuration"]
    return web.json_response(response)


async def post_insights(request: web.Request) -> web.Response:
    """
    POST /insights  [protected]

    Body: {"session_id": "...", "insights": { ...intelligence object... }}

    Saves AI Meeting Intelligence into the caller's session.
    Returns 403/404 if the session doesn't exist or isn't owned by
    the authenticated user.
    """
    user_id = await auth.require_auth(request)

    if (resp := _503_if_no_db()) is not None:
        return resp

    body = await _read_json(request)
    if not isinstance(body, dict):
        return _json_error(400, "missing fields")

    raw_id = body.get("session_id")
    session_id = raw_id.strip() if isinstance(raw_id, str) else ""
    insights = body.get("insights")
    if not session_id or not isinstance(insights, dict):
        return _json_error(400, "session_id and insights object required")

    # Ownership check
    session = await db.find_session_for_user(session_id, user_id)
    if session is None:
        return _json_error(404, "session not found")

    try:
        ok = await db.save_insights(session_id, insights)
    except db.MongoNotConfigured as e:
        return _json_error(503, str(e))
    except Exception as e:  # noqa: BLE001
        logger.exception("save insights failed")
        return _json_error(500, str(e))

    if not ok:
        return _json_error(404, "session not found")
    return web.json_response({"ok": True})


async def delete_transcript(request: web.Request) -> web.Response:
    """
    DELETE /transcript/{session_id}  [protected]

    Deletes the session (transcript + insights + audio) only if it
    belongs to the authenticated user.
    """
    user_id = await auth.require_auth(request)

    if (resp := _503_if_no_db()) is not None:
        return resp

    session_id = request.match_info.get("session_id", "").strip()
    if not session_id:
        return _json_error(400, "session_id required")

    # Ownership check — prevents cross-user deletions
    session = await db.find_session_for_user(session_id, user_id)
    if session is None:
        return _json_error(404, "session not found")

    try:
        ok = await db.delete_session(session_id)
    except db.MongoNotConfigured as e:
        return _json_error(503, str(e))
    except Exception as e:  # noqa: BLE001
        logger.exception("delete session failed")
        return _json_error(500, str(e))

    if not ok:
        return _json_error(404, "session not found")
    return web.json_response({"ok": True})


async def post_upload_audio(request: web.Request) -> web.Response:
    """
    POST /upload-audio (multipart)  [protected]

    Form fields:
      - session_id : must be owned by the authenticated user
      - audio      : WebM/Opus blob from MediaRecorder

    Uploads to Cloudinary then stores audioUrl + audioDuration on the
    session document.  The session ownership is verified before the
    Cloudinary upload so stale / cross-user POSTs don't leak storage.
    """
    user_id = await auth.require_auth(request)

    if (resp := _503_if_no_db()) is not None:
        return resp

    if not cloudinary_service.is_configured():
        return web.json_response(
            {
                "error": (
                    "Audio recording is disabled — "
                    + cloudinary_service.configuration_error()
                ),
                "diagnostics": cloudinary_service.diagnostics(),
            },
            status=503,
        )

    try:
        reader = await request.multipart()
    except Exception as e:  # noqa: BLE001
        return _json_error(400, f"could not read multipart body: {e}")

    session_id = ""
    audio_bytes: bytes = b""

    async for part in reader:
        if part.name == "session_id":
            session_id = (await part.text()).strip()
        elif part.name == "audio":
            chunks: list[bytes] = []
            while True:
                chunk = await part.read_chunk(size=64 * 1024)
                if not chunk:
                    break
                chunks.append(chunk)
            audio_bytes = b"".join(chunks)
        else:
            await part.read()

    if not session_id:
        return _json_error(400, "session_id required")
    if not audio_bytes:
        return _json_error(400, "audio file required")

    # Ownership check before paying for the Cloudinary upload
    existing = await db.find_session_for_user(session_id, user_id)
    if existing is None:
        return _json_error(404, "session not found")

    try:
        upload = await cloudinary_service.upload_audio(
            audio_bytes, public_id=session_id
        )
    except RuntimeError as e:
        return web.json_response({"error": str(e)}, status=503)
    except Exception as e:  # noqa: BLE001
        logger.exception("cloudinary upload failed")
        return _json_error(500, f"upload failed: {e}")

    audio_url = upload.get("url") or ""
    audio_duration = int(upload.get("duration") or 0)
    if not audio_url:
        return _json_error(500, "Cloudinary returned no URL")

    try:
        await db.update_audio(session_id, audio_url, audio_duration)
    except Exception as e:  # noqa: BLE001
        logger.exception("db.update_audio failed")
        return _json_error(500, f"db update failed: {e}")

    return web.json_response(
        {
            "audioUrl": audio_url,
            "audioDuration": audio_duration,
        }
    )


async def get_root(_request: web.Request) -> web.Response:
    """Liveness probe — unauthenticated."""
    return web.json_response(
        {
            "status": "ok",
            "service": "AI Transcriber session API",
            "persistence": "enabled" if db.is_enabled() else "disabled",
            "diagnostics": db.diagnostics(),
            "recording": cloudinary_service.diagnostics(),
        }
    )


# ── helpers ───────────────────────────────────────────────────────────────────

async def _read_json(request: web.Request) -> Any:
    if request.content_length in (0, None):
        return {}
    try:
        return await request.json()
    except Exception:  # noqa: BLE001
        return {}


# ── public entry point ────────────────────────────────────────────────────────

def build_app() -> web.Application:
    app = web.Application(
        middlewares=[cors_middleware],
        client_max_size=100 * 1024 * 1024,
    )
    app.router.add_get("/", get_root)
    app.router.add_post("/start-session", post_start_session)
    app.router.add_get("/start-session", get_start_session)
    app.router.add_post("/push", post_push)
    app.router.add_post("/insights", post_insights)
    app.router.add_post("/upload-audio", post_upload_audio)
    app.router.add_get("/transcripts", get_transcripts)
    app.router.add_get("/transcript/{session_id}", get_transcript)
    app.router.add_delete("/transcript/{session_id}", delete_transcript)
    return app


async def start_http_server(host: str = "0.0.0.0", port: int = 8000) -> web.AppRunner:
    app = build_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    logger.info("session API listening on http://%s:%d", host, port)
    return runner