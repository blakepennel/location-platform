"""Historical location source adapters.

    HistoricalLocationSource
        GellerCloudSource  real: master token + key from the secrets dir, ~1h bearer obtained
                           in memory (never written anywhere), POST BatchSync, decrypt with
                           upstream code
        SyntheticSource    offline: builds an encrypted BatchSync response from synthetic
                           protobufs and pushes it through the *same* decode pipeline
        LocalDbSource      copies an existing odlh-storage.db (e.g. from the old redroid path)

Every ``fetch`` writes an upstream-compatible ``odlh-storage.db`` atomically at ``dest_db``.
Failures raise :class:`SourceError` carrying a pipeline ``stage`` (auth|fetch|decrypt) and a
sanitized message; nothing secret ever ends up in an exception, log line or status file.
"""
from __future__ import annotations

import base64
import binascii
import contextlib
import io
import os
import sqlite3
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from . import synthetic, upstream
from .config import Config
from .logging import log, redact, sanitize_message
from .secrets import Secret, read_account_email, read_secret, secret_present

GELLER_URL = "https://geller-pa.googleapis.com/geller.oneplatform.GellerService/BatchSync"
ODLH_DATA_TYPE = 79                 # GellerDataType.ENCRYPTED_ONDEVICE_LOCATION_HISTORY
GELLER_CLIENT_ID = "SEMANTICLOCATION"
MAX_CORPORA = 32                    # guard: a real account has a handful; never loop forever
Clock = Callable[[], datetime]


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class SourceError(Exception):
    """A failed source operation. ``stage`` is one of auth|fetch|decrypt."""

    def __init__(self, stage: str, message: str, *, auth_state: Optional[str] = None,
                 cloud_request_ok_at: Optional[str] = None):
        self.stage = stage
        self.message = sanitize_message(message)
        self.auth_state = auth_state
        self.cloud_request_ok_at = cloud_request_ok_at
        super().__init__(self.message)


@dataclass
class AuthHealth:
    state: str  # ok | missing | expired | error | unknown
    master_token_present: bool = False
    key_present: bool = False
    checked_at: Optional[str] = None
    detail: str = ""


@dataclass
class FetchResult:
    segments_written: int
    snapshots: int = 0
    sync_token: Optional[str] = field(default=None, repr=False)  # never logged
    newest_mutation_ms: Optional[int] = None
    cloud_request_ok_at: Optional[str] = None  # ISO-8601 Z; only for real cloud requests


class HistoricalLocationSource(ABC):
    name: str = ""

    @abstractmethod
    def check_auth(self) -> AuthHealth:
        """Cheap, offline check: what credentials exist, plus the last known auth state."""

    @abstractmethod
    def fetch(self, dest_db: Path) -> FetchResult:
        """Write an upstream-compatible odlh-storage.db to ``dest_db`` (atomically)."""


# ---------------------------------------------------------------- shared decode pipeline
@contextlib.contextmanager
def capture_upstream_stderr(event: str = "upstream.warning", level: str = "warning"):
    """Upstream helpers print warnings to stderr; capture, redact and log them instead."""
    buf = io.StringIO()
    try:
        with contextlib.redirect_stderr(buf):
            yield buf
    finally:
        text = buf.getvalue().strip()
        if text:
            log.warning("upstream.warning", text=redact(text[:500]), lines=text.count("\n") + 1)


@dataclass
class DecodedBatch:
    records: list
    snapshots: int
    sync_token: Optional[str]
    newest_mutation_ms: Optional[int]
    # Other corpora the reply advertises (SyncResult.corpusName, field 4). A Timeline backup can
    # be split over several corpora; Google's own client fetches each one ("sync parts").
    corpus_refs: list = field(default_factory=list)


