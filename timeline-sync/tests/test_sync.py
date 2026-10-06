"""End-to-end sync behaviour: atomic publish, last-known-good, validation, lock, rotation, enrich."""
import json
import os
import re

import httpx
import pytest

from helpers import Clock, FAKE_BEARER, FAKE_MASTER, const_clock, make_db, rows, setup_geller_secrets, END_DATE
from timeline_sync import publish, synthetic, sync as sync_mod, upstream
from timeline_sync.sources import (GellerCloudSource, HistoricalLocationSource, LocalDbSource, SourceError,
                                   SyntheticSource)
from timeline_sync.status import load_status, validate_status
from timeline_sync.sync import EXIT_FAILED, EXIT_LOCKED, EXIT_OK, SyncLock, run_sync


def synth(cfg, clock=None, **kw):
    kw.setdefault("end_date", END_DATE)
    return SyntheticSource(cfg, seed=1, days=14, clock=clock or const_clock(), **kw)


class FailingSource(HistoricalLocationSource):
    name = "geller"

    def __init__(self, stage="fetch", message="boom", auth_state=None):
        self.stage, self.message, self.auth_state = stage, message, auth_state

    def check_auth(self):
        from timeline_sync.sources import AuthHealth
        return AuthHealth("ok", True, True, "2026-09-28T09:00:00Z")

    def fetch(self, dest_db):
        raise SourceError(self.stage, self.message, auth_state=self.auth_state)


def no_temp_leftovers(root):
    bad = [p.name for p in root.rglob("*") if p.is_file() and (p.name.endswith(".tmp") or ".staging" in p.name)]
    assert bad == []


def test_first_sync_publishes_and_status_validates_against_schema(cfg, validate_status_schema):
    out = run_sync(cfg, synth(cfg), clock=const_clock())
    assert out.ok and out.exit_code == EXIT_OK
    assert cfg.current_export.is_file() and cfg.raw_db.is_file() and cfg.status_file.is_file()
    st = json.loads(cfg.status_file.read_text(encoding="utf-8"))
    validate_status_schema(st)
    assert validate_status(st) == []
    assert st["adapter"] == "synthetic" and st["source"] == "google_timeline"
    assert st["consecutive_failures"] == 0 and st["last_error"] is None
    assert st["record_counts"]["total"] == 131 and st["record_counts"]["deleted_skipped"] == 1
    assert st["last_cloud_request_at"] is None                   # synthetic never talks to Google
    assert st["newest_cloud_mutation_at"].endswith("Z")
    assert st["oldest_record_start"] < st["newest_record_end"]
    assert st["output"]["current_export"] == str(cfg.current_export.resolve())
    assert st["output"]["export_sha256"] == publish.sha256_file(cfg.current_export)
    assert st["output"]["enriched"] is False
    assert st["auth"]["state"] == "ok"
    assert len(list(cfg.exports_dir.glob("Timeline-*.json"))) == 1
    assert cfg.current_export.read_bytes() == next(cfg.exports_dir.glob("Timeline-*.json")).read_bytes()
    no_temp_leftovers(cfg.data_dir)
    assert not cfg.lock_file.exists()


def test_status_has_no_coordinates_or_place_data(cfg):
    run_sync(cfg, synth(cfg), clock=const_clock())
    text = cfg.status_file.read_text(encoding="utf-8")
    assert not re.search(r"-?\d{1,3}\.\d{4,}", text)
    assert "ChIJ" not in text and "latLng" not in text


