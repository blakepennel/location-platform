import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from timeline_sync import upstream


def test_upstream_is_pinned_and_pristine():
    if shutil.which("git") is None or upstream.upstream_commit() is None:
        pytest.skip("git checkout of the submodule not available")
    assert upstream.pin_matches() is True
    dirty = subprocess.run(["git", "-C", str(upstream.UPSTREAM_DIR), "status", "--porcelain"],
                           capture_output=True, text=True).stdout.strip()
    assert dirty == "", f"upstream/ must never be modified:\n{dirty}"


def test_shim_anchor_report_all_green():
    report = upstream.shim_compat_report()
    assert report and all(ok for _, ok, _ in report), report


def test_web_key_source_rewrite_replaces_the_tmp_literal_exactly_once(tmp_path):
    drv = str(tmp_path / "driver.js")
    src = upstream.prepare_web_key_source(drv)
    assert upstream.WEB_KEY_DRIVER_LITERAL not in src and "/tmp/.web_key_driver.js" not in src
    assert repr(drv) in src
    compile(src, "web_key_shimmed", "exec")                       # still valid Python
    original = upstream.upstream_path("web_key").read_text(encoding="utf-8")
    assert src.replace(repr(drv), upstream.WEB_KEY_DRIVER_LITERAL) == original   # nothing else changed


def test_web_key_source_rewrite_fails_loudly_if_upstream_changed():
    with pytest.raises(upstream.UpstreamError, match="found 0"):
        upstream.prepare_web_key_source("x", "no literal here")
    two = f"a = {upstream.WEB_KEY_DRIVER_LITERAL}\nb = {upstream.WEB_KEY_DRIVER_LITERAL}\n"
    with pytest.raises(upstream.UpstreamError, match="found 2"):
        upstream.prepare_web_key_source("x", two)


def test_run_web_key_executes_upstream_as_main_and_cleans_up(capsys):
    before = set(Path(tempfile.gettempdir()).glob("tlsync-webkey-*"))
    rc = upstream.run_web_key([])                                  # argparse: --email required -> exit 2
    assert rc == 2
    assert "required" in capsys.readouterr().err
    # a non-SystemExit failure is mapped to rc 1 without leaking exception text (no network is reached)
    rc = upstream.run_web_key(["--email", "x@example.invalid", "--android-id", "0123456789abcdef",
                               "--master-token-file", str(Path(tempfile.gettempdir()) / "definitely-missing-master")])
    assert rc == 1
    assert "FileNotFoundError" in capsys.readouterr().err
    assert set(Path(tempfile.gettempdir()).glob("tlsync-webkey-*")) == before     # tempdir removed


def test_redacting_stream_hides_final_url_and_tokens():
    import io
    buf = io.StringIO()
    s = upstream._RedactingStream(buf)
    s.write("[*] final url  : https://example.invalid/?x=oauth2_4/FAKE_TEST_TOKEN_1234567890abcdef\n")
    s.write("[*] page said: Bearer abc.def.ghi\npartial")
    s.flush()
    text = buf.getvalue()
    assert "example.invalid" not in text and "FAKE_TEST_TOKEN" not in text and "abc.def.ghi" not in text
    assert text.endswith("partial")


def test_detect_browser_prefers_chrome_then_edge_and_honours_override(tmp_path):
    pf, pf86 = tmp_path / "pf", tmp_path / "pf86"
    chrome = pf / "Google" / "Chrome" / "Application" / "chrome.exe"
    edge = pf86 / "Microsoft" / "Edge" / "Application" / "msedge.exe"
    env = {"ProgramFiles": str(pf), "ProgramFiles(x86)": str(pf86), "LOCALAPPDATA": str(tmp_path / "la"), "PATH": ""}
    edge.parent.mkdir(parents=True)
    edge.write_text("x")
    if os.name == "nt":
        assert upstream.detect_browser(env) == str(edge)
    chrome.parent.mkdir(parents=True)
    chrome.write_text("x")
    assert upstream.detect_browser(env) == str(chrome)
    other = tmp_path / "custom-chrome"
    other.write_text("x")
    assert upstream.detect_browser({**env, "CHROME_PATH": str(other)}) == str(other)
    la = tmp_path / "la" / "Google" / "Chrome" / "Application" / "chrome.exe"
    la.parent.mkdir(parents=True)
    la.write_text("x")
    chrome.unlink()
    assert upstream.detect_browser(env) == str(la)


def test_missing_upstream_gives_actionable_error(monkeypatch, tmp_path):
    monkeypatch.setattr(upstream, "UPSTREAM_DIR", tmp_path / "nope")
    upstream._reset_cache_for_tests()
    try:
        with pytest.raises(upstream.UpstreamError, match="submodule update --init"):
            upstream.geller()
    finally:
        monkeypatch.undo()
        upstream._reset_cache_for_tests()
