"""Atomic file publishing, export validation and rotation.

``current/Timeline.json`` is the last-known-good export: it is only ever replaced with
``os.replace`` of a fully written, fsynced, validated file that lives in the same directory,
so a consumer (timeline-mcp) never observes a partial file and a failed sync never touches it.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .logging import log

SHRINK_THRESHOLD = 0.5
_EXPORT_RE = re.compile(r"^Timeline-(\d{8}T\d{6}Z)\.json$")


class ValidationError(RuntimeError):
    pass


def export_filename(now: datetime) -> str:
    return f"Timeline-{now.astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"


def _tmp_sibling(path: Path) -> Path:
    return path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp")


def atomic_replace(src: Path, dst: Path, attempts: int = 10) -> None:
    """os.replace with retries: on Windows a reader holding the target open raises PermissionError."""
    for i in range(attempts):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(0.05 * (i + 1))


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = _tmp_sibling(path)
    try:
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        atomic_replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def atomic_copy(src: Path, dst: Path) -> None:
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = _tmp_sibling(dst)
    try:
        with open(src, "rb") as fi, open(tmp, "wb") as fo:
            while True:
                chunk = fi.read(1 << 20)
                if not chunk:
                    break
                fo.write(chunk)
            fo.flush()
            os.fsync(fo.fileno())
        atomic_replace(tmp, dst)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def count_segments(path: Path) -> Optional[int]:
    """Segment count of an existing export file, or None if unreadable."""
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
        segs = doc["semanticSegments"]
        return len(segs) if isinstance(segs, list) else None
    except (OSError, ValueError, KeyError, TypeError):
        return None


def validate_export_file(path: Path, *, prev_total: Optional[int], allow_shrink: bool = False) -> int:
    """Return the segment count or raise ValidationError.

    Checks: parseable, ``semanticSegments`` is a non-empty list of objects, every segment
    carries ``segmentId``/``segmentType``, and the count did not fall below 50% of the previous
    published export (unless ``allow_shrink``)."""
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise ValidationError(f"export is not parseable JSON ({type(e).__name__})") from None
    segs = doc.get("semanticSegments") if isinstance(doc, dict) else None
    if not isinstance(segs, list):
        raise ValidationError("export has no semanticSegments list")
    total = len(segs)
    if total == 0:
        raise ValidationError("export is empty (0 segments)")
    if not all(isinstance(s, dict) and s.get("segmentId") and s.get("segmentType") for s in segs):
        raise ValidationError("export contains segments without segmentId/segmentType")
    if prev_total and not allow_shrink and total < prev_total * SHRINK_THRESHOLD:
        raise ValidationError(
            f"segment count dropped from {prev_total} to {total} (>{int((1 - SHRINK_THRESHOLD) * 100)}%); "
            "refusing to publish (use --allow-shrink if this is expected)")
    return total


def rotate_exports(exports_dir: Path, keep: int) -> list[str]:
    """Keep the newest ``keep`` ``Timeline-<ts>.json`` files; return removed names."""
    exports_dir = Path(exports_dir)
    if not exports_dir.is_dir():
        return []
    names = sorted(n for n in os.listdir(exports_dir) if _EXPORT_RE.match(n))
    removed = []
    for n in names[:-keep] if keep > 0 else names:
        try:
            (exports_dir / n).unlink()
            removed.append(n)
        except OSError:
            log.warning("publish.rotate_failed", file=n)
    return removed
