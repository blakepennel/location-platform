"""timeline-sync command line.

    auth     one-time: browser oauth_token -> master token (stored privately, never printed)
    key      one-time: headful browser retrieval of the Timeline AES key (shimmed upstream web_key.py)
    fetch    adapter fetch -> data/raw/odlh-storage.db
    export   raw db -> data/exports/Timeline-<ts>.json (does NOT publish)
    sync     the routine command: fetch -> export -> [enrich] -> validate -> atomic publish -> status
    status   freshness report from state/sync-status.json
    doctor   environment / upstream / secrets-presence checks (booleans only)
    synthetic  generate a synthetic data dir for developing other projects
"""
from __future__ import annotations

import argparse
import base64
import binascii
import getpass
import json
import os
import shutil
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Optional

from . import __version__, upstream
from .config import Config, ConfigError
from .export import ExportError, export_db
from .logging import configure_logging, redact, sanitize_message
from .publish import export_filename
from .secrets import (check_perms, read_account_email, read_secret, secret_presence, secure_file,
                      secure_mkdir, write_account_email, write_secret)
from .sources import SourceError, SyntheticSource, iso_z, make_source, utcnow
from .status import derive, load_status, render_report
from .sync import EXIT_FAILED, EXIT_LOCKED, LockHeldError, SyncLock, run_sync

# ------------------------------------------------------------------ helpers
def out(msg: str = "") -> None:
    print(redact(msg))


def err(msg: str) -> None:
    print(redact(msg), file=sys.stderr)


def _import_gpsoauth():
    import gpsoauth
    return gpsoauth


def _source_kwargs(args) -> dict:
    if (getattr(args, "source", None) or "") == "local_db" and getattr(args, "local_db", None):
        return {"path": Path(args.local_db)}
    return {}


# ------------------------------------------------------------------ auth
def cmd_auth(args, cfg: Config) -> int:
    email = args.email.strip()
    if "@" not in email:
        err("error: --email must be an email address")
        return 2
    token = _read_oauth_token(args)
    if token is None:
        return 1
    if not token.startswith("oauth2_4/"):
        err("warning: the oauth_token usually starts with 'oauth2_4/'; continuing")

    secure_mkdir(cfg.secrets_dir)
    tok_mod = upstream.get_token()
    android_id = tok_mod.resolve_android_id(path=str(cfg.android_id_file))
    secure_file(cfg.android_id_file)

    try:
        gp = _import_gpsoauth()
        r = gp.exchange_token(email, token, android_id)
    except ImportError:
        err("error: gpsoauth is not installed (pip install gpsoauth)")
        return 1
    except Exception as e:  # noqa: BLE001 - network errors can embed URLs
        err(f"error: token exchange request failed ({type(e).__name__})")
        return 1
    finally:
        token = None
    master = r.get("Token") if isinstance(r, dict) else None
    if not master:
        code = str(r.get("Error") or r.get("ErrorDetail") or "unknown") if isinstance(r, dict) else "unknown"
        err(f"error: token exchange failed: {sanitize_message(code, 80)}\n"
            "  the oauth_token is single-use and short-lived: redo the browser sign-in and try again")
        return 1
    n = write_secret(cfg.master_file, master)
    write_account_email(cfg, email)
    master = None
    out(f"master token saved ({n} chars not shown)")
    out("next: timeline-sync key   (one-time, opens a browser window for your password)")
    return 0


def _read_oauth_token(args) -> Optional[str]:
    if args.oauth_token_stdin:
        tok = sys.stdin.readline().strip()
        if not tok:
            err("error: no oauth_token received on stdin")
            return None
        return tok
    if args.from_browser:
        try:
            return upstream.get_token().oauth_token_from_browser(args.from_browser)
        except SystemExit as e:
            err(f"error: {sanitize_message(e.code if isinstance(e.code, str) else 'could not read cookie', 400)}")
            err("hint: Chrome on Windows (v127+) uses app-bound cookie encryption, so reading its cookies "
                "often fails. Use --oauth-token-stdin instead (copy the oauth_token cookie from DevTools > "
                "Application > Cookies > accounts.google.com), or try --from-browser firefox.")
            return None
    try:
        tok = getpass.getpass("oauth_token cookie value (input hidden): ").strip()
    except (EOFError, KeyboardInterrupt):
        tok = ""
    if not tok:
        err("error: no oauth_token entered")
        return None
    return tok


