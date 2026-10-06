"""The routine `timeline-sync sync` pipeline.

    lock -> check auth -> fetch (staging db) -> decode/export (timestamped file)
         -> [enrich] -> validate -> atomic publish (current/Timeline.json) -> status -> report

Invariant: ``current/Timeline.json`` (and ``raw/odlh-storage.db``) are only replaced after
every earlier stage succeeded. Any failure leaves last-known-good untouched, is recorded in
``state/sync-status.json`` (previous success fields are preserved) and yields a non-zero exit.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

from . import upstream
from .config import Config
from .export import ExportError, export_db
from .logging import log, sanitize_message
from .names import apply_cached_names_to_file
from .publish import (ValidationError, atomic_copy, atomic_replace, count_segments, export_filename,
                      rotate_exports, sha256_file, validate_export_file)
from .secrets import secure_mkdir
from .sources import HistoricalLocationSource, SourceError, capture_upstream_stderr, iso_z, utcnow
from .status import (AUTH_STATES, STAGES, load_status, make_error, ms_to_iso, new_status, render_report,
                     save_status, validate_status)

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_LOCKED = 75

LOCK_STALE_AFTER_S = 6 * 3600


# ------------------------------------------------------------------ lock
class LockHeldError(RuntimeError):
    pass


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        # NEVER use os.kill(pid, 0) on Windows: it calls TerminateProcess.
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return ctypes.get_last_error() == 5  # ERROR_ACCESS_DENIED => the process exists
        try:
            code = wintypes.DWORD()
            ok = k32.GetExitCodeProcess(h, ctypes.byref(code))
            return bool(ok) and code.value == 259  # STILL_ACTIVE
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class SyncLock:
    """Exclusive lock file (O_CREAT|O_EXCL) holding the owner's pid; stale locks are reclaimed."""

    def __init__(self, path: Path, stale_after_s: float = LOCK_STALE_AFTER_S):
        self.path = Path(path)
        self.stale_after_s = stale_after_s
        self._held = False

    def _stale(self) -> bool:
        try:
            age = time.time() - self.path.stat().st_mtime
        except OSError:
            return True  # vanished between the failed create and now
        try:
            pid = int(self.path.read_text(encoding="ascii").split()[0])
        except (OSError, ValueError, IndexError):
            return age > self.stale_after_s
        return (not pid_alive(pid)) or age > self.stale_after_s

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(3):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except FileExistsError:
                if self._stale():
                    try:
                        self.path.unlink()
                    except OSError:
                        pass
                    continue
                raise LockHeldError("another timeline-sync run holds the lock") from None
            with os.fdopen(fd, "w", encoding="ascii") as f:
                f.write(f"{os.getpid()}\n")
            self._held = True
            return
        raise LockHeldError("could not acquire the sync lock")

    def release(self) -> None:
        if self._held:
            try:
                self.path.unlink()
            except OSError:
                pass
            self._held = False

    def __enter__(self) -> "SyncLock":
        self.acquire()
        return self

    def __exit__(self, *exc) -> None:
        self.release()


# ------------------------------------------------------------------ result
@dataclass
class SyncOutcome:
    ok: bool
    exit_code: int
    status: Optional[dict]
    error: Optional[dict] = None
    locked: bool = False


def _ensure_dirs(cfg: Config) -> None:
    if not cfg.data_dir.exists():
        secure_mkdir(cfg.data_dir)  # real location data: private from creation
    for d in (cfg.raw_dir, cfg.exports_dir, cfg.current_dir, cfg.state_dir):
        d.mkdir(parents=True, exist_ok=True)


def _safe_unlink(p: Path) -> None:
    try:
        p.unlink()
    except OSError:
        pass


def _previous_total(cfg: Config, prev: Optional[dict]) -> Optional[int]:
    if prev and prev.get("last_success_at"):
        total = (prev.get("record_counts") or {}).get("total")
        if isinstance(total, int) and total > 0:
            return total
    if cfg.current_export.is_file():
        return count_segments(cfg.current_export)
    return None


def run_sync(cfg: Config, source: HistoricalLocationSource, *, enrich: bool = False,
             allow_shrink: bool = False, clock: Optional[Callable[[], datetime]] = None) -> SyncOutcome:
    clock = clock or utcnow
    _ensure_dirs(cfg)
    lock = SyncLock(cfg.lock_file)
    try:
        lock.acquire()
    except LockHeldError as e:
        log.warning("sync.locked")
        return SyncOutcome(False, EXIT_LOCKED, None, make_error("unknown", str(e), clock()), locked=True)
    try:
        return _run(cfg, source, enrich, allow_shrink, clock)
    finally:
        lock.release()