def test_failed_fetch_preserves_last_known_good(cfg, validate_status_schema):
    clock = Clock()
    assert run_sync(cfg, synth(cfg), clock=clock).ok
    good = cfg.current_export.read_bytes()
    raw_good = cfg.raw_db.read_bytes()
    before = load_status(cfg)

    out = run_sync(cfg, FailingSource("fetch", "network error (ConnectError)"), clock=clock)
    assert not out.ok and out.exit_code == EXIT_FAILED
    assert cfg.current_export.read_bytes() == good and cfg.raw_db.read_bytes() == raw_good
    st = load_status(cfg)
    validate_status_schema(st)
    assert st["consecutive_failures"] == 1
    assert st["last_error"]["stage"] == "fetch" and "ConnectError" in st["last_error"]["message"]
    for k in ("last_success_at", "record_counts", "oldest_record_start", "newest_record_end", "output"):
        assert st[k] == before[k]                                 # previous success is preserved
    assert st["last_attempt_at"] != before["last_attempt_at"]

    run_sync(cfg, FailingSource("auth", "x", auth_state="expired"), clock=clock)
    st = load_status(cfg)
    assert st["consecutive_failures"] == 2 and st["auth"]["state"] == "expired"
    assert st["last_error"]["stage"] == "auth"

    assert run_sync(cfg, synth(cfg), clock=clock).ok
    st = load_status(cfg)
    assert st["consecutive_failures"] == 0 and st["last_error"] is None
    no_temp_leftovers(cfg.data_dir)


def test_wrong_key_fails_at_decrypt_stage_and_leaves_lkg_untouched(cfg, validate_status_schema):
    assert run_sync(cfg, synth(cfg), clock=Clock()).ok
    good = cfg.current_export.read_bytes()

    good_key, other_key = synthetic.synthetic_key(1), synthetic.synthetic_key(2)
    setup_geller_secrets(cfg, good_key)
    resp = synthetic.build_batch_sync_response(rows(), other_key, mutation_ms=5)
    transport = httpx.MockTransport(lambda r: httpx.Response(200, content=resp.body,
                                                             headers={"grpc-status": "0"}))
    src = GellerCloudSource(cfg, transport=transport, clock=Clock(),
                            oauth_func=lambda *a, **k: {"Auth": FAKE_BEARER})
    out = run_sync(cfg, src, clock=Clock())
    assert not out.ok and out.error["stage"] == "decrypt"
    assert cfg.current_export.read_bytes() == good
    st = load_status(cfg)
    validate_status_schema(st)
    assert st["adapter"] == "geller" and st["last_cloud_request_at"] is not None   # request itself worked
    assert st["consecutive_failures"] == 1


def test_http_401_through_sync_records_expired_auth(cfg, validate_status_schema):
    setup_geller_secrets(cfg, synthetic.synthetic_key(1))
    src = GellerCloudSource(cfg, transport=httpx.MockTransport(lambda r: httpx.Response(401)), clock=Clock(),
                            oauth_func=lambda *a, **k: {"Auth": FAKE_BEARER})
    out = run_sync(cfg, src, clock=Clock())
    assert out.exit_code == EXIT_FAILED
    st = load_status(cfg)
    validate_status_schema(st)
    assert st["auth"]["state"] == "expired" and st["auth"]["master_token_present"] and st["auth"]["key_present"]
    assert st["last_error"]["stage"] == "auth"
    assert not cfg.current_export.exists()                        # nothing was ever published


def test_missing_credentials_fail_fast_with_no_network(cfg):
    calls = []
    src = GellerCloudSource(cfg, transport=httpx.MockTransport(lambda r: calls.append(r) or httpx.Response(200)),
                            clock=Clock())
    out = run_sync(cfg, src, clock=Clock())
    assert out.error["stage"] == "auth" and not calls
    assert load_status(cfg)["auth"]["state"] == "missing"


def test_export_shrink_over_50_percent_is_refused_unless_allowed(cfg):
    assert run_sync(cfg, synth(cfg), clock=Clock()).ok
    good = cfg.current_export.read_bytes()
    small = make_db(cfg.data_dir.parent / "small.db", rows()[:20])
    src = LocalDbSource(cfg, path=small, clock=const_clock())

    out = run_sync(cfg, src, clock=Clock())
    assert not out.ok and out.error["stage"] == "export" and "dropped" in out.error["message"]
    assert cfg.current_export.read_bytes() == good
    assert load_status(cfg)["record_counts"]["total"] == 131      # LKG counts preserved

    out = run_sync(cfg, src, clock=Clock(), allow_shrink=True)
    assert out.ok and load_status(cfg)["record_counts"]["total"] <= 20
    assert load_status(cfg)["adapter"] == "local_db"
    assert cfg.current_export.read_bytes() != good


