"""state/sync-status.json: read, write, validate, derive freshness, render report.

The file follows ../schemas/sync-status.schema.json exactly and never contains secrets,
coordinates, place names or place ids.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Optional

from .config import Config
from .logging import sanitize_message
from .publish import atomic_write_bytes

SCHEMA_VERSION = 1
ADAPTERS = ("geller", "synthetic", "local_db")
STAGES = ("auth", "fetch", "decrypt", "export", "enrich", "publish", "unknown")
AUTH_STATES = ("ok", "missing", "expired", "error", "unknown")

NOT_REALTIME_NOTICE = (
    "NOTE: Google Timeline backup is NOT real-time. Google only receives the phone's on-device "
    "Timeline backup periodically, typically lagging by hours up to about a day, so the newest "
    "records here can never be fresher than the last backup upload, however often this syncs."
)

_DT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")


def iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def ms_to_iso(ms: Optional[int]) -> Optional[str]:
    if not ms:
        return None
    return iso_z(datetime.fromtimestamp(ms / 1000, timezone.utc))


def load_status(cfg: Config) -> Optional[dict]:
    try:
        data = json.loads(cfg.status_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def save_status(cfg: Config, status: dict) -> None:
    problems = validate_status(status)
    if problems:
        raise ValueError("refusing to write invalid sync-status.json: " + "; ".join(problems))
    atomic_write_bytes(cfg.status_file, (json.dumps(status, indent=2) + "\n").encode("utf-8"))


def new_status(adapter: str, attempt_at: datetime) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "source": "google_timeline",
        "adapter": adapter,
        "last_attempt_at": iso_z(attempt_at),
        "last_success_at": None,
        "last_cloud_request_at": None,
        "last_error": None,
        "consecutive_failures": 0,
        "sync_duration_seconds": None,
        "record_counts": None,
        "oldest_record_start": None,
        "newest_record_end": None,
        "newest_cloud_mutation_at": None,
        "auth": {"state": "unknown", "checked_at": None, "master_token_present": False, "key_present": False},
        "output": None,
    }


def make_error(stage: str, message: Any, at: datetime) -> dict:
    return {"at": iso_z(at), "stage": stage if stage in STAGES else "unknown",
            "message": sanitize_message(message)}


# ------------------------------------------------------------------ minimal schema validator
def validate_status(s: dict) -> list[str]:
    """Structural check mirroring sync-status.schema.json (tests also run the real schema)."""
    errs: list[str] = []

    def dt_or_null(name: str, v: Any) -> None:
        if v is not None and not (isinstance(v, str) and _DT_RE.match(v)):
            errs.append(f"{name} must be an ISO-8601 date-time or null")

    for req in ("schema_version", "source", "adapter", "last_attempt_at", "consecutive_failures", "auth"):
        if req not in s:
            errs.append(f"missing {req}")
    if s.get("schema_version") != 1:
        errs.append("schema_version must be 1")
    if s.get("source") != "google_timeline":
        errs.append("source must be google_timeline")
    if s.get("adapter") not in ADAPTERS:
        errs.append("bad adapter")
    dt_or_null("last_attempt_at", s.get("last_attempt_at"))
    if s.get("last_attempt_at") is None:
        errs.append("last_attempt_at is required")
    for k in ("last_success_at", "last_cloud_request_at", "oldest_record_start", "newest_record_end",
              "newest_cloud_mutation_at"):
        dt_or_null(k, s.get(k))
    cf = s.get("consecutive_failures")
    if not isinstance(cf, int) or isinstance(cf, bool) or cf < 0:
        errs.append("consecutive_failures must be an integer >= 0")
    le = s.get("last_error")
    if le is not None:
        if not isinstance(le, dict):
            errs.append("last_error must be an object or null")
        else:
            dt_or_null("last_error.at", le.get("at"))
            if "stage" in le and le["stage"] not in STAGES:
                errs.append("bad last_error.stage")
            if "message" in le and not isinstance(le["message"], str):
                errs.append("last_error.message must be a string")
    d = s.get("sync_duration_seconds")
    if d is not None and (isinstance(d, bool) or not isinstance(d, (int, float))):
        errs.append("sync_duration_seconds must be a number or null")
    rc = s.get("record_counts")
    if rc is not None:
        if not isinstance(rc, dict):
            errs.append("record_counts must be an object or null")
        else:
            for k, v in rc.items():
                if isinstance(v, bool) or not isinstance(v, int):
                    errs.append(f"record_counts.{k} must be an integer")
    au = s.get("auth")
    if not isinstance(au, dict):
        errs.append("auth must be an object")
    else:
        if "state" in au and au["state"] not in AUTH_STATES:
            errs.append("bad auth.state")
        dt_or_null("auth.checked_at", au.get("checked_at"))
        for k in ("master_token_present", "key_present"):
            if k in au and not isinstance(au[k], bool):
                errs.append(f"auth.{k} must be boolean")
    out = s.get("output")
    if out is not None:
        if not isinstance(out, dict):
            errs.append("output must be an object or null")
        else:
            for k in ("current_export", "export_sha256"):
                if k in out and not isinstance(out[k], str):
                    errs.append(f"output.{k} must be a string")
            if "enriched" in out and not isinstance(out["enriched"], bool):
                errs.append("output.enriched must be boolean")
            if "published_at" in out:
                dt_or_null("output.published_at", out["published_at"])
    return errs


# ------------------------------------------------------------------ derived freshness + report
def _hours(a: Optional[datetime], b: datetime) -> Optional[float]:
    return None if a is None else round((b - a).total_seconds() / 3600, 2)


def derive(status: dict, now: datetime) -> dict:
    newest = parse_iso(status.get("newest_record_end"))
    return {
        "now": iso_z(now),
        "lag_hours": _hours(newest, now),  # age of the newest indexed record
        "freshness_seconds": None if newest is None else max(0, int((now - newest).total_seconds())),
        "hours_since_last_success": _hours(parse_iso(status.get("last_success_at")), now),
        "hours_since_last_attempt": _hours(parse_iso(status.get("last_attempt_at")), now),
        "hours_since_cloud_request": _hours(parse_iso(status.get("last_cloud_request_at")), now),
        "newest_mutation_lag_hours": _hours(parse_iso(status.get("newest_cloud_mutation_at")), now),
        "realtime": False,
        "notice": NOT_REALTIME_NOTICE,
    }


def _ago(iso: Optional[str], now: datetime) -> str:
    if not iso:
        return "never"
    d = parse_iso(iso)
    if d is None:
        return iso
    h = (now - d).total_seconds() / 3600
    if h < 0:
        rel = "in the future"
    elif h < 1:
        rel = f"{int(h * 60)} min ago"
    elif h < 48:
        rel = f"{h:.1f} h ago"
    else:
        rel = f"{h / 24:.1f} d ago"
    return f"{iso}  ({rel})"


def render_report(status: Optional[dict], now: datetime) -> str:
    if not status:
        return ("Timeline sync: no sync has run yet (no state/sync-status.json).\n"
                "  Run `timeline-sync sync` (or `timeline-sync sync --source synthetic` to try it offline).\n"
                + NOT_REALTIME_NOTICE)
    dv = derive(status, now)
    au = status.get("auth") or {}
    rc = status.get("record_counts") or {}
    err = status.get("last_error")
    lines = [
        "Timeline sync status",
        f"  adapter               : {status.get('adapter')}",
        f"  last attempt          : {_ago(status.get('last_attempt_at'), now)}",
        f"  last success          : {_ago(status.get('last_success_at'), now)}",
        f"  last cloud request    : {_ago(status.get('last_cloud_request_at'), now)}",
        f"  consecutive failures  : {status.get('consecutive_failures')}",
    ]
    if rc:
        lines.append(
            f"  records               : {rc.get('total', 0)} total "
            f"(visit {rc.get('visit', 0)}, activity {rc.get('activity', 0)}, path {rc.get('timelinePath', 0)}, "
            f"trip {rc.get('trip', 0)}; deleted skipped {rc.get('deleted_skipped', 0)}, "
            f"decode errors {rc.get('decode_errors', 0)})")
    else:
        lines.append("  records               : (none yet)")
    lines.append(f"  oldest record start   : {status.get('oldest_record_start') or 'n/a'}")
    newest = status.get("newest_record_end") or "n/a"
    lag = f"  (lag {dv['lag_hours']} h behind now)" if dv["lag_hours"] is not None else ""
    lines.append(f"  newest record end     : {newest}{lag}")
    lines.append(f"  newest cloud mutation : {status.get('newest_cloud_mutation_at') or 'n/a (not provided)'}")
    lines.append(
        f"  auth                  : {au.get('state', 'unknown')} "
        f"(master token: {'present' if au.get('master_token_present') else 'absent'}, "
        f"key: {'present' if au.get('key_present') else 'absent'})")
    out = status.get("output")
    if out:
        lines.append(f"  published             : {out.get('current_export')}"
                     f"{' (+enriched)' if out.get('enriched') else ''}")
    if err:
        lines.append(f"  last error            : [{err.get('stage')}] {err.get('message')} ({err.get('at')})")
    lines.append("")
    lines.append(NOT_REALTIME_NOTICE)
    return "\n".join(lines)