def decode_batch_sync(body: bytes, grpc_encoding: Optional[str], key: bytes) -> DecodedBatch:
    """Re-orchestration of upstream geller_fetch.main() after the HTTP call:
    grpc_unframe -> parse -> snapshots (AES-GCM decrypt) -> rows_of, keeping only
    semantic_segment_table rows that carry a semantic_segment blob."""
    g = upstream.geller()
    try:
        frames = g.grpc_unframe(body, grpc_encoding or "gzip")
    except Exception as e:  # noqa: BLE001
        raise SourceError("fetch", f"malformed gRPC frame ({type(e).__name__})") from None
    if not frames:
        raise SourceError("fetch", "empty gRPC response")
    try:
        msg = g.parse(frames[0])
    except Exception as e:  # noqa: BLE001
        raise SourceError("fetch", f"malformed BatchSyncResponse ({type(e).__name__})") from None
    try:
        sync_token = g.sync_token_of(msg)
    except Exception:  # noqa: BLE001
        sync_token = None
    corpus_refs: list = []
    try:
        for _, item_b in msg.get(1, []):
            sr_b = g.one(g.parse(item_b), 2)
            if not sr_b:
                continue
            for _, v in g.parse(sr_b).get(4, []):
                if isinstance(v, bytes) and v:
                    ref = v.decode("utf8", "replace")
                    if ref not in corpus_refs:
                        corpus_refs.append(ref)
    except Exception:  # noqa: BLE001 - advertisement is optional; never fail the batch over it
        corpus_refs = []

    records: list = []
    snaps = 0
    try:
        with capture_upstream_stderr():
            for snap in g.snapshots(msg, key):
                snaps += 1
                table = (g.one(snap, 1) or b"").decode("utf8", "replace")
                dbid = g.one(snap, 6)
                if table != "semantic_segment_table":
                    continue
                for row in g.rows_of(snap):
                    if row.get("semantic_segment"):
                        row.setdefault("database_id", dbid)
                        records.append(row)
    except SourceError:
        raise
    except RuntimeError as e:
        # upstream decrypt(): "AES-GCM decrypt failed (wrong key, or format changed)"
        raise SourceError("decrypt", str(e)) from None
    except Exception as e:  # noqa: BLE001
        raise SourceError("decrypt", f"could not decode response ({type(e).__name__})") from None

    ms = [r["timestamp_millis"] for r in records
          if isinstance(r.get("timestamp_millis"), int) and not isinstance(r.get("timestamp_millis"), bool)
          and r["timestamp_millis"] > 0]
    return DecodedBatch(records, snaps, sync_token, max(ms) if ms else None, corpus_refs)


def write_records_db(dest_db: Path, records: list) -> int:
    """Upstream write_db(): fresh db written to ``<dest>.tmp`` then os.replace'd (atomic)."""
    g = upstream.geller()
    dest_db = Path(dest_db)
    dest_db.parent.mkdir(parents=True, exist_ok=True)
    with capture_upstream_stderr():
        return g.write_db(str(dest_db), records)


def _load_key(cfg: Config) -> bytes:
    raw = read_secret(cfg.key_file)
    if raw is None:
        raise SourceError("auth", "decryption key missing; run `timeline-sync key`", auth_state="missing")
    try:
        key = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError):
        raise SourceError("decrypt", "key file is not valid base64", auth_state="error") from None
    if len(key) != 32:
        raise SourceError("decrypt", f"key must be 32 bytes (got {len(key)})", auth_state="error")
    return key


