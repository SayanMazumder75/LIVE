"""
HTTP REST server for session persistence.

This is the Python equivalent of the four routes the old MeetMind
project's `server.js` exposed for transcript storage:

    POST /start-session            -> create session, return session_id
    POST /push                     -> append a finalized line of text
    GET  /transcripts              -> list saved sessions (newest first)
    GET  /transcript/:session_id   -> load one saved session

Auth was JWT-protected in the old project because MeetMind needed
multi-user SSO. The Live Translator project doesn't have user accounts
yet, so we drop the `protect` middleware and store sessions without
`userId`. The schema still tolerates a `userId` field, so old-project
records with one are readable.

We use **aiohttp** because the rest of the backend is pure asyncio and
already running an event loop for the WebSocket server. aiohttp can
share that loop without needing a separate worker process the way
uvicorn would.

The HTTP server runs alongside the WebSocket server in the same
process; see `main.py`.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any

from aiohttp import web

import db

logger = logging.getLogger("http_server")


# ── CORS ─────────────────────────────────────────────────────────────────────
#
# The Vite dev server runs on a different origin (http://localhost:5173)
# from the API server (http://localhost:8000), so the browser will
# reject API calls without CORS headers. We add a permissive set of
# headers — same scope the old Express app used via `cors()` with no
# config (allow-all).


@web.middleware
async def cors_middleware(request: web.Request, handler):
    if request.method == "OPTIONS":
        # Preflight — answer it directly so the actual handler isn't
        # invoked for non-routes.
        return _with_cors(web.Response(status=204))
    try:
        response = await handler(request)
    except web.HTTPException as ex:
        return _with_cors(ex)
    return _with_cors(response)


def _with_cors(resp: web.StreamResponse) -> web.StreamResponse:
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    return resp


# ── helpers ──────────────────────────────────────────────────────────────────


def _json_error(status: int, message: str) -> web.Response:
    return web.json_response({"error": message}, status=status)


def _503_if_no_db() -> web.Response | None:
    """Return a friendly 503 when MongoDB isn't configured."""
    if db.is_enabled():
        return None
    err = db.connection_error()
    if err:
        # Real connection attempt failed — include the classified
        # error so the frontend banner can tell the user exactly what
        # to fix (auth, IP allowlist, malformed URI, etc.).
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
    """
    Match the old project's `session_id || Date.now().toString()`
    pattern — millisecond-since-epoch as a string. We append a short
    random suffix so two sessions started in the same millisecond
    (mic + system race on some clients) don't collide on the
    unique-key index.
    """
    return f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"


# ── routes ───────────────────────────────────────────────────────────────────


async def post_start_session(request: web.Request) -> web.Response:
    """
    POST /start-session

    Body (optional): {"session_id": "...", "userId": "..."}

    Mirrors the old:
        const session_id = req.body?.session_id || Date.now().toString();
        await Session.create({ session_id, userId: req.user.id });
        res.json({ success: true, session_id });
    """
    if (resp := _503_if_no_db()) is not None:
        return resp

    body = await _read_json(request)
    session_id = (
        (body.get("session_id") if isinstance(body, dict) else None) or _new_session_id()
    )
    user_id = body.get("userId") if isinstance(body, dict) else None

    try:
        await db.create_session(session_id, user_id=user_id)
    except ValueError as e:
        # Duplicate session_id — same case the old code didn't guard
        # against because Mongoose would just throw. We surface it as
        # 409 so the client can retry with a new id.
        return _json_error(409, str(e))
    except db.MongoNotConfigured as e:
        return _json_error(503, str(e))
    except Exception as e:  # noqa: BLE001
        logger.exception("start-session failed")
        return _json_error(500, str(e))

    return web.json_response({"success": True, "session_id": session_id})


async def get_start_session(request: web.Request) -> web.Response:
    """
    GET /start-session

    Convenience equivalent of the old GET handler that just creates a
    fresh session_id every call.
    """
    if (resp := _503_if_no_db()) is not None:
        return resp

    session_id = _new_session_id()
    try:
        await db.create_session(session_id)
    except Exception as e:  # noqa: BLE001
        logger.exception("GET start-session failed")
        return _json_error(500, str(e))
    return web.json_response({"success": True, "session_id": session_id})


