"""Place-name enrichment via the Google Places API (New).

Resolves each visited place's Google placeId to Google's own name, category and address,
using upstream ``place_names.resolve`` (one Place Details request per place), wrapped in the
cost guards this project needs:

* cache first: a place looked up once is never requested again (the cache is written after
  every lookup, so an interrupted run never loses a paid request)
* a hard per-run cap (``TIMELINE_NAMES_MAX_PER_RUN``, default 150)
* dry run: count what would be requested and send nothing
* stop on the first systemic error (bad key, API disabled, quota exhausted, 5xx, network)
  instead of retrying; per-place 400/404 answers are remembered so they are not re-billed
* the field list is checked in ``upstream.place_names()`` so it never bills at Enterprise

The most-visited places are resolved first, so a quota-limited backfill is useful early.
Only Google's own placeIds are sent; no coordinates leave the machine.
"""
from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

from . import upstream
from .config import Config
from .logging import log, sanitize_message
from .publish import atomic_write_bytes, sha256_file
from .secrets import Secret, read_secret, secure_file

KEY_ENV = "GOOGLE_MAPS_API_KEY"
_KEY_SHAPE = re.compile(r"^AIza[0-9A-Za-z_\-]{30,60}$")
_HTTP = re.compile(r"HTTP (\d{3})")
MAX_CONSECUTIVE_PLACE_ERRORS = 5


class NamesError(RuntimeError):
    pass


# ------------------------------------------------------------------ key
def load_api_key(cfg: Config, env: Optional[dict] = None) -> Optional[Secret]:
    """Key from secrets/places_api_key.txt (preferred) or $GOOGLE_MAPS_API_KEY. Never logged."""
    env = os.environ if env is None else env
    value = read_secret(cfg.places_key_file)
    if value:
        secure_file(cfg.places_key_file)
    else:
        value = (env.get(KEY_ENV) or "").strip() or None
    if not value:
        return None
    if not _KEY_SHAPE.match(value):
        raise NamesError(
            f"the Places API key in {cfg.places_key_file} does not look like a Google API key "
            "(expected one line starting with 'AIza'); check the file for extra text")
    return Secret(value)