# ---------------------------------------------------------------- real source
class GellerCloudSource(HistoricalLocationSource):
    name = "geller"

    def __init__(self, cfg: Config, *, transport=None, oauth_func: Optional[Callable] = None,
                 clock: Optional[Clock] = None, timeout: float = 60.0):
        self.cfg = cfg
        self._transport = transport          # httpx transport injection (tests use MockTransport)
        self._oauth = oauth_func             # gpsoauth.perform_oauth compatible
        self._clock = clock or utcnow
        self._timeout = timeout
        self._state = "unknown"

    # -- auth
    def check_auth(self) -> AuthHealth:
        master = secret_present(self.cfg.master_file)
        key = secret_present(self.cfg.key_file)
        have_id = secret_present(self.cfg.android_id_file)
        email = read_account_email(self.cfg) is not None
        if not (master and key and have_id and email):
            state, detail = "missing", "run `timeline-sync auth` and `timeline-sync key`"
        else:
            state, detail = self._state, ""
        return AuthHealth(state, master, key, iso_z(self._clock()), detail)

    def _bearer(self) -> Secret:
        """~1h webhistory-scoped bearer, obtained fresh each run and kept in memory only."""
        email = read_account_email(self.cfg)
        master = read_secret(self.cfg.master_file)
        android_id = read_secret(self.cfg.android_id_file)
        if not (email and master and android_id):
            self._state = "missing"
            raise SourceError("auth", "credentials missing; run `timeline-sync auth`", auth_state="missing")
        tok_mod = upstream.get_token()
        fn = self._oauth
        if fn is None:
            try:
                import gpsoauth
            except ImportError:
                raise SourceError("auth", "gpsoauth is not installed", auth_state="error") from None
            fn = gpsoauth.perform_oauth
        try:
            r = fn(email, master, android_id, service=tok_mod.SCOPE, app=tok_mod.APP,
                   client_sig=tok_mod.CLIENT_SIG)
        except Exception as e:  # noqa: BLE001 - network/library errors; message may embed URLs
            self._state = "error"
            raise SourceError("auth", f"bearer request failed ({type(e).__name__})", auth_state="error") from None
        finally:
            master = None
        tok = r.get("Auth") if isinstance(r, dict) else None
        if not tok:
            code = str(r.get("Error", "")) if isinstance(r, dict) else ""
            code = code if code.replace("_", "").isalnum() and len(code) < 60 else "unspecified"
            expired = code in ("BadAuthentication", "NeedsBrowser", "Expired")
            self._state = "expired" if expired else "error"
            hint = " (master token no longer valid; re-run `timeline-sync auth`)" if expired else ""
            raise SourceError("auth", f"could not obtain bearer: {code}{hint}", auth_state=self._state)
        return Secret(tok)

    # -- fetch
    @staticmethod
    def _request_body(corpus: Optional[str] = None) -> bytes:
        """BatchSyncRequest for the ODLH corpus. Without ``corpus`` it is exactly upstream's
        request; with it, SyncItem.corpusName (field 3) selects one advertised corpus."""
        g = upstream.geller()
        if corpus is None:
            return g.grpc_frame(g.build_request(None))
        item = g.fld_varint(1, ODLH_DATA_TYPE) + g.fld_str(3, corpus)
        return g.grpc_frame(g.fld_bytes(1, item) + g.fld_str(2, GELLER_CLIENT_ID))

    def _post(self, client, body: bytes, bearer: Secret):
        import httpx
        try:
            r = client.post(GELLER_URL, content=body,
                            headers={"content-type": "application/grpc",
                                     "authorization": "Bearer " + bearer.reveal(),
                                     "grpc-accept-encoding": "identity,gzip",
                                     "te": "trailers"})
        except httpx.HTTPError as e:
            raise SourceError("fetch", f"network error ({type(e).__name__})") from None
        if r.status_code in (401, 403):
            self._state = "expired"
            raise SourceError("auth", f"HTTP {r.status_code}: Google rejected the access token", auth_state="expired")
        if r.status_code != 200:
            raise SourceError("fetch", f"HTTP {r.status_code} from Geller (not a gRPC response)")
        status = r.headers.get("grpc-status", "0")
        if status != "0":
            msg = r.headers.get("grpc-message", "no message")
            if status == "16":  # UNAUTHENTICATED
                self._state = "expired"
                raise SourceError("auth", f"gRPC UNAUTHENTICATED: {msg}", auth_state="expired")
            raise SourceError("fetch", f"gRPC error {status}: {msg}")
        return r

    def fetch(self, dest_db: Path) -> FetchResult:
        import httpx

        key = _load_key(self.cfg)
        bearer = self._bearer()
        batches: list = []
        ok_at: Optional[str] = None
        try:
            with httpx.Client(http2=self._transport is None, timeout=self._timeout,
                              transport=self._transport) as c:
                # 1. the default corpus (upstream's request), then 2. every corpus it advertises,
                #    transitively, like Google's client does. Without step 2 anything uploaded to
                #    a newer corpus (e.g. iPhone backups since Aug 2026) is silently missing.
                queue: list = [None]
                seen: set = set()
                while queue:
                    corpus = queue.pop(0)
                    if corpus in seen:
                        continue
                    if len(seen) >= MAX_CORPORA:
                        log.warning("geller.corpus_limit", limit=MAX_CORPORA)
                        break
                    seen.add(corpus)
                    r = self._post(c, self._request_body(corpus), bearer)
                    ok_at = iso_z(self._clock())
                    try:
                        b = decode_batch_sync(r.content, r.headers.get("grpc-encoding", "gzip"), key)
                    except SourceError as e:
                        e.cloud_request_ok_at = ok_at  # the request itself succeeded
                        raise
                    batches.append(b)
                    queue.extend(ref for ref in b.corpus_refs if ref not in seen)
        finally:
            del bearer

        records = merge_corpus_records(batches)
        n = write_records_db(dest_db, records)
        self._state = "ok"
        ms = [b.newest_mutation_ms for b in batches if b.newest_mutation_ms]
        log.info("geller.fetch_ok", segments=n, snapshots=sum(b.snapshots for b in batches), corpora=len(batches))
        return FetchResult(n, sum(b.snapshots for b in batches), batches[0].sync_token if batches else None,
                           max(ms) if ms else None, ok_at)


def merge_corpus_records(batches: list) -> list:
    """Union of all corpora's rows, one per segment_id. On a clash keep the newer write
    (timestamp_millis when present, else the corpus fetched later)."""
    merged: dict = {}
    for b in batches:
        for row in b.records:
            sid = row.get("segment_id")
            if sid is None:
                continue
            old = merged.get(sid)
            if old is None or (row.get("timestamp_millis") or 0) >= (old.get("timestamp_millis") or 0):
                merged[sid] = row
    return list(merged.values())