# ------------------------------------------------------------------ key
def cmd_key(args, cfg: Config) -> int:
    email = args.email or read_account_email(cfg)
    if not email:
        err("error: no email known; run `timeline-sync auth --email ...` first (or pass --email)")
        return 1
    if not read_secret(cfg.master_file):
        err("error: master token missing; run `timeline-sync auth` first")
        return 1
    android_id = read_secret(cfg.android_id_file)
    if not android_id:
        err("error: android_id missing; run `timeline-sync auth` first")
        return 1
    if not shutil.which("node"):
        err("error: Node.js (node) not found on PATH; it is needed once for key retrieval")
        return 1
    if not upstream.puppeteer_installed():
        err("error: puppeteer-core is not installed for upstream. Run once:\n"
            f"  npm ci --prefix \"{upstream.UPSTREAM_DIR}\"")
        return 1
    chrome = args.chrome or upstream.detect_browser()
    if not chrome:
        err("error: Chrome/Edge not found. Install one or pass --chrome <path> (or set CHROME_PATH).")
        return 1
    secure_mkdir(cfg.secrets_dir)
    argv = ["--email", email, "--android-id", android_id, "--master-token-file", str(cfg.master_file),
            "--headful", "--chrome", chrome, "--node-path", str(upstream.node_modules_dir()),
            "--timeout", str(args.timeout), "-o", str(cfg.key_file)]
    if args.enroll:
        argv.append("--enroll")
    out("opening a browser window: complete the Google password prompt there...")
    rc = upstream.run_web_key(argv)
    if rc != 0:
        err(f"error: key retrieval failed (exit {rc})")
        return rc
    raw = read_secret(cfg.key_file)
    if not raw:
        err("error: key file was not written")
        return 1
    secure_file(cfg.key_file)
    try:
        klen = len(base64.b64decode(raw, validate=True))
    except (binascii.Error, ValueError):
        err("error: key file is not valid base64")
        return 1
    if klen != 32:
        err(f"warning: key is {klen} bytes (expected 32)")
    out(f"key saved ({len(raw)} chars not shown)")
    return 0


# ------------------------------------------------------------------ fetch / export
def cmd_fetch(args, cfg: Config) -> int:
    try:
        source = make_source(cfg, args.source, **_source_kwargs(args))
        with SyncLock(cfg.lock_file):
            cfg.raw_dir.mkdir(parents=True, exist_ok=True)
            res = source.fetch(cfg.raw_db)
    except LockHeldError:
        err("error: another timeline-sync run holds the lock")
        return EXIT_LOCKED
    except SourceError as e:
        err(f"fetch failed [{e.stage}]: {e.message}")
        return EXIT_FAILED
    out(f"fetched {res.segments_written} segments from {res.snapshots} snapshot(s) -> {cfg.raw_db}")
    return 0


def cmd_export(args, cfg: Config) -> int:
    now = utcnow()
    dest = Path(args.output) if args.output else cfg.exports_dir / export_filename(now)
    try:
        with SyncLock(cfg.lock_file):
            res = export_db(cfg.raw_db, dest, adapter=args.source or cfg.source, now=now,
                            default_utc_offset_min=cfg.default_utc_offset_min)
    except LockHeldError:
        err("error: another timeline-sync run holds the lock")
        return EXIT_LOCKED
    except ExportError as e:
        err(f"export failed: {e}")
        return EXIT_FAILED
    c = res.stats.as_record_counts()
    out(f"exported {c['total']} segments (visit {c['visit']}, activity {c['activity']}, "
        f"path {c['timelinePath']}, trip {c['trip']}; deleted skipped {c['deleted_skipped']}, "
        f"decode errors {c['decode_errors']}) -> {res.path}")
    out("not published: run `timeline-sync sync` to publish current/Timeline.json")
    return 0


# ------------------------------------------------------------------ sync
def cmd_sync(args, cfg: Config) -> int:
    try:
        source = make_source(cfg, args.source, **_source_kwargs(args))
    except ValueError as e:
        err(f"error: {e}")
        return 2
    outcome = run_sync(cfg, source, enrich=args.enrich, allow_shrink=args.allow_shrink)
    if outcome.locked:
        err("another timeline-sync run holds the lock; nothing was done")
        return outcome.exit_code
    out(render_report(outcome.status, utcnow()))
    if not outcome.ok and outcome.error:
        err(f"sync FAILED at stage '{outcome.error['stage']}': {outcome.error['message']}")
        err("last-known-good current/Timeline.json was left untouched")
    return outcome.exit_code


