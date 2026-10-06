"""Shared test helpers. Everything here is synthetic; there are no real secrets or places."""
import base64
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from timeline_sync import synthetic, upstream
from timeline_sync.config import Config
from timeline_sync.secrets import write_account_email, write_secret

FIXED_NOW = datetime(2026, 9, 28, 9, 0, 0, tzinfo=timezone.utc)
END_DATE = date(2026, 9, 27)

FAKE_OAUTH_TOKEN = "oauth2_4/FAKE_TEST_TOKEN_1234567890abcdef"
FAKE_MASTER = "aas_et/FAKE_MASTER_TOKEN_0123456789abcdefghij"
FAKE_BEARER = "ya29.FAKE_BEARER_TOKEN_abcdefghijklmnop12345"
FAKE_EMAIL = "tester@example.invalid"


class Clock:
    """Advancing fake clock (each call moves forward ``step``)."""

    def __init__(self, start=FIXED_NOW, step=timedelta(minutes=1)):
        self.t = start
        self.step = step

    def __call__(self):
        v = self.t
        self.t = self.t + self.step
        return v


def const_clock(t=FIXED_NOW):
    return lambda: t


def rows_to_records(rows):
    return [{"segment_id": r.segment_id, "semantic_segment": r.blob, "start_timestamp_seconds": r.start_s,
             "end_timestamp_seconds": r.end_s, "segment_type": r.segment_type, "database_id": 1,
             "timestamp_millis": 1_790_000_000_000} for r in rows]


def make_db(path: Path, rows) -> Path:
    """Write an upstream-compatible odlh-storage.db (via upstream's own write_db)."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    upstream.geller().write_db(str(path), rows_to_records(rows))
    return Path(path)


def rows(seed=1, days=14):
    return synthetic.generate_rows(seed, days, END_DATE)


def setup_geller_secrets(cfg: Config, key: bytes):
    write_secret(cfg.master_file, FAKE_MASTER)
    write_secret(cfg.key_file, base64.b64encode(key).decode())
    write_secret(cfg.android_id_file, "0123456789abcdef")
    write_account_email(cfg, FAKE_EMAIL)


def seg_by(segs, pred):
    return [s for s in segs if pred(s)]