# ---------------------------------------------------------------- synthetic source
class SyntheticSource(HistoricalLocationSource):
    name = "synthetic"

    def __init__(self, cfg: Config, *, seed: int = 1, days: int = 14, end_date=None,
                 compress: bool = False, clock: Optional[Clock] = None, key: Optional[bytes] = None):
        if days < 10:
            raise ValueError("days must be >= 10 (the dataset embeds a trip, a DST-like change and a layover)")
        self.cfg = cfg
        self.seed, self.days, self.end_date, self.compress = seed, days, end_date, compress
        self._clock = clock or utcnow
        self._key = key

    def check_auth(self) -> AuthHealth:
        return AuthHealth("ok", secret_present(self.cfg.master_file), secret_present(self.cfg.key_file),
                          iso_z(self._clock()), "synthetic data; no credentials are used")

    def fetch(self, dest_db: Path) -> FetchResult:
        now = self._clock()
        rows = synthetic.generate_rows(self.seed, self.days, self.end_date or synthetic.default_end_date(now))
        newest_end = max(r.end_s for r in rows)
        mutation_ms = min(newest_end + 3 * 3600, int(now.timestamp())) * 1000  # simulated backup lag
        key = self._key or synthetic.synthetic_key(self.seed)
        resp = synthetic.build_batch_sync_response(rows, key, mutation_ms=mutation_ms, compress=self.compress)
        batch = decode_batch_sync(resp.body, resp.grpc_encoding, key)
        n = write_records_db(dest_db, batch.records)
        log.info("synthetic.fetch_ok", segments=n, snapshots=batch.snapshots)
        return FetchResult(n, batch.snapshots, batch.sync_token, batch.newest_mutation_ms, None)


# ---------------------------------------------------------------- local db source
class LocalDbSource(HistoricalLocationSource):
    name = "local_db"

    def __init__(self, cfg: Config, *, path: Optional[Path] = None, clock: Optional[Clock] = None):
        self.cfg = cfg
        self.path = Path(path) if path else cfg.local_db
        self._clock = clock or utcnow

    def check_auth(self) -> AuthHealth:
        ok = bool(self.path and Path(self.path).is_file())
        return AuthHealth("ok" if ok else "missing", secret_present(self.cfg.master_file),
                          secret_present(self.cfg.key_file), iso_z(self._clock()),
                          "" if ok else "set TIMELINE_LOCAL_DB or --local-db to an odlh-storage.db")

    def fetch(self, dest_db: Path) -> FetchResult:
        if not self.path or not Path(self.path).is_file():
            raise SourceError("fetch", "local db not found; set TIMELINE_LOCAL_DB or --local-db",
                              auth_state="missing")
        dest_db = Path(dest_db)
        dest_db.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest_db.with_name(f".{dest_db.name}.{uuid.uuid4().hex[:8]}.tmp")
        src = dst = None
        try:
            src = sqlite3.connect(f"{Path(self.path).resolve().as_uri()}?mode=ro", uri=True)
            dst = sqlite3.connect(str(tmp))
            src.backup(dst)  # consistent copy, WAL-aware
            n = dst.execute("SELECT count(*) FROM semantic_segment_table").fetchone()[0]
            try:
                ms = dst.execute("SELECT max(timestamp_millis) FROM semantic_segment_table").fetchone()[0]
            except sqlite3.Error:
                ms = None
        except sqlite3.Error as e:
            for c in (src, dst):
                if c is not None:
                    c.close()
            src = dst = None
            tmp.unlink(missing_ok=True)
            raise SourceError("fetch", f"not a readable odlh-storage.db ({type(e).__name__})") from None
        finally:
            for c in (src, dst):
                if c is not None:
                    c.close()
        try:
            os.replace(tmp, dest_db)
        finally:
            if tmp.exists():
                tmp.unlink()
        log.info("local_db.fetch_ok", segments=n)
        return FetchResult(n, 0, None, ms if isinstance(ms, int) and ms > 0 else None, None)


def make_source(cfg: Config, name: Optional[str] = None, *, clock: Optional[Clock] = None,
                **kw) -> HistoricalLocationSource:
    name = (name or cfg.source).lower()
    if name == "geller":
        return GellerCloudSource(cfg, clock=clock, **kw)
    if name == "synthetic":
        return SyntheticSource(cfg, clock=clock, **kw)
    if name == "local_db":
        return LocalDbSource(cfg, clock=clock, **kw)
    raise ValueError(f"unknown source {name!r}")