async def post_push(request: web.Request) -> web.Response:
    """
    POST /push

    Body: {"session_id": "...", "text": "..."}

    Mirrors the old:
        const { session_id, text } = req.body;
        if (!session_id || !text) return 400;
        const session = await Session.findOne({ session_id });
        if (!session) return 404;
        await Session.findOneAndUpdate(
            { session_id },
            { text: session.text + text + "\n" }
        );

    Caller is responsible for formatting the line as
    `[SOURCE] [HH:MM:SS] message`. We don't restamp it server-side so
    the old format stays bit-for-bit identical.

    Live Translator only POSTs *finalized* transcripts here — interim
    turns are filtered on the frontend before /push is called. That's
    the same invariant the old project had (it only persisted after
    flushBuffer, never during a live turn).
    """
    if (resp := _503_if_no_db()) is not None:
        return resp

    body = await _read_json(request)
    if not isinstance(body, dict):
        return _json_error(400, "missing fields")

    session_id = (body.get("session_id") or "").strip() if isinstance(body.get("session_id"), str) else ""
    text = body.get("text")
    if not session_id or not isinstance(text, str) or not text:
        return _json_error(400, "missing fields")

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
    GET /transcripts

    Returns a list of session metadata entries:
        [{ id, label, createdAt }, ...]

    Mirrors the old user-scoped listing. With no auth in the current
    project we list everyone's sessions; if `?userId=` is supplied as a
    query param we filter on it for compatibility with old records.
    """
    if (resp := _503_if_no_db()) is not None:
        return resp

    user_id = request.query.get("userId") or None

    try:
        items = await db.list_sessions(user_id=user_id)
    except db.MongoNotConfigured as e:
        return _json_error(503, str(e))
    except Exception as e:  # noqa: BLE001
        logger.exception("transcripts list failed")
        return _json_error(500, str(e))
    return web.json_response(items)


async def get_transcript(request: web.Request) -> web.Response:
    """
    GET /transcript/{session_id}

    Returns the saved transcript text:
        { "text": "..." }

    Mirrors the old:
        const session = await Session.findOne({ session_id, ... });
        if (!session) return 403;
        res.json({ text: session.text });

    The old code returned 403 when the session didn't belong to the
    user; with no auth in the current project a missing session is
    just a 404.
    """
    if (resp := _503_if_no_db()) is not None:
        return resp

    session_id = request.match_info.get("session_id", "").strip()
    if not session_id:
        return _json_error(400, "session_id required")

    try:
        text = await db.get_transcript(session_id)
    except db.MongoNotConfigured as e:
        return _json_error(503, str(e))
    except Exception as e:  # noqa: BLE001
        logger.exception("transcript fetch failed")
        return _json_error(500, str(e))

    if text is None:
        return _json_error(404, "session not found")
    return web.json_response({"text": text})


async def get_root(_request: web.Request) -> web.Response:
    """Liveness probe — same shape as the old `app.get("/")`."""
    return web.json_response(
        {
            "status": "ok",
            "service": "AI Transcriber session API",
            "persistence": "enabled" if db.is_enabled() else "disabled",
            "diagnostics": db.diagnostics(),
        }
    )


# ── helpers ──────────────────────────────────────────────────────────────────


async def _read_json(request: web.Request) -> Any:
    """Read JSON body. Returns {} for empty/invalid bodies."""
    if request.content_length in (0, None):
        # POST /start-session with no body is legal — match old project.
        return {}
    try:
        return await request.json()
    except Exception:  # noqa: BLE001
        return {}


# ── public entry point ───────────────────────────────────────────────────────


def build_app() -> web.Application:
    """Build the aiohttp Application with all routes registered."""
    app = web.Application(middlewares=[cors_middleware])
    app.router.add_get("/", get_root)
    app.router.add_post("/start-session", post_start_session)
    app.router.add_get("/start-session", get_start_session)
    app.router.add_post("/push", post_push)
    app.router.add_get("/transcripts", get_transcripts)
    app.router.add_get("/transcript/{session_id}", get_transcript)
    return app


async def start_http_server(host: str = "0.0.0.0", port: int = 8000) -> web.AppRunner:
    """
    Start the HTTP REST server. Returns the AppRunner so callers can
    cleanly shut it down. The server runs forever in the same event
    loop as the WebSocket server — see main.py.
    """
    app = build_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    logger.info("session API listening on http://%s:%d", host, port)
    return runner