def test_small_drop_is_allowed(cfg):
    assert run_sync(cfg, synth(cfg), clock=Clock()).ok
    src = LocalDbSource(cfg, path=make_db(cfg.data_dir.parent / "s.db", rows()[:100]), clock=const_clock())
    assert run_sync(cfg, src, clock=Clock()).ok


def test_empty_export_is_refused(cfg):
    empty = make_db(cfg.data_dir.parent / "e.db", [])
    out = run_sync(cfg, LocalDbSource(cfg, path=empty, clock=const_clock()), clock=Clock())
    assert not out.ok and out.error["stage"] == "export" and "empty" in out.error["message"]
    assert not cfg.current_export.exists()


def test_missing_local_db_fails_at_auth_stage(cfg):
    out = run_sync(cfg, LocalDbSource(cfg, path=cfg.data_dir / "nope.db", clock=const_clock()), clock=Clock())
    assert not out.ok and out.error["stage"] == "auth"


def test_publish_failure_preserves_last_known_good(cfg, monkeypatch):
    assert run_sync(cfg, synth(cfg), clock=Clock()).ok
    good = cfg.current_export.read_bytes()
    monkeypatch.setattr(sync_mod, "atomic_copy", lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))
    out = run_sync(cfg, synth(cfg, end_date=END_DATE), clock=Clock())
    assert not out.ok and out.error["stage"] == "publish"
    assert cfg.current_export.read_bytes() == good
    no_temp_leftovers(cfg.data_dir)


def test_atomic_write_never_exposes_partial_content(tmp_path, monkeypatch):
    target = tmp_path / "t.json"
    publish.atomic_write_bytes(target, b"OLD")
    seen = []
    real_replace = os.replace

    def spying_replace(src, dst):
        seen.append((open(src, "rb").read(), open(dst, "rb").read()))   # at replace time: tmp is complete
        return real_replace(src, dst)
    monkeypatch.setattr(publish.os, "replace", spying_replace)
    publish.atomic_write_bytes(target, b"NEW-CONTENT")
    assert seen == [(b"NEW-CONTENT", b"OLD")] and target.read_bytes() == b"NEW-CONTENT"
    assert [p.name for p in tmp_path.iterdir()] == ["t.json"]


def test_lock_prevents_concurrent_sync(cfg):
    cfg.state_dir.mkdir(parents=True)
    lock = SyncLock(cfg.lock_file)
    lock.acquire()
    try:
        out = run_sync(cfg, synth(cfg), clock=const_clock())
        assert out.locked and out.exit_code == EXIT_LOCKED and not out.ok
        assert not cfg.current_export.exists() and not cfg.status_file.exists()
        with pytest.raises(sync_mod.LockHeldError):
            SyncLock(cfg.lock_file).acquire()
        assert cfg.lock_file.exists()                              # the loser must not delete the winner's lock
    finally:
        lock.release()
    assert run_sync(cfg, synth(cfg), clock=const_clock()).ok       # free again


def test_stale_lock_of_dead_process_is_reclaimed(cfg):
    cfg.state_dir.mkdir(parents=True)
    cfg.lock_file.write_text("99999999\n", encoding="ascii")
    assert not sync_mod.pid_alive(99999999) and sync_mod.pid_alive(os.getpid())
    assert run_sync(cfg, synth(cfg), clock=const_clock()).ok
    assert not cfg.lock_file.exists()


def test_exports_are_rotated_keeping_newest_n(cfg):
    cfg = cfg.with_overrides(keep_exports=2)
    clock = Clock()
    for _ in range(4):
        assert run_sync(cfg, synth(cfg), clock=clock).ok
    files = sorted(p.name for p in cfg.exports_dir.glob("Timeline-*.json"))
    assert len(files) == 2
    assert files == sorted(files) and re.fullmatch(r"Timeline-\d{8}T\d{6}Z\.json", files[0])
    assert cfg.current_export.exists()


