import base64
import hashlib
import json
import logging
import os

from helpers import FAKE_BEARER, FAKE_MASTER, FAKE_OAUTH_TOKEN
from timeline_sync.logging import configure_logging, log, redact, redact_deep, sanitize_message
from timeline_sync.secrets import Secret

KEY32 = os.urandom(32)


def test_redacts_all_token_shapes():
    cases = [
        FAKE_OAUTH_TOKEN,
        FAKE_BEARER,
        FAKE_MASTER,
        "Authorization: Bearer abc.DEF-123_xyz~+/=",
        "authorization: bearer lowercase.token-value",
        base64.b64encode(KEY32).decode(),                      # 44 chars with '=' padding
        base64.urlsafe_b64encode(KEY32).decode().rstrip("="),  # 43 chars, url-safe, unpadded
    ]
    for c in cases:
        out = redact(f"before {c} after")
        assert c not in out, c
        assert out.startswith("before ") and out.endswith(" after")
    assert redact(FAKE_OAUTH_TOKEN) == "oauth2_4/[REDACTED]"
    assert redact(FAKE_BEARER) == "ya29.[REDACTED]"
    assert redact(FAKE_MASTER) == "aas_et/[REDACTED]"


def test_does_not_mangle_ordinary_log_content():
    fine = ["segments=131", "2026-09-28T09:00:00Z", "synthetic-412827935430be8df2c9",
            hashlib.sha256(b"x").hexdigest(), "C:\\Users\\someone\\data\\current\\Timeline.json",
            "HTTP 401: Google rejected the access token", "stage=fetch"]
    for s in fine:
        assert redact(s) == s


def test_redacts_coordinates_in_strings_and_by_field_name():
    assert "10.0123456" not in redact("at 10.0123456\u00b0, 20.0123456\u00b0 today")
    d = redact_deep({"lat": 10.0, "longitude": 20.0, "latLng": "1.0", "ok": 3,
                     "nested": {"point": "x", "msg": f"tok {FAKE_BEARER}"}})
    assert d["lat"] == d["longitude"] == d["latLng"] == "[coords]" and d["ok"] == 3
    assert d["nested"]["point"] == "[coords]" and "ya29.FAKE" not in d["nested"]["msg"]


def test_sensitive_field_names_are_masked_but_booleans_survive():
    d = redact_deep({"token": "abc", "master_token_present": True, "authorization": "x", "key": "zz",
                     "key_present": False, "password": "p"})
    assert d["token"] == d["authorization"] == d["key"] == d["password"] == "[REDACTED]"
    assert d["master_token_present"] is True and d["key_present"] is False


def test_json_log_lines_on_stderr_are_redacted(capsys):
    configure_logging()
    log.info("auth.test", token=FAKE_OAUTH_TOKEN, note=f"got Bearer {FAKE_BEARER}",
             detail={"m": FAKE_MASTER}, lat=10.0, coords="10.0123456\u00b0, 20.0123456\u00b0", n=3)
    log.warning("plain %s" % FAKE_OAUTH_TOKEN)
    err = capsys.readouterr().err
    lines = [json.loads(line) for line in err.strip().splitlines()]
    assert lines[0]["level"] == "info" and lines[0]["event"] == "auth.test" and lines[0]["n"] == 3
    assert lines[1]["level"] == "warning"
    for needle in ("FAKE_TEST_TOKEN", "FAKE_BEARER", "FAKE_MASTER", "10.0123456", "20.0123456"):
        assert needle not in err
    assert lines[0]["lat"] == "[coords]"


def test_exception_details_never_reach_the_log(capsys):
    configure_logging()
    try:
        raise RuntimeError(f"secret in exception {FAKE_BEARER}")
    except RuntimeError:
        logging.getLogger("timeline_sync").exception("boom")
    err = capsys.readouterr().err
    assert "FAKE_BEARER" not in err and "Traceback" not in err and "RuntimeError" in err


def test_caplog_sees_only_redacted_records(caplog):
    configure_logging()
    with caplog.at_level(logging.INFO, logger="timeline_sync"):
        log.info("ev", token=FAKE_OAUTH_TOKEN, msg2=FAKE_BEARER)
    assert caplog.records
    for rec in caplog.records:
        assert FAKE_OAUTH_TOKEN not in rec.getMessage() and FAKE_BEARER not in json.dumps(rec.fields)
    assert "FAKE_TEST_TOKEN" not in caplog.text


def test_sanitize_message_truncates_and_redacts():
    m = sanitize_message(f"x {FAKE_BEARER}\nline2 " + "a b " * 200, limit=120)
    assert len(m) <= 120 and "\n" not in m and "ya29.FAKE" not in m


def test_secret_wrapper_never_prints_value():
    s = Secret(FAKE_BEARER)
    assert FAKE_BEARER not in f"{s} {s!r} {s:>40}" and "len=" in repr(s) and s.reveal() == FAKE_BEARER
