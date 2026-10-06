import base64
import io
import json
import re

import pytest

from helpers import FAKE_EMAIL, FAKE_MASTER, FAKE_OAUTH_TOKEN, rows, make_db
from timeline_sync import cli, synthetic
from timeline_sync.secrets import read_secret, secure_mkdir


def run(capsys, *argv):
    rc = cli.main(list(argv))
    cap = capsys.readouterr()
    return rc, cap.out, cap.err


def test_status_on_empty_state(tmp_path, capsys):
    rc, out, _ = run(capsys, "status", "--data-dir", str(tmp_path / "d"))
    assert rc == 0
    assert "no sync has run yet" in out and "NOT real-time" in out
    rc, out, _ = run(capsys, "status", "--json", "--data-dir", str(tmp_path / "d"))
    doc = json.loads(out)
    assert rc == 0 and doc["status"] is None and doc["derived"]["realtime"] is False
    assert "not found" in doc["message"]


def test_sync_synthetic_end_to_end_then_status(tmp_path, capsys):
    d = str(tmp_path / "d")
    rc, out, err = run(capsys, "sync", "--source", "synthetic", "--data-dir", d, "--secrets-dir", str(tmp_path / "s"))
    assert rc == 0
    assert "131 total" in out and "adapter               : synthetic" in out and "NOT real-time" in out
    assert (tmp_path / "d" / "current" / "Timeline.json").is_file()
    assert all(json.loads(line)["event"] for line in err.strip().splitlines())      # stderr = JSON lines only

    rc, out, _ = run(capsys, "status", "--json", "--data-dir", d)
    doc = json.loads(out)
    assert doc["status"]["adapter"] == "synthetic" and doc["status"]["consecutive_failures"] == 0
    assert doc["derived"]["lag_hours"] is not None and doc["derived"]["realtime"] is False