# ------------------------------------------------------------------ names
def cmd_names(args, cfg: Config) -> int:
    from . import names as N
    if not cfg.current_export.exists():
        err("no published export yet: run `timeline-sync sync` first")
        return EXIT_FAILED
    browser = args.method == "browser"
    key = None
    if not browser:
        try:
            key = N.load_api_key(cfg)
        except N.NamesError as e:
            err(f"error: {e}")
            return 2
        if key is None and not args.dry_run:
            err(f"no Places API key found: save it (one line, starts with AIza) to {cfg.places_key_file}")
            return 2
    doc = json.loads(cfg.current_export.read_text(encoding="utf-8"))
    cap = args.max or cfg.names_max_per_run
    try:
        with SyncLock(cfg.lock_file):
            if browser:
                res = N.resolve_names_browser(cfg, doc, dry_run=args.dry_run, max_lookups=cap)
            else:
                res = N.resolve_names(cfg, doc, dry_run=args.dry_run, max_lookups=cap, key=key)
            if not args.dry_run and (res.resolved or res.cached):
                res.named_visits = N.publish_names(cfg)
    except LockHeldError:
        err("error: another timeline-sync run holds the lock")
        return EXIT_LOCKED
    except (N.NamesError, upstream.UpstreamError) as e:
        err(f"error: {e}")
        return EXIT_FAILED

    this_run = min(res.todo, cap)
    if browser:
        out("Place names (headless Chrome via upstream resolve_names.js; no key, no billing)")
    else:
        out("Place names (Google Places API, New)")
        out(f"  API key               : {'found' if key else 'NOT FOUND'} ({cfg.places_key_file})")
    out(f"  places in Timeline    : {res.distinct} distinct")
    out(f"  already named/cached  : {res.cached}")
    out(f"  still to look up      : {res.todo}  (per-run cap {cap})")
    if res.dry_run:
        if browser:
            mins = max(1, round(this_run * N.BROWSER_SECONDS_PER_PLACE / 60))
            out(f"  this run would open   : {this_run} Google Maps pages (most-visited first), about {mins} min")
            out("DRY RUN: no pages were opened.")
        else:
            out(f"  this run would send   : {this_run} Place Details requests (most-visited places first)")
            out("  cost                  : Place Details Pro, 5,000 free/month per billing account, then $17 per 1,000")
            out("DRY RUN: nothing was sent to Google.")
        return 0
    extra = f", unreadable {res.errors}" if browser else ""
    out(f"  looked up this run    : {res.requested}  (named {res.resolved}, not found {res.not_found}{extra})")
    if res.mismatched:
        out(f"  note                  : {res.mismatched} named places were merged/moved by Google (kept, flagged)")
    out(f"  remaining             : {res.remaining}")
    if res.named_visits:
        out(f"  published             : {res.named_visits} visits now carry names in current/Timeline.json")
        out("  timeline-mcp picks this up automatically (or run: npm run index -w timeline-mcp)")
    if res.stopped:
        err(f"stopped early: {res.stopped}")
        return EXIT_FAILED if res.resolved == 0 else 0
    if res.remaining:
        out(f"run `timeline-sync names` again to continue ({res.remaining} left).")
    return 0


# ------------------------------------------------------------------ status
def cmd_status(args, cfg: Config) -> int:
    status = load_status(cfg)
    now = utcnow()
    if args.json:
        payload = {"status": status, "derived": derive(status, now) if status else derive({}, now)}
        if status is None:
            payload["message"] = "no sync has run yet (state/sync-status.json not found)"
        print(json.dumps(payload, indent=2))
    else:
        out(render_report(status, now))
    return 0


