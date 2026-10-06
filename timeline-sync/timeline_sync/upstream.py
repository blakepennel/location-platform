"""Import helpers and runtime shims for the pinned upstream (arkenoi/timeline-export).

Nothing in ``upstream/`` is ever modified. Upstream scripts are loaded *by file path*
(``importlib``), so ``upstream/`` does not have to be on ``sys.path`` and its script names
cannot clash with anything. Where upstream is not import-friendly or not Windows-friendly we
patch the *loaded module object in memory* and document each shim in ``UPSTREAM.md``:

1. ``web_key.py``      hard-codes ``/tmp/.web_key_driver.js`` -> source text is rewritten to a
                       tempfile path, asserting the literal exists exactly once (fail loudly
                       if upstream changed), then exec'd as ``__main__``. stderr is redacted.
2. ``build_records.py`` uses strftime ``%-d`` (ValueError on Windows) -> ``daterange`` is
                       replaced with a portable equivalent; text-mode ``open`` defaults to UTF-8
                       (upstream relies on the locale encoding, which corrupts the ``°`` in
                       coordinate strings on Windows cp1252).
3. ``odlh_export.py``  ``build()`` drops ``segment_id`` for non-trip segments -> we reimplement
                       only its ~30-line loop in ``export.py`` and reuse upstream's decoders.
4. ``geller_fetch.py`` ``main()`` is a CLI that writes the bearer path/args around; we reuse its
                       functions and re-orchestrate main() in ``sources.py``.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from types import ModuleType
from typing import Callable, Optional

from .logging import redact

PINNED_COMMIT = "3c1faa0"
UPSTREAM_DIR = Path(__file__).resolve().parent.parent / "upstream"

WEB_KEY_DRIVER_LITERAL = '"/tmp/.web_key_driver.js"'


class UpstreamError(RuntimeError):
    """Upstream is missing or no longer has the shape the shims expect."""


_cache: dict[str, ModuleType] = {}


def upstream_path(name: str) -> Path:
    return UPSTREAM_DIR / f"{name}.py"


def _load(name: str) -> ModuleType:
    if name in _cache:
        return _cache[name]
    path = upstream_path(name)
    if not path.is_file():
        raise UpstreamError(
            f"upstream/{name}.py not found. Initialise the submodule: "
            "git submodule update --init timeline-sync/upstream")
    spec = importlib.util.spec_from_file_location(f"timeline_sync._upstream_{name}", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    _cache[name] = mod
    return mod


def geller() -> ModuleType:
    return _load("geller_fetch")


def odlh() -> ModuleType:
    return _load("odlh_export")


def get_token() -> ModuleType:
    return _load("get_token")


def _reset_cache_for_tests() -> None:
    _cache.clear()


# Place Details (New) fields that bill at the Essentials or Pro SKU. Anything outside this
# set (rating, phone, website, reviews, opening hours, ...) bills at Enterprise, so an
# upstream change that adds one is refused rather than silently raising the cost.
PLACES_ALLOWED_FIELDS = frozenset({
    "id", "displayName", "formattedAddress", "shortFormattedAddress", "addressComponents",
    "location", "types", "primaryType", "primaryTypeDisplayName", "businessStatus", "googleMapsUri",
})


def place_names() -> ModuleType:
    """Upstream place_names (Places API resolver), checked for shape and billing tier."""
    mod = _load("place_names")
    for attr in ("resolve", "FIELDS", "ENDPOINT"):
        if not hasattr(mod, attr):
            raise UpstreamError(f"upstream place_names.py no longer defines {attr!r}; the names shim needs updating")
    fields = {f.strip() for f in str(mod.FIELDS).split(",") if f.strip()}
    extra = sorted(fields - PLACES_ALLOWED_FIELDS)
    if extra:
        raise UpstreamError(
            f"upstream place_names.py now requests {', '.join(extra)}, which may bill at the "
            "Enterprise tier; refusing until PLACES_ALLOWED_FIELDS is reviewed")
    return mod


# --------------------------------------------------------------------- build_records shim
def _utf8_open(file, mode="r", *args, **kwargs):
    import builtins
    if "b" not in mode and "encoding" not in kwargs and not args[1:2]:
        kwargs["encoding"] = "utf-8"
    return builtins.open(file, mode, *args, **kwargs)


def build_records() -> ModuleType:
    """Upstream build_records with the Windows shims applied (idempotent)."""
    mod = _load("build_records")
    if getattr(mod, "_tlsync_patched", False):
        return mod
    for attr in ("daterange", "dt", "build"):
        if not hasattr(mod, attr):
            raise UpstreamError(f"upstream build_records.py has no {attr!r}; upstream changed - see UPSTREAM.md")

    dt = mod.dt

    def daterange(a, b):  # portable: no strftime %-d
        a, b = dt(a), dt(b)
        if a.year == b.year and a.month == b.month:
            return f"{a:%b} {a.day}–{b.day}, {a.year}" if a.day != b.day else f"{a:%b} {a.day}, {a.year}"
        if a.year == b.year:
            return f"{a:%b} {a.day} – {b:%b} {b.day}, {a.year}"
        return f"{a:%b} {a.day}, {a.year} – {b:%b} {b.day}, {b.year}"

    mod.daterange = daterange
    mod.open = _utf8_open
    mod._tlsync_patched = True
    return mod


# --------------------------------------------------------------------- web_key shim
def prepare_web_key_source(driver_path: str, source: Optional[str] = None) -> str:
    """Return web_key.py source with the /tmp driver literal replaced by ``driver_path``.

    Fails loudly if the literal is not present exactly once (upstream changed)."""
    if source is None:
        p = upstream_path("web_key")
        if not p.is_file():
            raise UpstreamError("upstream/web_key.py not found")
        source = p.read_text(encoding="utf-8")
    n = source.count(WEB_KEY_DRIVER_LITERAL)
    if n != 1:
        raise UpstreamError(
            f"expected the literal {WEB_KEY_DRIVER_LITERAL} exactly once in upstream/web_key.py, "
            f"found {n}; upstream changed - review UPSTREAM.md before continuing")
    return source.replace(WEB_KEY_DRIVER_LITERAL, repr(driver_path))


class _RedactingStream(io.TextIOBase):
    """stderr filter for the exec'd upstream script: line-buffered, redacts token-like text and
    hides the post-sign-in URL (which can embed session material)."""

    def __init__(self, target):
        self._t = target
        self._buf = ""

    def writable(self):
        return True

    def write(self, s):
        self._buf += s
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            self._t.write(self._clean(line) + "\n")
        return len(s)

    def flush(self):
        if self._buf:
            self._t.write(self._clean(self._buf))
            self._buf = ""
        self._t.flush()

    @staticmethod
    def _clean(line: str) -> str:
        if line.startswith("[*] final url"):
            return "[*] final url  : (hidden)"
        return redact(line)


def run_web_key(argv: list[str]) -> int:
    """Run upstream web_key.py with the Windows/tempfile shim. Returns an exit code."""
    tmpdir = tempfile.mkdtemp(prefix="tlsync-webkey-")
    driver = os.path.join(tmpdir, "web_key_driver.js")
    path = upstream_path("web_key")
    src = prepare_web_key_source(driver)
    code = compile(src, str(path), "exec")
    ns = {"__name__": "__main__", "__file__": str(path)}
    old_argv = sys.argv
    sys.argv = [str(path)] + list(argv)
    rc = 0
    stream = _RedactingStream(sys.stderr)
    try:
        with contextlib.redirect_stderr(stream):
            try:
                exec(code, ns)
            except SystemExit as e:
                if e.code in (None, 0):
                    rc = 0
                elif isinstance(e.code, int):
                    rc = e.code
                else:
                    sys.stderr.write(redact(str(e.code)) + "\n")
                    rc = 1
            except Exception as e:  # noqa: BLE001 - message may contain paths/URLs; keep only the type
                sys.stderr.write(f"upstream web_key.py raised {type(e).__name__}\n")
                rc = 1
    finally:
        try:
            stream.flush()
        except Exception:
            pass
        sys.argv = old_argv
        shutil.rmtree(tmpdir, ignore_errors=True)
    return rc


# --------------------------------------------------------------------- environment probes
def upstream_commit() -> Optional[str]:
    """HEAD of the submodule checkout, or None if git/submodule is unavailable."""
    if not UPSTREAM_DIR.is_dir():
        return None
    try:
        p = subprocess.run(["git", "-C", str(UPSTREAM_DIR), "rev-parse", "HEAD"],
                           capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return None
    sha = p.stdout.strip()
    return sha if p.returncode == 0 and re.fullmatch(r"[0-9a-f]{40}", sha) else None


def upstream_commit_or_pin() -> str:
    return upstream_commit() or PINNED_COMMIT


def pin_matches() -> Optional[bool]:
    sha = upstream_commit()
    if sha is None:
        return None
    return sha.startswith(PINNED_COMMIT)


def node_modules_dir() -> Path:
    return UPSTREAM_DIR / "node_modules"


def puppeteer_installed() -> bool:
    return (node_modules_dir() / "puppeteer-core" / "package.json").is_file()


def detect_browser(env: Optional[dict] = None) -> Optional[str]:
    """Find Chrome (preferred) or Edge. CHROME_PATH wins if it exists."""
    env = os.environ if env is None else env
    explicit = env.get("CHROME_PATH")
    if explicit and Path(explicit).is_file():
        return explicit
    cands: list[Path] = []
    for var in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
        base = env.get(var)
        if base:
            cands.append(Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe")
    for var in ("ProgramFiles(x86)", "ProgramFiles"):
        base = env.get(var)
        if base:
            cands.append(Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe")
    for c in cands:
        if c.is_file():
            return str(c)
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "msedge"):
        w = shutil.which(name)
        if w:
            return w
    return None


def run_resolve_names(input_json: Path, *, chrome: str, delay_ms: int = 2500,
                      timeout_s: Optional[float] = None) -> int:
    """Run upstream resolve_names.js (headless Chrome, no API key) on ``input_json``.

    Upstream keeps its cache beside the input (``place_cache_browser.json``) and reads an
    optional EU consent-cookie jar from the same directory. Progress goes to our stderr.
    """
    script = UPSTREAM_DIR / "resolve_names.js"
    if not script.is_file():
        raise UpstreamError("upstream/resolve_names.js not found; initialise the submodule")
    if not puppeteer_installed():
        raise UpstreamError("puppeteer-core is not installed: run `npm ci --prefix timeline-sync/upstream`")
    env = dict(os.environ, CHROME_PATH=chrome, RESOLVE_DELAY_MS=str(delay_ms))
    node = shutil.which("node")
    if not node:
        raise UpstreamError("node is not on PATH")
    p = subprocess.run([node, str(script), str(input_json)], cwd=str(UPSTREAM_DIR), env=env,
                       timeout=timeout_s)
    return p.returncode


def shim_compat_report() -> list[tuple[str, bool, str]]:
    """Anchor checks used by ``doctor``: (name, ok, detail). Read-only, no execution of upstream main."""
    out: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        out.append((name, bool(ok), detail))

    try:
        wk = upstream_path("web_key").read_text(encoding="utf-8")
        check("web_key driver literal (x1)", wk.count(WEB_KEY_DRIVER_LITERAL) == 1)
    except OSError:
        check("web_key driver literal (x1)", False, "upstream/web_key.py unreadable")
    try:
        br = upstream_path("build_records").read_text(encoding="utf-8")
        check("build_records has daterange()", "def daterange(" in br)
    except OSError:
        check("build_records has daterange()", False, "upstream/build_records.py unreadable")
    try:
        g = geller()
        need = ("build_request", "grpc_frame", "grpc_unframe", "parse", "one", "snapshots",
                "rows_of", "sync_token_of", "write_db", "decrypt")
        missing = [n for n in need if not callable(getattr(g, n, None))]
        check("geller_fetch API", not missing, ", ".join(missing))
    except Exception as e:  # noqa: BLE001
        check("geller_fetch API", False, type(e).__name__)
    try:
        o = odlh()
        need = ("dec_visit", "dec_activity", "dec_path", "dec_trip", "fields", "first",
                "submsg", "ts_of", "iso", "to_signed")
        missing = [n for n in need if not callable(getattr(o, n, None))]
        check("odlh_export API", not missing, ", ".join(missing))
    except Exception as e:  # noqa: BLE001
        check("odlh_export API", False, type(e).__name__)
    try:
        t = get_token()
        need = ("SCOPE", "APP", "CLIENT_SIG", "resolve_android_id", "oauth_token_from_browser")
        missing = [n for n in need if not hasattr(t, n)]
        check("get_token API", not missing, ", ".join(missing))
    except Exception as e:  # noqa: BLE001
        check("get_token API", False, type(e).__name__)
    return out