def test_enrich_builds_full_records_with_windows_safe_shim(cfg, validate_status_schema):
    out = run_sync(cfg, synth(cfg), enrich=True, clock=const_clock())
    assert out.ok, out.error
    full = json.loads(cfg.current_full.read_text(encoding="utf-8"))
    assert set(full) == {"semanticSegments", "trips", "movements"}
    assert len(full["trips"]) == 1 and len(full["movements"]) == 46
    assert re.search(r"[A-Z][a-z]{2} \d{1,2}–\d{1,2}, 2026", full["trips"][0]["description"])   # daterange()
    assert full["trips"][0]["durationDays"] == 3
    raw = cfg.current_full.read_bytes()
    assert "°".encode() in raw and "Â°".encode() not in raw           # UTF-8, no mojibake
    st = load_status(cfg)
    validate_status_schema(st)
    assert st["output"]["enriched"] is True
    no_temp_leftovers(cfg.data_dir)


def test_enrich_failure_fails_sync_and_keeps_lkg(cfg, monkeypatch):
    assert run_sync(cfg, synth(cfg), clock=Clock()).ok
    good = cfg.current_export.read_bytes()
    br = upstream.build_records()
    monkeypatch.setattr(br, "build", lambda *a, **k: (_ for _ in ()).throw(ValueError("nope")))
    out = run_sync(cfg, synth(cfg), enrich=True, clock=Clock())
    assert not out.ok and out.error["stage"] == "enrich"
    assert cfg.current_export.read_bytes() == good and not cfg.current_full.exists()
    no_temp_leftovers(cfg.data_dir)


def test_build_records_daterange_shim_is_portable():
    br = upstream.build_records()
    assert br.daterange("2026-09-03T00:00:00+01:00", "2026-09-03T05:00:00+01:00") == "Sep 3, 2026"
    assert br.daterange("2026-09-03T00:00:00+01:00", "2026-09-05T05:00:00+01:00") == "Sep 3–5, 2026"
    assert br.daterange("2026-08-30T00:00:00+01:00", "2026-09-05T05:00:00+01:00") == "Aug 30 – Sep 5, 2026"
    assert br.daterange("2025-12-30T00:00:00+01:00", "2026-01-05T05:00:00+01:00") == "Dec 30, 2025 – Jan 5, 2026"
    assert upstream.build_records() is br                       # idempotent


@pytest.mark.skipif(os.name != "nt", reason="upstream %-d only breaks on Windows")
def test_unpatched_upstream_really_breaks_on_windows():
    import importlib.util
    spec = importlib.util.spec_from_file_location("raw_build_records", upstream.upstream_path("build_records"))
    raw = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(raw)
    with pytest.raises(ValueError):
        raw.daterange("2026-09-03T00:00:00+01:00", "2026-09-03T05:00:00+01:00")


def test_no_secrets_reach_stdout_stderr_or_status_during_geller_sync(cfg, capsys):
    setup_geller_secrets(cfg, synthetic.synthetic_key(1))
    resp = synthetic.build_batch_sync_response(rows(), synthetic.synthetic_key(1), mutation_ms=5)
    src = GellerCloudSource(cfg, clock=Clock(), oauth_func=lambda *a, **k: {"Auth": FAKE_BEARER},
                            transport=httpx.MockTransport(lambda r: httpx.Response(
                                200, content=resp.body, headers={"grpc-status": "0"})))
    assert run_sync(cfg, src, clock=Clock()).ok
    captured = capsys.readouterr()
    blob = captured.out + captured.err + cfg.status_file.read_text(encoding="utf-8")
    import base64
    key_b64 = base64.b64encode(synthetic.synthetic_key(1)).decode()
    for secret in (FAKE_BEARER, FAKE_MASTER, key_b64, "synthetic-sync-token"):
        assert secret not in blob
    assert "geller.fetch_ok" in captured.err                       # logging works and is structured
    for line in captured.err.strip().splitlines():
        json.loads(line)
    assert not re.search(r"-?\d{1,3}\.\d{4,}", captured.err)      # never coordinates


def test_status_reports_realtime_caveat(cfg, capsys):
    from timeline_sync.status import render_report
    from timeline_sync.sources import utcnow
    out = run_sync(cfg, synth(cfg), clock=const_clock())
    text = render_report(out.status, utcnow())
    assert "NOT real-time" in text and "lag" in text