# ------------------------------------------------------------------ doctor
def cmd_doctor(args, cfg: Config) -> int:
    checks: list[tuple[str, str, str]] = []

    def add(label: str, level: str, detail: str = "") -> None:
        checks.append((label, level, detail))

    add("python >= 3.10", "ok" if sys.version_info >= (3, 10) else "fail", sys.version.split()[0])
    for mod, required in (("httpx", True), ("h2", True), ("cryptography", True), ("gpsoauth", True),
                          ("browser_cookie3", False)):
        try:
            __import__(mod)
            add(f"python module {mod}", "ok")
        except ImportError:
            add(f"python module {mod}", "fail" if required else "warn",
                "missing" if required else "optional: pip install timeline-sync[browser] (auth --from-browser)")

    if upstream.UPSTREAM_DIR.is_dir() and upstream.upstream_path("geller_fetch").is_file():
        add("upstream submodule present", "ok", str(upstream.UPSTREAM_DIR))
        pm = upstream.pin_matches()
        sha = upstream.upstream_commit()
        if pm is None:
            add(f"upstream pin {upstream.PINNED_COMMIT}", "warn", "cannot read submodule HEAD (git unavailable?)")
        elif pm:
            add(f"upstream pin {upstream.PINNED_COMMIT}", "ok", (sha or "")[:12])
        else:
            add(f"upstream pin {upstream.PINNED_COMMIT}", "warn", f"HEAD is {(sha or '')[:12]}; run the tests before trusting it")
        for name, ok, detail in upstream.shim_compat_report():
            add(f"upstream shim anchor: {name}", "ok" if ok else "fail", detail)
    else:
        add("upstream submodule present", "fail", "run: git submodule update --init timeline-sync/upstream")

    add("node", "ok" if shutil.which("node") else "warn", "" if shutil.which("node") else "needed once, for `key`")
    add("npm", "ok" if shutil.which("npm") else "warn", "" if shutil.which("npm") else "needed once, to install puppeteer-core")
    add("puppeteer-core in upstream/node_modules", "ok" if upstream.puppeteer_installed() else "warn",
        "" if upstream.puppeteer_installed() else f'run: npm ci --prefix "{upstream.UPSTREAM_DIR}"')
    br = upstream.detect_browser()
    add("Chrome/Edge", "ok" if br else "warn", Path(br).name if br else "needed once, for `key`")

    add("data dir", "ok", str(cfg.data_dir))
    add("secrets dir", "ok" if cfg.secrets_dir.is_dir() else "warn", str(cfg.secrets_dir))
    try:
        cfg.data_dir.resolve().relative_to(Path(__file__).resolve().parent.parent.parent)
        add("data dir outside the repo", "fail", "data dir is inside the checkout")
    except ValueError:
        add("data dir outside the repo", "ok")
    pres = secret_presence(cfg)
    for label, key in (("master token", "master_token"), ("Timeline key", "key"),
                       ("android_id", "android_id"), ("account email", "account")):
        add(f"secret present: {label}", "ok" if pres[key] else "warn", "" if pres[key] else "not set up yet")
    for label, path in (("secrets dir", cfg.secrets_dir), ("master.txt", cfg.master_file), ("key.b64", cfg.key_file)):
        perm = check_perms(path)
        if perm is None:
            continue
        add(f"private permissions: {label}", "ok" if perm else "fail",
            "" if perm else "readable by other users; fix with icacls/chmod")
    st = load_status(cfg)
    add("sync status file", "ok" if st else "warn", "" if st else "no sync has run yet")
    add(f"configured source: {cfg.source}", "ok")

    worst = "ok"
    for _, level, _ in checks:
        if level == "fail":
            worst = "fail"
        elif level == "warn" and worst != "fail":
            worst = "warn"
    if args.json:
        print(json.dumps({"ok": worst != "fail", "checks": [
            {"check": l, "level": lv, "detail": d} for l, lv, d in checks]}, indent=2))
    else:
        tag = {"ok": " OK ", "warn": "WARN", "fail": "FAIL"}
        for label, level, detail in checks:
            out(f"[{tag[level]}] {label}" + (f"  - {detail}" if detail else ""))
        out("")
        out("doctor: " + {"ok": "all good", "warn": "usable, with warnings", "fail": "problems found"}[worst])
    return 1 if worst == "fail" else 0


# ------------------------------------------------------------------ synthetic
def cmd_synthetic(args, cfg: Config) -> int:
    dest = Path(args.out).expanduser().resolve()
    try:
        end = date.fromisoformat(args.end_date) if args.end_date else None
    except ValueError:
        err("error: --end-date must be YYYY-MM-DD")
        return 2
    scfg = cfg.with_overrides(data_dir=dest, secrets_dir=dest / ".no-secrets", source="synthetic")
    try:
        src = SyntheticSource(scfg, seed=args.seed, days=args.days, end_date=end, compress=args.compress)
    except ValueError as e:
        err(f"error: {e}")
        return 2
    try:
        outcome = run_sync(scfg, src, enrich=args.enrich)
    except ValueError as e:
        err(f"error: {e}")
        return 2
    out(render_report(outcome.status, utcnow()))
    if not outcome.ok:
        err(f"synthetic sync FAILED: {outcome.error and outcome.error['message']}")
        return outcome.exit_code
    out("")
    out(f"synthetic data dir ready: {dest}")
    out(f"  use with:  TIMELINE_DATA_DIR={dest}")
    return 0