# ------------------------------------------------------------------ cache
def load_cache(cfg: Config) -> dict:
    try:
        data = json.loads(cfg.names_cache.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        raise NamesError(f"place-name cache is unreadable ({type(e).__name__}); move it aside and rerun") from e
    return data if isinstance(data, dict) else {}


def save_cache(cfg: Config, cache: dict) -> None:
    atomic_write_bytes(cfg.names_cache, (json.dumps(cache, ensure_ascii=False, indent=1) + "\n").encode("utf-8"))


def _is_resolved(entry: object) -> bool:
    return isinstance(entry, dict) and (bool(entry.get("name")) or entry.get("status") in (400, 404))


def load_browser_cache(cfg: Config) -> dict:
    try:
        data = json.loads(cfg.names_browser_cache.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        raise NamesError(f"browser place-name cache is unreadable ({type(e).__name__}); move it aside and rerun") from e
    return data if isinstance(data, dict) else {}


def _browser_resolved(entry: object) -> bool:
    """Upstream's rule: final once the page was read (category key set) without an error."""
    return isinstance(entry, dict) and "category" in entry and not entry.get("error")


def merged_cache(cfg: Config) -> dict:
    """Browser results, overridden by Places API results where the API has a name."""
    out = {fid: e for fid, e in load_browser_cache(cfg).items() if isinstance(e, dict) and e.get("name")}
    for fid, e in load_cache(cfg).items():
        if isinstance(e, dict) and e.get("name"):
            out[fid] = e
    return out


# ------------------------------------------------------------------ places in the export
@dataclass
class PlaceRef:
    feature_id: str
    place_id: str
    total_seconds: float
    visits: int


def _seconds(seg: dict) -> float:
    try:
        return max(0.0, (datetime.fromisoformat(seg["endTime"]) - datetime.fromisoformat(seg["startTime"])).total_seconds())
    except (KeyError, TypeError, ValueError):
        return 0.0


def collect_places(doc: dict) -> list[PlaceRef]:
    """Distinct visited places, most total time first."""
    refs: dict[str, PlaceRef] = {}
    for seg in doc.get("semanticSegments") or []:
        tc = (seg.get("visit") or {}).get("topCandidate") or {}
        fid, pid = tc.get("featureId"), tc.get("placeId")
        if not fid or not pid:
            continue
        r = refs.get(fid)
        if r is None:
            r = refs[fid] = PlaceRef(fid, pid, 0.0, 0)
        r.total_seconds += _seconds(seg)
        r.visits += 1
    return sorted(refs.values(), key=lambda r: (-r.total_seconds, -r.visits, r.feature_id))


def apply_names(doc: dict, cache: dict) -> int:
    """Merge cached names into visit topCandidates (same fields as upstream). Idempotent."""
    named = 0
    for seg in doc.get("semanticSegments") or []:
        tc = (seg.get("visit") or {}).get("topCandidate")
        if not tc or not tc.get("featureId"):
            continue
        r = cache.get(tc["featureId"])
        if not isinstance(r, dict) or not r.get("name"):
            continue
        tc["placeName"] = r["name"]
        if r.get("address"):
            tc["placeAddress"] = r["address"]
        if r.get("category"):
            tc["placeCategory"] = r["category"]
        loc = {k: r[k] for k in ("town", "country", "postalCode") if r.get(k)}
        if loc:
            tc.setdefault("placeLocation", {}).update(loc)
        named += 1
    return named


def apply_cached_names_to_file(cfg: Config, path: Path) -> int:
    """Offline: merge both name caches into an export file in place. Returns visits named."""
    cache = merged_cache(cfg)
    if not cache:
        return 0
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    n = apply_names(doc, cache)
    if n:
        from .export import dumps_document
        atomic_write_bytes(Path(path), dumps_document(doc))
    return n


# ------------------------------------------------------------------ resolution
@dataclass
class NamesResult:
    distinct: int
    cached: int
    todo: int
    run_cap: int
    dry_run: bool
    requested: int = 0
    resolved: int = 0
    not_found: int = 0
    stopped: Optional[str] = None
    named_visits: int = 0
    errors: int = 0
    mismatched: int = 0
    method: str = "api"

    @property
    def remaining(self) -> int:
        return max(0, self.todo - self.resolved - self.not_found)


def _classify(rec: dict) -> tuple[str, Optional[int], str]:
    """-> ('ok'|'place'|'stop', http_status, sanitized detail)."""
    if "error" not in rec:
        return "ok", None, ""
    m = _HTTP.search(str(rec.get("error")))
    status = int(m.group(1)) if m else None
    detail = sanitize_message(f"{rec.get('error')} {rec.get('detail') or ''}", 240)
    if status == 404:
        return "place", status, detail
    if status == 400 and not re.search(r"api[ _]?key|API_KEY", detail, re.I):
        return "place", status, detail
    return "stop", status, detail


def _stop_message(status: Optional[int], detail: str) -> str:
    if status == 429:
        return "quota reached (your daily cap or Google's rate limit); progress is saved, run again later"
    if status in (401, 403) or (status == 400 and "key" in detail.lower()):
        return ("Google refused the key. Check it is restricted to 'Places API (New)', that the API is "
                f"enabled for the key's project and billing is on. Google said: {detail}")
    if status and status >= 500:
        return f"Google returned a server error ({status}); try again later"
    return f"lookup failed: {detail}"


def resolve_names(cfg: Config, doc: dict, *, dry_run: bool, max_lookups: Optional[int] = None,
                  key: Optional[Secret] = None, resolver: Optional[Callable[[str, str], dict]] = None,
                  sleep_s: float = 0.1, clock: Callable[[], float] = time.time) -> NamesResult:
    refs = collect_places(doc)
    cache = load_cache(cfg)
    todo = [r for r in refs if not _is_resolved(cache.get(r.feature_id))]
    cap = max_lookups or cfg.names_max_per_run
    res = NamesResult(distinct=len(refs), cached=len(refs) - len(todo), todo=len(todo), run_cap=cap, dry_run=dry_run)
    if dry_run or not todo:
        return res
    if key is None:
        raise NamesError(f"no Places API key: save it to {cfg.places_key_file} (or set {KEY_ENV})")
    if resolver is None:
        resolver = upstream.place_names().resolve

    consecutive_place_errors = 0
    for ref in todo[:cap]:
        res.requested += 1
        rec = resolver(ref.place_id, key.reveal())
        kind, status, detail = _classify(rec if isinstance(rec, dict) else {"error": "bad response"})
        if kind == "stop":
            res.stopped = _stop_message(status, detail)
            log.warning("names.stopped", status=status)
            break
        if kind == "place":
            cache[ref.feature_id] = {"placeId": ref.place_id, "status": status, "error": detail[:120],
                                     "checkedAt": int(clock())}
            res.not_found += 1
            consecutive_place_errors += 1
            if consecutive_place_errors >= MAX_CONSECUTIVE_PLACE_ERRORS:
                save_cache(cfg, cache)
                res.stopped = f"{consecutive_place_errors} places in a row were rejected; stopping to be safe ({detail})"
                break
        else:
            entry = {k: v for k, v in rec.items() if v not in (None, "", [])}
            entry["placeId"] = ref.place_id
            entry["resolvedAt"] = int(clock())
            cache[ref.feature_id] = entry
            res.resolved += 1
            consecutive_place_errors = 0
        save_cache(cfg, cache)
        if sleep_s:
            time.sleep(sleep_s)
    log.info("names.run", requested=res.requested, resolved=res.resolved, not_found=res.not_found,
             remaining=res.remaining, stopped=bool(res.stopped))
    return res


BROWSER_SECONDS_PER_PLACE = 6   # upstream: page load + 3 s settle + 2.5 s polite delay
BROWSER_CHUNK = 40              # places per browser launch (a crashed tab only costs the rest of one chunk)


def resolve_names_browser(cfg: Config, doc: dict, *, dry_run: bool, max_lookups: Optional[int] = None,
                          chrome: Optional[str] = None, chunk_size: Optional[int] = None,
                          runner: Optional[Callable[..., int]] = None) -> NamesResult:
    """Resolve names with upstream's headless-Chrome resolver (no key, no billing).

    Hands upstream small input files listing only places still unnamed, most-visited first and
    capped. Each chunk runs in a fresh browser: upstream reuses one tab for its whole list, so a
    crashed tab ("detached Frame") would otherwise fail every remaining place. A chunk in which
    nothing could be read stops the run (systemic problem: consent wall, CAPTCHA, no network).
    """
    refs = collect_places(doc)
    api, browser = load_cache(cfg), load_browser_cache(cfg)
    todo = [r for r in refs if not _is_resolved(api.get(r.feature_id)) and not _browser_resolved(browser.get(r.feature_id))]
    cap = max_lookups or cfg.names_max_per_run
    res = NamesResult(distinct=len(refs), cached=len(refs) - len(todo), todo=len(todo), run_cap=cap,
                      dry_run=dry_run, method="browser")
    if dry_run or not todo:
        return res
    chrome = chrome or upstream.detect_browser()
    if not chrome:
        raise NamesError("Chrome or Edge not found; install one or set CHROME_PATH")
    size = max(1, chunk_size or int(os.environ.get("TIMELINE_NAMES_BROWSER_CHUNK", BROWSER_CHUNK)))
    runner = runner or upstream.run_resolve_names
    cfg.cache_dir.mkdir(parents=True, exist_ok=True)
    work = cfg.cache_dir / "resolve-batch.json"
    batch = todo[:cap]

    for i in range(0, len(batch), size):
        chunk = batch[i:i + size]
        work.write_text(json.dumps({"semanticSegments": [
            {"visit": {"topCandidate": {"featureId": r.feature_id}}} for r in chunk]}), encoding="utf-8")
        res.requested += len(chunk)
        try:
            rc = runner(work, chrome=chrome, timeout_s=len(chunk) * 120 + 120)
        finally:
            try:
                work.unlink()
            except OSError:
                pass
        browser = load_browser_cache(cfg)
        ok = 0
        for r in chunk:
            e = browser.get(r.feature_id)
            if not _browser_resolved(e):
                res.errors += 1
            elif e.get("name"):
                res.resolved += 1
                ok += 1
                if e.get("ftidMatch") is False:
                    res.mismatched += 1
            else:
                res.not_found += 1
                ok += 1
        errs = [str(browser.get(r.feature_id, {}).get("error") or "") for r in chunk]
        if any("consent" in e for e in errs):
            res.stopped = "Google showed a cookie-consent page; run upstream get_consent_cookie.sh, then rerun"
            break
        if ok == 0:
            first = next((e for e in errs if e), f"resolver exit code {rc}")
            res.stopped = f"no place in a chunk of {len(chunk)} could be read; stopping ({sanitize_message(first, 120)})"
            break
    log.info("names.browser_run", requested=res.requested, resolved=res.resolved, errors=res.errors,
             mismatched=res.mismatched, stopped=bool(res.stopped))
    return res


def publish_names(cfg: Config) -> int:
    """Re-publish current/Timeline.json with cached names merged in (offline, atomic)."""
    if not cfg.current_export.exists():
        raise NamesError("no published export yet; run `timeline-sync sync` first")
    n = apply_cached_names_to_file(cfg, cfg.current_export)
    if n:
        from .status import load_status, save_status
        st = load_status(cfg)
        if st and isinstance(st.get("output"), dict):
            st["output"]["export_sha256"] = sha256_file(cfg.current_export)
            save_status(cfg, st)
    return n
