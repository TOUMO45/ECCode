import os
import tempfile
from pathlib import Path

DEFAULT_TOKEN_TTL_SECONDS = 86400


def database_url() -> str:
    url = os.environ.get("DATABASE_URL", "").strip()
    if url:
        return url
    return "sqlite:///" + str(Path(tempfile.gettempdir()) / "task_tracker.db")


def admin_email() -> str | None:
    value = os.environ.get("ADMIN_EMAIL", "").strip().lower()
    return value or None


def token_ttl_seconds() -> int:
    raw = os.environ.get("TOKEN_TTL_SECONDS", "").strip()
    if not raw:
        return DEFAULT_TOKEN_TTL_SECONDS
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_TOKEN_TTL_SECONDS
    return value if value > 0 else DEFAULT_TOKEN_TTL_SECONDS