def test_sync_env_var_configuration(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("TIMELINE_DATA_DIR", str(tmp_path / "envdata"))
    monkeypatch.setenv("TIMELINE_SECRETS_DIR", str(tmp_path / "envsec"))
    monkeypatch.setenv("TIMELINE_SOURCE", "synthetic")
    monkeypatch.setenv("TIMELINE_KEEP_EXPORTS", "1")
    assert run(capsys, "sync")[0] == 0
    assert (tmp_path / "envdata" / "state" / "sync-status.json").is_file()
    assert not (tmp_path / "envsec").exists()          # synthetic never creates the secrets dir


def test_invalid_env_and_source_are_rejected(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("TIMELINE_KEEP_EXPORTS", "abc")
    rc, _, err = run(capsys, "status", "--data-dir", str(tmp_path))
    assert rc == 2 and "TIMELINE_KEEP_EXPORTS" in err
    monkeypatch.delenv("TIMELINE_KEEP_EXPORTS")
    with pytest.raises(SystemExit) as ei:
        cli.main(["sync", "--source", "bogus"])
    assert ei.value.code == 2


def test_failing_sync_returns_nonzero_and_reports(tmp_path, capsys):
    rc, out, err = run(capsys, "sync", "--source", "geller", "--data-dir", str(tmp_path / "d"),
                       "--secrets-dir", str(tmp_path / "nosecrets"))
    assert rc == 1
    assert "sync FAILED at stage 'auth'" in err and "last-known-good" in err
    assert "auth                  : missing" in out and "consecutive failures  : 1" in out


def test_fetch_then_export_does_not_publish(tmp_path, capsys):
    d = str(tmp_path / "d")
    assert run(capsys, "fetch", "--source", "synthetic", "--data-dir", d)[0] == 0
    assert (tmp_path / "d" / "raw" / "odlh-storage.db").is_file()
    rc, out, _ = run(capsys, "export", "--source", "synthetic", "--data-dir", d)
    assert rc == 0 and "not published" in out
    exports = list((tmp_path / "d" / "exports").glob("Timeline-*.json"))
    assert len(exports) == 1
    doc = json.loads(exports[0].read_text(encoding="utf-8"))
    assert doc["exportMeta"]["adapter"] == "synthetic" and doc["semanticSegments"][0]["segmentId"]
    assert not (tmp_path / "d" / "current" / "Timeline.json").exists()


def test_export_without_raw_db_fails_cleanly(tmp_path, capsys):
    rc, _, err = run(capsys, "export", "--data-dir", str(tmp_path / "d"))
    assert rc == 1 and "fetch" in err


def test_local_db_source_via_cli(tmp_path, capsys):
    db = make_db(tmp_path / "container" / "odlh-storage.db", rows())
    d = str(tmp_path / "d")
    rc, out, _ = run(capsys, "sync", "--source", "local_db", "--local-db", str(db), "--data-dir", d)
    assert rc == 0 and "adapter               : local_db" in out
    st = json.loads((tmp_path / "d" / "state" / "sync-status.json").read_text(encoding="utf-8"))
    assert st["adapter"] == "local_db" and st["record_counts"]["total"] == 131
    assert st["last_cloud_request_at"] is None


def test_synthetic_command_generates_a_data_dir(tmp_path, capsys):
    out_dir = tmp_path / "syn"
    rc, out, _ = run(capsys, "synthetic", "--out", str(out_dir), "--end-date", "2026-09-27", "--days", "12", "--compress")
    assert rc == 0 and "synthetic data dir ready" in out
    doc = json.loads((out_dir / "current" / "Timeline.json").read_text(encoding="utf-8"))
    assert doc["exportMeta"]["adapter"] == "synthetic" and len(doc["semanticSegments"]) > 50
    assert run(capsys, "synthetic", "--out", str(out_dir), "--days", "3")[0] == 2      # too few days
    assert run(capsys, "synthetic", "--out", str(out_dir), "--end-date", "nope")[0] == 2


class FakeGpsoauth:
    def __init__(self, result):
        self.result, self.calls = result, []

    def exchange_token(self, email, token, android_id):
        self.calls.append((email, token, android_id))
        return self.result


def test_auth_stores_master_privately_and_prints_no_secret(tmp_path, capsys, monkeypatch):
    fake = FakeGpsoauth({"Token": FAKE_MASTER})
    monkeypatch.setattr(cli, "_import_gpsoauth", lambda: fake)
    monkeypatch.setattr("sys.stdin", io.StringIO(FAKE_OAUTH_TOKEN + "\n"))
    sec = tmp_path / "sec"
    rc, out, err = run(capsys, "auth", "--email", FAKE_EMAIL, "--oauth-token-stdin", "--secrets-dir", str(sec))
    assert rc == 0
    assert out.strip().splitlines()[0] == f"master token saved ({len(FAKE_MASTER)} chars not shown)"
    for needle in (FAKE_OAUTH_TOKEN, FAKE_MASTER, "FAKE_TEST_TOKEN", "FAKE_MASTER"):
        assert needle not in out + err
    assert (sec / "master.txt").read_text() == FAKE_MASTER
    assert json.loads((sec / "account.json").read_text()) == {"email": FAKE_EMAIL}     # email only
    aid = (sec / "android_id").read_text().strip()
    assert re.fullmatch(r"[0-9a-f]{16}", aid)
    assert fake.calls == [(FAKE_EMAIL, FAKE_OAUTH_TOKEN, aid)]
    from timeline_sync.secrets import check_perms
    assert check_perms(sec / "master.txt") is True and check_perms(sec) is True
    assert not list(sec.glob(".*.tmp"))

    # the android_id is reused, not regenerated, on a second run
    monkeypatch.setattr("sys.stdin", io.StringIO(FAKE_OAUTH_TOKEN + "\n"))
    assert run(capsys, "auth", "--email", FAKE_EMAIL, "--oauth-token-stdin", "--secrets-dir", str(sec))[0] == 0
    assert (sec / "android_id").read_text().strip() == aid


def test_auth_hidden_prompt_path(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(cli, "_import_gpsoauth", lambda: FakeGpsoauth({"Token": FAKE_MASTER}))
    prompts = []
    monkeypatch.setattr(cli.getpass, "getpass", lambda p="": prompts.append(p) or FAKE_OAUTH_TOKEN)
    rc, out, err = run(capsys, "auth", "--email", FAKE_EMAIL, "--secrets-dir", str(tmp_path / "s"))
    assert rc == 0 and prompts and "hidden" in prompts[0] and FAKE_OAUTH_TOKEN not in out + err


def test_auth_exchange_failure_stores_nothing(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(cli, "_import_gpsoauth", lambda: FakeGpsoauth({"Error": "BadAuthentication"}))
    monkeypatch.setattr("sys.stdin", io.StringIO(FAKE_OAUTH_TOKEN + "\n"))
    rc, out, err = run(capsys, "auth", "--email", FAKE_EMAIL, "--oauth-token-stdin", "--secrets-dir", str(tmp_path / "s"))
    assert rc == 1 and "BadAuthentication" in err and FAKE_OAUTH_TOKEN not in out + err
    assert not (tmp_path / "s" / "master.txt").exists()


def test_auth_from_browser_failure_suggests_stdin(tmp_path, capsys, monkeypatch):
    from timeline_sync import upstream
    tok = upstream.get_token()
    monkeypatch.setattr(tok, "oauth_token_from_browser",
                        lambda b: (_ for _ in ()).throw(SystemExit(f"could not read {b} cookies: app bound {FAKE_OAUTH_TOKEN}")))
    rc, out, err = run(capsys, "auth", "--email", FAKE_EMAIL, "--from-browser", "chrome", "--secrets-dir", str(tmp_path / "s"))
    assert rc == 1 and "--oauth-token-stdin" in err and "FAKE_TEST_TOKEN" not in err


def test_auth_rejects_bad_email(tmp_path, capsys):
    assert run(capsys, "auth", "--email", "nope", "--secrets-dir", str(tmp_path))[0] == 2


def test_key_command_preconditions(tmp_path, capsys):
    sec = tmp_path / "s"
    rc, _, err = run(capsys, "key", "--secrets-dir", str(sec))
    assert rc == 1 and "no email known" in err
    secure_mkdir(sec)
    (sec / "account.json").write_text(json.dumps({"email": FAKE_EMAIL}))
    rc, _, err = run(capsys, "key", "--secrets-dir", str(sec))
    assert rc == 1 and "master token missing" in err
    (sec / "master.txt").write_text(FAKE_MASTER)
    rc, _, err = run(capsys, "key", "--secrets-dir", str(sec))
    assert rc == 1 and "android_id missing" in err


def test_doctor_reports_booleans_only(tmp_path, capsys):
    sec = tmp_path / "s"
    secure_mkdir(sec)
    (sec / "master.txt").write_text(FAKE_MASTER)
    (sec / "key.b64").write_text(base64.b64encode(synthetic.synthetic_key(1)).decode())
    for f in ("master.txt", "key.b64"):   # like the real tool writes them; doctor rejects group/world-readable secrets on POSIX
        (sec / f).chmod(0o600)
    rc, out, err = run(capsys, "doctor", "--json", "--data-dir", str(tmp_path / "d"), "--secrets-dir", str(sec))
    assert rc == 0, out
    doc = json.loads(out)
    checks = {c["check"]: c for c in doc["checks"]}
    assert checks["upstream submodule present"]["level"] == "ok"
    assert checks["secret present: master token"]["level"] == "ok"
    assert checks["secret present: android_id"]["level"] == "warn"
    assert checks["data dir outside the repo"]["level"] == "ok"
    assert all(c["level"] == "ok" for n, c in checks.items() if n.startswith("upstream shim anchor"))
    for needle in (FAKE_MASTER, base64.b64encode(synthetic.synthetic_key(1)).decode()):
        assert needle not in out + err
    rc, out, _ = run(capsys, "doctor", "--data-dir", str(tmp_path / "d"), "--secrets-dir", str(sec))
    assert "[ OK ]" in out and "doctor:" in out


def test_no_command_prints_help(capsys):
    rc = cli.main([])
    assert rc == 2 and "usage" in capsys.readouterr().out.lower()