# ------------------------------------------------------------------ parser
def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--data-dir", default=argparse.SUPPRESS, help="override TIMELINE_DATA_DIR")
    common.add_argument("--secrets-dir", default=argparse.SUPPRESS, help="override TIMELINE_SECRETS_DIR")

    src_common = argparse.ArgumentParser(add_help=False)
    src_common.add_argument("--source", choices=("geller", "synthetic", "local_db"),
                            help="override TIMELINE_SOURCE (default geller)")
    src_common.add_argument("--local-db", help="odlh-storage.db path for --source local_db (or TIMELINE_LOCAL_DB)")

    p = argparse.ArgumentParser(prog="timeline-sync", description=__doc__.split("\n\n")[0])
    p.add_argument("--version", action="version", version=f"timeline-sync {__version__}")
    sub = p.add_subparsers(dest="cmd", metavar="COMMAND")

    a = sub.add_parser("auth", parents=[common], help="one-time: store the Google master token")
    a.add_argument("--email", required=True)
    a.add_argument("--from-browser", metavar="BROWSER", choices=("chrome", "edge", "firefox", "brave", "chromium"),
                   help="read the oauth_token cookie from a local browser (Chrome on Windows often fails)")
    a.add_argument("--oauth-token-stdin", action="store_true",
                   help="read the oauth_token from stdin instead of a hidden prompt")
    a.set_defaults(func=cmd_auth)

    k = sub.add_parser("key", parents=[common], help="one-time: fetch the Timeline AES key via a headful browser")
    k.add_argument("--email", help="default: the email stored by `auth`")
    k.add_argument("--chrome", help="Chrome/Edge executable (default: auto-detect)")
    k.add_argument("--timeout", type=int, default=300, help="seconds to wait for you to finish the prompt")
    k.add_argument("--enroll", action="store_true", help="attempt INITIAL_ENROLLMENT instead of retrieval")
    k.set_defaults(func=cmd_key)

    f = sub.add_parser("fetch", parents=[common, src_common], help="fetch -> data/raw/odlh-storage.db")
    f.set_defaults(func=cmd_fetch)

    e = sub.add_parser("export", parents=[common, src_common], help="decode raw db -> data/exports/Timeline-<ts>.json")
    e.add_argument("--output", help="write here instead of data/exports/")
    e.set_defaults(func=cmd_export)

    s = sub.add_parser("sync", parents=[common, src_common], help="fetch, export, validate and publish (routine)")
    s.add_argument("--enrich", action="store_true", help="also build current/Timeline-full.json (upstream build_records)")
    s.add_argument("--allow-shrink", action="store_true", help="publish even if the record count dropped by >50%%")
    s.set_defaults(func=cmd_sync)

    n = sub.add_parser("names", parents=[common],
                       help="name visited places (headless Chrome or Places API; cached, capped, dry-run first)")
    n.add_argument("--method", choices=("browser", "api"), default=os.environ.get("TIMELINE_NAMES_METHOD", "browser"),
                   help="browser = upstream headless Chrome, free (default); api = Google Places API (New), needs a key")
    n.add_argument("--dry-run", action="store_true", help="show how many lookups would be sent; send nothing")
    n.add_argument("--max", type=int, help="max lookups this run (default TIMELINE_NAMES_MAX_PER_RUN or 150)")
    n.set_defaults(func=cmd_names)

    st = sub.add_parser("status", parents=[common], help="freshness report from state/sync-status.json")
    st.add_argument("--json", action="store_true")
    st.set_defaults(func=cmd_status)

    d = sub.add_parser("doctor", parents=[common], help="check dependencies, upstream pin, secrets presence")
    d.add_argument("--json", action="store_true")
    d.set_defaults(func=cmd_doctor)

    y = sub.add_parser("synthetic", parents=[common], help="generate a synthetic data dir (fake places only)")
    y.add_argument("--out", required=True, help="directory to use as TIMELINE_DATA_DIR")
    y.add_argument("--days", type=int, default=14)
    y.add_argument("--seed", type=int, default=1)
    y.add_argument("--end-date", help="last day of data, YYYY-MM-DD (default: yesterday, UTC)")
    y.add_argument("--compress", action="store_true", help="gzip-compress the gRPC frame")
    y.add_argument("--enrich", action="store_true")
    y.set_defaults(func=cmd_synthetic)
    return p


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 2
    configure_logging()
    try:
        cfg = Config.from_env(
            data_dir=Path(args.data_dir).expanduser() if getattr(args, "data_dir", None) else None,
            secrets_dir=Path(args.secrets_dir).expanduser() if getattr(args, "secrets_dir", None) else None,
            source=getattr(args, "source", None),
            local_db=Path(args.local_db).expanduser() if getattr(args, "local_db", None) else None,
        )
    except ConfigError as e:
        err(f"configuration error: {e}")
        return 2
    try:
        return args.func(args, cfg)
    except KeyboardInterrupt:
        err("interrupted")
        return 130
    except upstream.UpstreamError as e:
        err(f"upstream problem: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
