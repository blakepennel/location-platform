import os
import subprocess

import pytest

from timeline_sync import secrets as sec
from timeline_sync.publish import rotate_exports, validate_export_file, ValidationError

FAKE = "aas_et/FAKE_MASTER_TOKEN_0123456789abcdefghij"


def test_write_secret_is_atomic_private_and_readable(tmp_path):
    d = tmp_path / "secrets" / "timeline"
    f = d / "master.txt"
    assert sec.write_secret(f, FAKE) == len(FAKE)
    assert sec.read_secret(f) == FAKE
    assert sec.check_perms(f) is True and sec.check_perms(d) is True
    assert sec.write_secret(f, FAKE + "2") == len(FAKE) + 1          # overwrite
    assert sec.read_secret(f) == FAKE + "2"
    assert [p.name for p in d.iterdir()] == ["master.txt"]            # no temp leftovers


def test_read_helpers_handle_missing_and_blank(tmp_path):
    assert sec.read_secret(tmp_path / "nope") is None and not sec.secret_present(tmp_path / "nope")
    (tmp_path / "blank").write_text("  \n")
    assert sec.read_secret(tmp_path / "blank") is None
    (tmp_path / "v").write_text(f"  {FAKE}\n")
    assert sec.read_secret(tmp_path / "v") == FAKE


def test_account_file_holds_the_email_only(cfg):
    sec.write_account_email(cfg, "tester@example.invalid")
    assert sec.read_account_email(cfg) == "tester@example.invalid"
    assert cfg.account_file.read_text() == '{"email": "tester@example.invalid"}'
    assert sec.read_account_email(cfg.with_overrides(secrets_dir=cfg.secrets_dir / "x")) is None


def test_secret_presence_is_boolean_only(cfg):
    p = sec.secret_presence(cfg)
    assert p == {"master_token": False, "key": False, "android_id": False, "account": False}
    sec.write_secret(cfg.master_file, FAKE)
    assert sec.secret_presence(cfg)["master_token"] is True


def test_check_perms_detects_world_readable(tmp_path):
    f = tmp_path / "leaky.txt"
    f.write_text("x")
    if os.name == "nt":
        subprocess.run(["icacls", str(f), "/grant", "Everyone:R"], capture_output=True, check=True)
        assert sec.check_perms(f) is False
        assert sec.secure_file(f) is True and sec.check_perms(f) is True
    else:
        os.chmod(f, 0o644)
        assert sec.check_perms(f) is False
        assert sec.secure_file(f) is True and sec.check_perms(f) is True
    assert sec.check_perms(tmp_path / "missing") is None


@pytest.mark.skipif(os.name == "nt", reason="POSIX modes")
def test_posix_modes_are_600_and_700(tmp_path):
    f = tmp_path / "a" / "b" / "k"
    sec.write_secret(f, "v")
    assert (f.stat().st_mode & 0o777) == 0o600 and (f.parent.stat().st_mode & 0o777) == 0o700


def test_validate_export_file_rules(tmp_path):
    p = tmp_path / "e.json"
    good = '{"semanticSegments":[{"segmentId":"a","segmentType":1}]}'
    p.write_text(good)
    assert validate_export_file(p, prev_total=None) == 1
    for bad, msg in (("not json", "parseable"), ('{"x":1}', "no semanticSegments"),
                     ('{"semanticSegments":[]}', "empty"), ('{"semanticSegments":[{"a":1}]}', "segmentId")):
        p.write_text(bad)
        with pytest.raises(ValidationError, match=msg):
            validate_export_file(p, prev_total=None)
    p.write_text(good)
    assert validate_export_file(p, prev_total=2) == 1                 # exactly 50%: allowed
    with pytest.raises(ValidationError, match="dropped"):
        validate_export_file(p, prev_total=3)
    assert validate_export_file(p, prev_total=3, allow_shrink=True) == 1


def test_rotate_exports_only_touches_timestamped_exports(tmp_path):
    names = [f"Timeline-2026090{i}T000000Z.json" for i in range(1, 6)]
    for n in names + ["notes.txt", "Timeline-latest.json"]:
        (tmp_path / n).write_text("x")
    removed = rotate_exports(tmp_path, 2)
    assert removed == names[:3]
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted(names[3:] + ["notes.txt", "Timeline-latest.json"])
    assert rotate_exports(tmp_path / "missing", 2) == []
