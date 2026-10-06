"""Structured JSON-lines logging to stderr with mandatory redaction.

Every record goes through :class:`RedactingFilter` (attached to the single ``timeline_sync``
logger, so it runs for every record and before any handler) and the formatter scrubs the
final line once more. Anything that looks like a credential is replaced with a marker:

    oauth2_4/...   ya29....   aas_et/...   Bearer ...   base64/base64url 32-byte keys

Coordinates are never logged: fields named like coordinates are replaced and anything
shaped like "lat, lng" in a string is scrubbed.

Use the module-level :data:`log` helper::

    log.info("fetch.ok", segments=123)

This module is named ``logging`` inside the package; it imports the stdlib module as
``_logging`` (absolute import, so there is no clash).
"""
from __future__ import annotations

import json
import logging as _logging
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any

REDACTED = "[REDACTED]"

_PATTERNS = [
    # order matters: the most specific first
    (re.compile(r"oauth2_4/[A-Za-z0-9_\-/.+=]+"), "oauth2_4/" + REDACTED),
    (re.compile(r"ya29\.[A-Za-z0-9_\-.]+"), "ya29." + REDACTED),
    (re.compile(r"aas_et/[A-Za-z0-9_\-/.+=]+"), "aas_et/" + REDACTED),
    (re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=\-]+"), "Bearer " + REDACTED),
    # base64 (std / url-safe) of a 32-byte key: 44 chars with '=' pad, or 43 unpadded
    (re.compile(r"(?<![A-Za-z0-9+/_=\-])[A-Za-z0-9+/_\-]{43}=(?![A-Za-z0-9+/_=\-])"), REDACTED),
    (re.compile(r"(?<![A-Za-z0-9+/_=\-])[A-Za-z0-9+/_\-]{43}(?![A-Za-z0-9+/_=\-])"), REDACTED),
    # "12.3456789°, 98.7654321°" or "12.3456789, 98.7654321" (>= 4 decimals): never log coordinates
    (re.compile(r"-?\d{1,3}\.\d{4,}\s*°?\s*,\s*-?\d{1,3}\.\d{4,}\s*°?"), "[coords]"),
]

_SENSITIVE_KEYS = re.compile(
    r"(token|secret|password|passwd|authorization|cookie|api[_-]?key|master|bearer|^key$|aes)", re.I)
_COORD_KEYS = re.compile(r"^(lat|lng|lon|latitude|longitude|latlng|coords?|point|points|location)$", re.I)


def redact(value: Any) -> Any:
    """Scrub token-like substrings from a string (other types are returned unchanged)."""
    if not isinstance(value, str):
        return value
    for pat, repl in _PATTERNS:
        value = pat.sub(repl, value)
    return value


def redact_deep(obj: Any, _key: str = "") -> Any:
    if _key and _COORD_KEYS.match(_key):
        return "[coords]"
    if _key and _SENSITIVE_KEYS.search(_key) and not isinstance(obj, (bool, int, float, type(None))):
        return REDACTED
    if isinstance(obj, str):
        return redact(obj)
    if isinstance(obj, dict):
        return {str(k): redact_deep(v, str(k)) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [redact_deep(v) for v in obj]
    if isinstance(obj, (bytes, bytearray)):
        return f"<{len(obj)} bytes>"
    if isinstance(obj, (int, float, bool)) or obj is None:
        return obj
    return redact(repr(obj))


class RedactingFilter(_logging.Filter):
    def filter(self, record: _logging.LogRecord) -> bool:
        try:
            record.msg = redact(record.getMessage())
            record.args = None
        except Exception:  # never let logging raise
            record.msg = "<unprintable log message>"
            record.args = None
        fields = getattr(record, "fields", None)
        if fields:
            record.fields = redact_deep(fields)
        if record.exc_info:
            # exception text can carry anything (URLs, headers); keep only the type
            record.exc_text = None
            et = record.exc_info[0]
            record.msg = f"{record.msg} ({et.__name__ if et else 'error'})"
            record.exc_info = None
        return True


class JsonFormatter(_logging.Formatter):
    def format(self, record: _logging.LogRecord) -> str:
        stamp = datetime.fromtimestamp(record.created, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")
        payload = {
            "ts": stamp[:-3] + "Z",
            "level": record.levelname.lower(),
            "event": record.getMessage(),
        }
        fields = getattr(record, "fields", None)
        if fields:
            for k, v in fields.items():
                payload.setdefault(k, v)
        return redact(json.dumps(payload, ensure_ascii=False, default=str))


class _StderrHandler(_logging.Handler):
    """Writes to whatever sys.stderr is *now* (so pytest's capsys and redirects work)."""

    def emit(self, record: _logging.LogRecord) -> None:
        try:
            sys.stderr.write(self.format(record) + "\n")
            sys.stderr.flush()
        except Exception:
            pass


LOGGER_NAME = "timeline_sync"
_logger = _logging.getLogger(LOGGER_NAME)


def configure_logging(level: str | None = None) -> None:
    """Idempotent: install the redacting filter + JSON stderr handler."""
    lvl = getattr(_logging, (level or os.environ.get("TIMELINE_LOG_LEVEL") or "INFO").upper(), _logging.INFO)
    _logger.setLevel(lvl)
    if not any(isinstance(f, RedactingFilter) for f in _logger.filters):
        _logger.addFilter(RedactingFilter())
    if not any(isinstance(h, _StderrHandler) for h in _logger.handlers):
        h = _StderrHandler()
        h.setFormatter(JsonFormatter())
        _logger.addHandler(h)
    _logger.propagate = True  # so pytest's caplog can see the (already redacted) records


class EventLogger:
    """log.info("event.name", key=value, ...) -> one JSON line on stderr."""

    def _emit(self, level: int, event: str, fields: dict) -> None:
        if not any(isinstance(f, RedactingFilter) for f in _logger.filters):
            configure_logging()
        _logger.log(level, event, extra={"fields": fields})

    def debug(self, event: str, **f: Any) -> None:
        self._emit(_logging.DEBUG, event, f)

    def info(self, event: str, **f: Any) -> None:
        self._emit(_logging.INFO, event, f)

    def warning(self, event: str, **f: Any) -> None:
        self._emit(_logging.WARNING, event, f)

    def error(self, event: str, **f: Any) -> None:
        self._emit(_logging.ERROR, event, f)


log = EventLogger()


def sanitize_message(text: Any, limit: int = 300) -> str:
    """For user-visible / status-file error messages: redact and truncate."""
    s = redact(str(text)).replace("\r", " ").replace("\n", " ").strip()
    return s if len(s) <= limit else s[: limit - 3] + "..."
