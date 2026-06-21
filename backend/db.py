"""
MongoDB session persistence.

This module is the Python equivalent of the Mongoose connection +
`sessionSchema` block from the old MeetMind project's `server.js`.
The contract is preserved on purpose so the four legacy endpoints
(/start-session, /push, /transcripts, /transcript/:session_id) keep
working exactly as before:

    sessionSchema = {
        session_id    : String, required, unique
        userId        : String, required   (set on every new session)
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
_db: Any = None      # motor.motor_asyncio.AsyncIOMotorDatabase | None
_sessions: Any = None  # collection handle

_last_error: str = ""
_uri_was_set: bool = False
_db_name: str = ""


def is_enabled() -> bool:
    """True when start_db() successfully connected."""
    return _sessions is not None


def connection_error() -> str:
    return _last_error


def diagnostics() -> dict:
    return {
        "enabled": is_enabled(),
        "mongo_uri_set": _uri_was_set,
        "mongo_db": _db_name,
        "error": _last_error,
    }


def _classify_error(exc: Exception) -> str:
    msg = str(exc) or exc.__class__.__name__
    low = msg.lower()
    name = exc.__class__.__name__

    if "authentication failed" in low or "auth failed" in low or "bad auth" in low:
        return (
            "Authentication failed. Check the username/password in MONGO_URI. "
            "If the password contains '@', ':', '/', '#' or '+', percent-encode "
            "them (e.g. '@' -> '%40'). Original: " + msg
        )
    if "ip" in low and ("not allowed" in low or "whitelist" in low or "allowlist" in low):
        return (
            "MongoDB Atlas rejected this IP. In the Atlas dashboard go to "
            "Network Access and add your current IP (or 0.0.0.0/0 for testing). "
            "Original: " + msg
        )
    if name == "ServerSelectionTimeoutError" or "server selection timeout" in low:
        return (
            "Could not reach the MongoDB server within 5s. Likely causes: (1) "
            "Atlas IP allowlist is blocking this machine, (2) the cluster is "
            "paused, (3) DNS / network. Original: " + msg
        )
    if "configurationerror" in name.lower() or "invalid uri" in low or "must include" in low:
        return (
            "MONGO_URI is malformed. Expected something like "
            "'mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority'. "
            "Original: " + msg
        )
    if "name or service not known" in low or "nodename" in low or "getaddrinfo" in low:
        return (
            "DNS lookup for the MongoDB host failed. Check the cluster hostname "
            "in MONGO_URI. Original: " + msg
        )
    return msg


async def start_db() -> None:
    """
    Connect to MongoDB once at process startup.
    Never raises — persistence is simply disabled if MONGO_URI is missing.
    """
    global _client, _db, _sessions, _last_error, _uri_was_set, _db_name

    uri = os.getenv("MONGO_URI", "").strip()
    _uri_was_set = bool(uri)
    if not uri:
        _last_error = "MONGO_URI is not set in backend/.env"
        logger.warning(
            "MONGO_URI is not set; session persistence is disabled."
        )
        return

    logger.info("MONGO_URI loaded: %s", _redact_uri(uri))

    try:
        from motor.motor_asyncio import AsyncIOMotorClient
    except ImportError:
        _last_error = (
            "`motor` is not installed. Run `pip install motor` "
            "(or `pip install -r backend/requirements.txt`) and restart."
        )
        logger.warning("MONGO_URI is set but `motor` is not installed.")
        return

    db_name_env = os.getenv("MONGO_DB", "").strip() or None

    try:
        client = AsyncIOMotorClient(uri, serverSelectionTimeoutMS=5000)
        await client.admin.command("ping")
    except Exception as e:  # noqa: BLE001
        _last_error = _classify_error(e)
        logger.error("MongoDB error: %s", _last_error)
        return

    if db_name_env:
        db = client[db_name_env]
    else:
        db = client.get_default_database(default="meetmind")

    sessions = db["sessions"]

    try:
        await sessions.create_index("session_id", unique=True)
        await sessions.create_index("createdAt")
        await sessions.create_index("userId")
    except Exception as e:  # noqa: BLE001
        logger.warning("Could not ensure session indexes: %s", e)

    _client = client
    _db = db
    _sessions = sessions
    _db_name = db.name
    _last_error = ""
    logger.info("MongoDB connected (db=%s, collection=sessions)", db.name)


def _redact_uri(uri: str) -> str:
    try:
        scheme, rest = uri.split("://", 1)
        if "@" in rest:
            creds, hostpart = rest.split("@", 1)
            if ":" in creds:
                user, _ = creds.split(":", 1)
                return f"{scheme}://{user}:***@{hostpart}"
            return f"{scheme}://{creds}@{hostpart}"
        return uri
    except Exception:  # noqa: BLE001
        return "<unparseable URI>"


async def close_db() -> None:
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

def _session_doc(session_id: str, user_id: str) -> dict:
    """
    Build a fresh session document. userId is now required — every
    session created through the authenticated API has an owner.
    """
    return {
        "session_id": session_id,
        "userId": user_id,
        "text": "",
        "audioUrl": "",
        "audioDuration": 0,
        "createdAt": datetime.now(timezone.utc),
    }


def _to_utc_aware(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _serialize_session(doc: dict) -> dict:
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
        out["createdAt"] = _to_utc_aware(created).isoformat()
    elif created is not None:
        out["createdAt"] = str(created)
    user_id = doc.get("userId")
    if user_id:
        out["userId"] = user_id
    if "insights" in doc and doc["insights"] is not None:
        out["insights"] = doc["insights"]
    return out


# ── CRUD operations ───────────────────────────────────────────────────────────

async def create_session(session_id: str, user_id: str) -> dict:
    """
    Create a new session owned by `user_id`.

    Unlike the old schema where userId was optional, every session
    created by the authenticated API must have an owner. Raises
    ValueError on duplicate session_id (→ HTTP 409).
    """
    sessions = _require_sessions()
    doc = _session_doc(session_id, user_id)
    try:
        await sessions.insert_one(doc)
    except Exception as e:  # noqa: BLE001
        if "duplicate key" in str(e).lower() or "E11000" in str(e):
            raise ValueError(f"Session '{session_id}' already exists") from e
        raise
    return _serialize_session(doc)


async def find_session(session_id: str) -> Optional[dict]:
    """
    Load a session document by session_id with NO ownership check.
    Internal use only (e.g. to confirm existence before a Cloudinary
    upload). All public-facing routes must use find_session_for_user().
    """
    sessions = _require_sessions()
    doc = await sessions.find_one({"session_id": session_id})
    return _serialize_session(doc) if doc else None


async def find_session_for_user(
    session_id: str, user_id: str
) -> Optional[dict]:
    """
    Load a session document only when it belongs to `user_id`.

    The query is a hard equality check — { session_id, userId: user_id }.
    Old records that have no userId field or a different userId are
    treated as non-existent from the caller's perspective (returns None),
    so they are never exposed through the API regardless of the
    session_id being guessed correctly.

    This is the ownership-safe replacement for find_session() in all
    HTTP route handlers.
    """
    sessions = _require_sessions()
    doc = await sessions.find_one(
        {"session_id": session_id, "userId": user_id}
    )
    return _serialize_session(doc) if doc else None


async def append_text(session_id: str, line: str) -> bool:
    """
    Atomically append `line + "\\n"` to the session's text field.

    NOTE: callers are responsible for verifying ownership with
    find_session_for_user() before calling this — this helper does
    not re-check userId so it can be shared between authenticated
    routes and any future internal/admin paths.

    Returns True if the session existed (and was updated).
    """
    sessions = _require_sessions()
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


async def list_sessions(user_id: str) -> list[dict]:
    """
    Return session metadata for sessions owned by `user_id`, newest
    first.

    The query is a strict equality match on userId — old records
    without a userId field are never returned, so a new user cannot
    accidentally inherit orphaned data.
    """
    sessions = _require_sessions()
    cursor = (
        sessions.find(
            {"userId": user_id},
            {"session_id": 1, "createdAt": 1},
        )
        .sort("createdAt", -1)
    )
    out: list[dict] = []
    async for doc in cursor:
        created = doc.get("createdAt")
        if isinstance(created, datetime):
            created_aware = _to_utc_aware(created)
            created_iso = created_aware.isoformat()
            label_when = created_aware.strftime("%Y-%m-%d %H:%M UTC")
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
    """Internal helper — no ownership check. Prefer get_session_full."""
    sessions = _require_sessions()
    doc = await sessions.find_one({"session_id": session_id}, {"text": 1})
    if not doc:
        return None
    return doc.get("text", "") or ""


async def get_session_full(session_id: str) -> Optional[dict]:
    """
    Load the entire session document with NO ownership check.
    Internal use only. Public routes use find_session_for_user().
    """
    sessions = _require_sessions()
    doc = await sessions.find_one({"session_id": session_id})
    if not doc:
        return None
    return _serialize_session(doc)


async def save_insights(session_id: str, insights: dict) -> bool:
    """
    Persist AI Meeting Intelligence into the existing session document.
    Ownership must be verified by the caller before invoking this.
    Returns True if the session existed and was updated.
    """
    sessions = _require_sessions()
    result = await sessions.update_one(
        {"session_id": session_id},
        {"$set": {"insights": insights}},
    )
    return result.matched_count > 0


async def update_audio(
    session_id: str, audio_url: str, audio_duration: int
) -> bool:
    """
    Persist audio recording URL + duration onto the existing session.
    Ownership must be verified by the caller before invoking this.
    Returns True if the session existed and was updated.
    """
    sessions = _require_sessions()
    result = await sessions.update_one(
        {"session_id": session_id},
        {
            "$set": {
                "audioUrl": audio_url or "",
                "audioDuration": int(audio_duration or 0),
            }
        },
    )
    return result.matched_count > 0


async def delete_session(session_id: str) -> bool:
    """
    Remove a session document. Ownership must be verified by the caller.
    Returns True if a document was removed.
    """
    sessions = _require_sessions()
    result = await sessions.delete_one({"session_id": session_id})
    return result.deleted_count > 0