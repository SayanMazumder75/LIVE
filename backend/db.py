"""
MongoDB session persistence.

This module is the Python equivalent of the Mongoose connection +
`sessionSchema` block from the old MeetMind project's `server.js`.
The contract is preserved on purpose so the four legacy endpoints
(/start-session, /push, /transcripts, /transcript/:session_id) keep
working exactly as before:

    sessionSchema = {
        session_id    : String, required, unique
        userId        : String, optional   (kept for migration safety)
        text          : String, default ""
        audioUrl      : String, default ""
        audioDuration : Number, default 0
        createdAt     : Date,   default Date.now
    }

We use **motor** (the official async MongoDB driver) because the rest
of the backend is asyncio-based. The connect-once-and-share pattern
mirrors `mongoose.connect(...)` at the top of the old `server.js`.

Environment
-----------
    MONGO_URI  : full Atlas / self-hosted connection string. If unset,
                 the persistence layer is *disabled* — start_db()
                 returns successfully without connecting and every
                 helper raises `MongoNotConfigured` so callers can
                 surface a clear 503 to the client. The rest of the
                 app (audio + translation pipelines) keeps working.
    MONGO_DB   : optional database name override. If omitted, motor
                 uses whatever database is in the connection string,
                 falling back to "meetmind" — same default as the old
                 project.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger("db")


class MongoNotConfigured(RuntimeError):
    """Raised when a route needs Mongo but MONGO_URI is unset."""


# ── module-level singletons (set by start_db) ────────────────────────────────
_client: Any = None  # motor.motor_asyncio.AsyncIOMotorClient | None
_db: Any = None  # motor.motor_asyncio.AsyncIOMotorDatabase | None
_sessions: Any = None  # collection handle


def is_enabled() -> bool:
    """True when start_db() successfully connected."""
    return _sessions is not None


async def start_db() -> None:
    """
    Connect to MongoDB once at process startup. Mirrors the
    `mongoose.connect(process.env.MONGO_URI)` block in the old
    server.js, including the same "connected" / "error" log lines.

    Never raises. If MONGO_URI is missing the persistence layer is
    simply disabled — every route that needs it returns 503 with a
    clear message, but the WebSocket transcription path keeps working.
    """
    global _client, _db, _sessions

    uri = os.getenv("MONGO_URI", "").strip()
    if not uri:
        logger.warning(
            "MONGO_URI is not set; session persistence is disabled. Set "
            "MONGO_URI in backend/.env to enable /start-session, /push, "
            "/transcripts, and /transcript/:session_id."
        )
        return

    try:
        # Imported lazily so a missing motor install only breaks the
        # persistence layer, not the WebSocket server.
        from motor.motor_asyncio import AsyncIOMotorClient
    except ImportError:
        logger.warning(
            "MONGO_URI is set but `motor` is not installed — session "
            "persistence is disabled. Run `pip install motor`."
        )
        return

    db_name = os.getenv("MONGO_DB", "").strip() or None

    try:
        client = AsyncIOMotorClient(uri, serverSelectionTimeoutMS=5000)
        # Force the driver to actually open a connection now so the
        # log line below is honest (mongoose's `.then(() => log)` does
        # the same thing).
        await client.admin.command("ping")
    except Exception as e:  # noqa: BLE001
        logger.error("MongoDB error: %s", e)
        return

    if db_name:
        db = client[db_name]
    else:
        # If the URI embeds a default database use it; otherwise fall
        # back to "meetmind" so old-project records remain accessible
        # without an explicit MONGO_DB override.
        db = client.get_default_database(default="meetmind")

    sessions = db["sessions"]

    # `session_id` is unique in the old schema — keep that invariant.
    # If the index already exists with the same shape this is a no-op.
    try:
        await sessions.create_index("session_id", unique=True)
        await sessions.create_index("createdAt")
        await sessions.create_index("userId")
    except Exception as e:  # noqa: BLE001
        # Don't fail startup just because an index couldn't be created;
        # log it and keep going.
        logger.warning("Could not ensure session indexes: %s", e)

    _client = client
    _db = db
    _sessions = sessions
    logger.info("MongoDB connected (db=%s, collection=sessions)", db.name)


async def close_db() -> None:
    """Close the Mongo client cleanly on shutdown."""
    global _client, _db, _sessions
    client = _client
    _client = None
    _db = None
    _sessions = None
    if client is not None:
        try:
            client.close()
        except Exception:  # noqa: BLE001
            pass


def _require_sessions():
    if _sessions is None:
        raise MongoNotConfigured(
            "MongoDB is not configured. Set MONGO_URI in backend/.env "
            "to enable session persistence."
        )
    return _sessions


# ── Session "schema" helpers ──────────────────────────────────────────────────
#
# motor doesn't have a Mongoose-style schema layer, so we centralise the
# document shape here. Every write goes through `_session_doc()` /
# `_serialize_session()` so the on-disk format stays identical to what
# the old project produced — meaning records written by either project
# can be read by the other.


def _session_doc(session_id: str, user_id: Optional[str] = None) -> dict:
    """Build a fresh session document with default field values."""
    doc: dict = {
        "session_id": session_id,
        "text": "",
        "audioUrl": "",
        "audioDuration": 0,
        "createdAt": datetime.now(timezone.utc),
    }
    if user_id:
        doc["userId"] = user_id
    return doc


def _serialize_session(doc: dict) -> dict:
    """Return a JSON-safe copy of a session document."""
    if not doc:
        return {}
    out = {
        "session_id": doc.get("session_id"),
        "text": doc.get("text", "") or "",
        "audioUrl": doc.get("audioUrl", "") or "",
        "audioDuration": doc.get("audioDuration", 0) or 0,
    }
    created = doc.get("createdAt")
    if isinstance(created, datetime):
        # ISO string is the most portable cross-language wire format.
        out["createdAt"] = created.isoformat()
    elif created is not None:
        out["createdAt"] = str(created)
    user_id = doc.get("userId")
    if user_id:
        out["userId"] = user_id
    return out


# ── CRUD operations used by the HTTP routes ──────────────────────────────────
#
# Every method here is the Python translation of the matching block in
# the old server.js — same field names, same defaults, same ordering.


async def create_session(
    session_id: str, user_id: Optional[str] = None
) -> dict:
    """
    Equivalent of `await Session.create({ session_id, userId })`.

    Returns the serialized session. Raises `ValueError` on duplicate
    session_id so the HTTP layer can map it to a 409.
    """
    sessions = _require_sessions()
    doc = _session_doc(session_id, user_id=user_id)
    try:
        await sessions.insert_one(doc)
    except Exception as e:  # noqa: BLE001
        # motor raises pymongo.errors.DuplicateKeyError; catch by
        # message to avoid a hard import dependency on pymongo.
        if "duplicate key" in str(e).lower() or "E11000" in str(e):
            raise ValueError(f"Session '{session_id}' already exists") from e
        raise
    return _serialize_session(doc)


async def find_session(session_id: str) -> Optional[dict]:
    """Equivalent of `Session.findOne({ session_id })`."""
    sessions = _require_sessions()
    doc = await sessions.find_one({"session_id": session_id})
    return _serialize_session(doc) if doc else None


async def append_text(session_id: str, line: str) -> bool:
    """
    Equivalent of:
        const session = await Session.findOne({ session_id });
        if (!session) return 404;
        await Session.findOneAndUpdate(
            { session_id },
            { text: session.text + line + "\n" }
        );

    The old code did read-modify-write; we do the same atomically with
    `$set` after the read so concurrent appends from the same session
    don't clobber each other in practice. Returns True if the session
    existed (and was updated), False if it didn't exist.
    """
    sessions = _require_sessions()
    # Use $concat in a pipeline update so simultaneous /push calls from
    # mic + system sockets append cleanly without the race that the old
    # JS read-then-write had.
    result = await sessions.update_one(
        {"session_id": session_id},
        [
            {
                "$set": {
                    "text": {
                        "$concat": [
                            {"$ifNull": ["$text", ""]},
                            line,
                            "\n",
                        ]
                    }
                }
            }
        ],
    )
    return result.matched_count > 0


async def list_sessions(user_id: Optional[str] = None) -> list[dict]:
    """
    Equivalent of:
        Session.find({ userId })
               .sort({ createdAt: -1 })
               .select("session_id createdAt")

    When `user_id` is None we return *all* sessions (useful for the
    Live Translator project, which doesn't currently have auth — same
    behaviour as old-project legacy records that have no userId).
    """
    sessions = _require_sessions()
    query: dict = {}
    if user_id:
        query["userId"] = user_id
    cursor = (
        sessions.find(query, {"session_id": 1, "createdAt": 1})
        .sort("createdAt", -1)
    )
    out: list[dict] = []
    async for doc in cursor:
        created = doc.get("createdAt")
        if isinstance(created, datetime):
            created_iso = created.isoformat()
            label_when = created.astimezone().strftime("%Y-%m-%d %H:%M")
        else:
            created_iso = str(created) if created is not None else ""
            label_when = created_iso
        out.append(
            {
                "id": doc.get("session_id"),
                "label": f"Session {label_when}",
                "createdAt": created_iso,
            }
        )
    return out


async def get_transcript(session_id: str) -> Optional[str]:
    """
    Equivalent of `Session.findOne({ session_id })` followed by
    returning `{ text: session.text }`. Returns None when the session
    does not exist.
    """
    sessions = _require_sessions()
    doc = await sessions.find_one({"session_id": session_id}, {"text": 1})
    if not doc:
        return None
    return doc.get("text", "") or ""
