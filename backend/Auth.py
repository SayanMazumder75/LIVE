"""
JWT authentication middleware.

Mirrors the old MeetMind Node.js `protect` middleware:
    - Reads `Authorization: Bearer <token>` header
    - Verifies the token against JWT_SECRET from .env
    - Extracts decoded["id"] as user_id
    - Raises HTTP 401 for missing / invalid / expired tokens

Environment
-----------
    JWT_SECRET : must match the secret used by MeetMind to sign tokens.
                 If unset, all protected routes return 401 immediately
                 so the server doesn't accidentally run unauthenticated.
"""

from __future__ import annotations

import logging
import os

from aiohttp import web

logger = logging.getLogger("auth")

# ── lazy import of PyJWT ──────────────────────────────────────────────────────
# jwt (PyJWT) is a soft dependency — imported once and cached so missing
# installs produce a clear error at request time rather than at startup.
_jwt_module = None
_jwt_import_error: str = ""


def _get_jwt():
    global _jwt_module, _jwt_import_error
    if _jwt_module is not None:
        return _jwt_module
    if _jwt_import_error:
        return None
    try:
        import jwt as _jwt
        _jwt_module = _jwt
        return _jwt_module
    except ImportError:
        _jwt_import_error = (
            "`PyJWT` is not installed. Run `pip install PyJWT` "
            "(or `pip install -r backend/requirements.txt`) and restart."
        )
        logger.error("PyJWT not installed: %s", _jwt_import_error)
        return None


def _secret() -> str:
    return os.getenv("JWT_SECRET", "").strip()


def _unauthorized(message: str) -> web.HTTPUnauthorized:
    return web.HTTPUnauthorized(
        reason=message,
        content_type="application/json",
        text=f'{{"error": "{message}"}}',
    )


async def require_auth(request: web.Request) -> str:
    """
    Validate the Bearer token in the Authorization header.

    Returns the user_id string (decoded["id"]) on success.
    Raises aiohttp.web.HTTPUnauthorized (401) on any failure.

    This is a drop-in equivalent of MeetMind's Express `protect`
    middleware — call it at the top of every protected route handler:

        user_id = await require_auth(request)
    """
    jwt = _get_jwt()
    if jwt is None:
        raise _unauthorized(
            "Server misconfiguration: PyJWT is not installed. "
            "Run `pip install PyJWT` and restart."
        )

    secret = _secret()
    if not secret:
        raise _unauthorized(
            "Server misconfiguration: JWT_SECRET is not set in backend/.env."
        )

    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise _unauthorized("No token provided.")

    token = auth_header[len("Bearer "):].strip()
    if not token:
        raise _unauthorized("No token provided.")

    try:
        decoded = jwt.decode(token, secret, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise _unauthorized("Token has expired.")
    except jwt.InvalidTokenError as e:
        logger.debug("JWT validation failed: %s", e)
        raise _unauthorized("Invalid token.")

    user_id = decoded.get("id") or decoded.get("_id") or decoded.get("sub")
    if not user_id or not isinstance(user_id, str):
        raise _unauthorized("Token payload missing user id.")

    return user_id