def _run(cfg: Config, source: HistoricalLocationSource, enrich: bool, allow_shrink: bool,
         clock: Callable[[], datetime]) -> SyncOutcome:
    t0 = time.monotonic()
    attempt = clock()
    prev = load_status(cfg)
    if prev is None or validate_status(prev):
        prev = None
    base = dict(prev) if prev else new_status(source.name, attempt)
    base["adapter"] = source.name
    base["last_attempt_at"] = iso_z(attempt)
    log.info("sync.start", adapter=source.name, enrich=enrich)

    staging = cfg.raw_dir / ".odlh-storage.db.staging"
    full_tmp = cfg.current_dir / ".Timeline-full.json.tmp"
    stage = "auth"
    cloud_ok_at: Optional[str] = None
    auth_override: Optional[str] = None
    try:
        health = source.check_auth()
        if health.state == "missing":
            raise SourceError("auth", health.detail or "credentials missing", auth_state="missing")

        stage = "fetch"
        fr = source.fetch(staging)
        cloud_ok_at = fr.cloud_request_ok_at

        stage = "export"
        export_path = cfg.exports_dir / export_filename(attempt)
        res = export_db(staging, export_path, adapter=source.name, now=attempt,
                        default_utc_offset_min=cfg.default_utc_offset_min)
        total = validate_export_file(export_path, prev_total=_previous_total(cfg, prev),
                                     allow_shrink=allow_shrink)
        # Re-apply place names already paid for (offline; `timeline-sync names` fills the cache).
        try:
            named = apply_cached_names_to_file(cfg, export_path)
            if named:
                log.info("names.applied", visits=named)
        except Exception as e:  # noqa: BLE001 - names are optional; never fail a sync over them
            log.warning("names.apply_failed", error=type(e).__name__)

        if enrich:
            stage = "enrich"
            # build_records reads place_cache_{api,browser}.json beside its output
            for cache in (cfg.names_cache, cfg.names_browser_cache):
                if cache.exists():
                    atomic_copy(cache, cfg.current_dir / cache.name)
            br = upstream.build_records()
            _safe_unlink(full_tmp)
            with capture_upstream_stderr("enrich.upstream_output", "info"):
                br.build(str(export_path), str(full_tmp))
            validate_export_file(full_tmp, prev_total=None)

        stage = "publish"
        if enrich:
            atomic_replace(full_tmp, cfg.current_full)
        atomic_copy(export_path, cfg.current_export)   # commit point for consumers
        atomic_replace(staging, cfg.raw_db)
        rotate_exports(cfg.exports_dir, cfg.keep_exports)
        published_at = clock()
        digest = sha256_file(cfg.current_export)

        health = source.check_auth()
        st = dict(base)
        st.update({
            "last_success_at": iso_z(published_at),
            "last_cloud_request_at": cloud_ok_at or base.get("last_cloud_request_at"),
            "last_error": None,
            "consecutive_failures": 0,
            "sync_duration_seconds": round(time.monotonic() - t0, 3),
            "record_counts": res.stats.as_record_counts(),
            "oldest_record_start": res.oldest_start,
            "newest_record_end": res.newest_end,
            "newest_cloud_mutation_at": ms_to_iso(fr.newest_mutation_ms),
            "auth": _auth_block(health, None),
            "output": {"current_export": str(cfg.current_export.resolve()), "export_sha256": digest,
                       "enriched": bool(enrich), "published_at": iso_z(published_at)},
        })
        save_status(cfg, st)
        log.info("sync.ok", adapter=source.name, total=total, duration_s=st["sync_duration_seconds"])
        return SyncOutcome(True, EXIT_OK, st)

    except SourceError as e:
        err_stage, msg = e.stage, e.message
        cloud_ok_at = e.cloud_request_ok_at or cloud_ok_at
        auth_override = e.auth_state
    except (ValidationError, ExportError) as e:
        err_stage, msg = "export", str(e)
    except upstream.UpstreamError as e:
        err_stage, msg = stage, str(e)
    except Exception as e:  # noqa: BLE001 - last-known-good must survive anything
        err_stage, msg = (stage if stage in STAGES else "unknown"), f"{type(e).__name__}: {e}"
    finally:
        _safe_unlink(staging)
        _safe_unlink(full_tmp)

    # ---- failure path: keep every previous success field, record the error
    now = clock()
    try:
        health = source.check_auth()
    except Exception:  # noqa: BLE001
        health = None
    err = make_error(err_stage, msg, now)
    st = dict(base)
    st.update({
        "last_error": err,
        "consecutive_failures": int((prev or {}).get("consecutive_failures", 0) or 0) + 1,
        "sync_duration_seconds": round(time.monotonic() - t0, 3),
        "auth": _auth_block(health, auth_override),
    })
    if cloud_ok_at:
        st["last_cloud_request_at"] = cloud_ok_at
    try:
        save_status(cfg, st)
    except Exception as e:  # noqa: BLE001
        log.error("sync.status_write_failed", error=type(e).__name__)
    log.error("sync.failed", stage=err["stage"], message=err["message"])
    return SyncOutcome(False, EXIT_FAILED, st, err)


def _auth_block(health, override: Optional[str]) -> dict:
    state = override or (health.state if health else "unknown")
    if state not in AUTH_STATES:
        state = "unknown"
    return {
        "state": state,
        "checked_at": health.checked_at if health else None,
        "master_token_present": bool(health.master_token_present) if health else False,
        "key_present": bool(health.key_present) if health else False,
    }


def freshness_report(outcome: SyncOutcome, now: datetime) -> str:
    return render_report(outcome.status, now)
