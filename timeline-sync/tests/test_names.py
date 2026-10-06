"""Place-name enrichment: cost guards, caching, error handling, publishing. Synthetic only."""
import json

import pytest

from timeline_sync import names as N
from timeline_sync import upstream
from timeline_sync.cli import main
from timeline_sync.secrets import Secret

FAKE_KEY = "AIzaFAKE_EXAMPLE_KEY_0123456789abcdefghij"


def _visit(fid, pid, start, end):
    return {"startTime": start, "endTime": end,
            "visit": {"topCandidate": {"featureId": fid, "placeId": pid, "semanticType": "UNKNOWN"}}}


def _doc():
    return {"semanticSegments": [
        _visit("0x01:0x01", "ChIJFAKE_PLACE_A", "2025-01-01T09:00:00+02:00", "2025-01-01T10:00:00+02:00"),
        _visit("0x02:0x02", "ChIJFAKE_PLACE_B", "2025-01-01T11:00:00+02:00", "2025-01-01T17:00:00+02:00"),
        _visit("0x02:0x02", "ChIJFAKE_PLACE_B", "2025-01-02T11:00:00+02:00", "2025-01-02T12:00:00+02:00"),
        _visit("0x03:0x03", "ChIJFAKE_PLACE_C", "2025-01-03T11:00:00-05:00", "2025-01-03T11:30:00-05:00"),
        {"startTime": "2025-01-01T10:00:00+02:00", "endTime": "2025-01-01T11:00:00+02:00", "activity": {}},
    ]}


class FakeResolver:
    def __init__(self, answers=None):
        self.calls = []
        self.answers = answers or {}

    def __call__(self, place_id, key):
        assert key == FAKE_KEY
        self.calls.append(place_id)
        a = self.answers.get(place_id)
        if a is not None:
            return a
        return {"name": f"Synthetic {place_id[-1]}", "address": "1 Fake St, Testville", "category": "Cafe",
                "town": "Testville", "country": "Exampleland"}


def run(cfg, doc=None, **kw):
    kw.setdefault("key", Secret(FAKE_KEY))
    kw.setdefault("sleep_s", 0)
    return N.resolve_names(cfg, doc or _doc(), **kw)


def test_collect_places_orders_by_total_time_and_dedupes():
    refs = N.collect_places(_doc())
    assert [r.place_id for r in refs] == ["ChIJFAKE_PLACE_B", "ChIJFAKE_PLACE_A", "ChIJFAKE_PLACE_C"]
    assert refs[0].visits == 2 and refs[0].total_seconds == 7 * 3600


def test_dry_run_sends_nothing(cfg):
    r = FakeResolver()
    res = run(cfg, dry_run=True, resolver=r, key=None)
    assert r.calls == [] and res.todo == 3 and res.requested == 0
    assert not cfg.names_cache.exists()


def test_resolves_caches_and_never_rebills(cfg):
    r = FakeResolver()
    res = run(cfg, dry_run=False, resolver=r)
    assert res.resolved == 3 and res.remaining == 0 and len(r.calls) == 3
    cache = json.loads(cfg.names_cache.read_text(encoding="utf-8"))
    assert cache["0x02:0x02"]["name"] == "Synthetic B"
    r2 = FakeResolver()
    res2 = run(cfg, dry_run=False, resolver=r2)
    assert r2.calls == [] and res2.cached == 3 and res2.todo == 0


def test_per_run_cap_is_hard(cfg):
    r = FakeResolver()
    res = run(cfg, dry_run=False, resolver=r, max_lookups=2)
    assert len(r.calls) == 2 and res.remaining == 1
    assert r.calls == ["ChIJFAKE_PLACE_B", "ChIJFAKE_PLACE_A"]   # most-visited first


@pytest.mark.parametrize("status", [429, 403, 401, 500, 503])
def test_systemic_errors_stop_immediately_and_are_not_cached(cfg, status):
    r = FakeResolver({"ChIJFAKE_PLACE_B": {"error": f"HTTP {status}", "detail": "denied"}})
    res = run(cfg, dry_run=False, resolver=r)
    assert r.calls == ["ChIJFAKE_PLACE_B"] and res.stopped
    assert "0x02:0x02" not in N.load_cache(cfg)   # retried next run, not remembered as a failure


def test_bad_key_400_stops_instead_of_tombstoning(cfg):
    r = FakeResolver({"ChIJFAKE_PLACE_B": {"error": "HTTP 400", "detail": "API key not valid. Please pass a valid API key."}})
    res = run(cfg, dry_run=False, resolver=r)
    assert res.stopped and "refused the key" in res.stopped
    assert N.load_cache(cfg) == {}


def test_not_found_place_is_remembered_and_run_continues(cfg):
    r = FakeResolver({"ChIJFAKE_PLACE_A": {"error": "HTTP 404", "detail": "NOT_FOUND"}})
    res = run(cfg, dry_run=False, resolver=r)
    assert res.resolved == 2 and res.not_found == 1 and not res.stopped
    r2 = FakeResolver()
    run(cfg, dry_run=False, resolver=r2)
    assert r2.calls == []   # the 404 is not re-billed


def test_network_exception_stops(cfg):
    r = FakeResolver({"ChIJFAKE_PLACE_B": {"error": "<urlopen error timed out>"}})
    res = run(cfg, dry_run=False, resolver=r)
    assert res.stopped and len(r.calls) == 1


def test_many_consecutive_place_errors_stop(cfg):
    doc = {"semanticSegments": [_visit(f"0x{i:02x}:0x01", f"ChIJFAKE_{i}", "2025-01-01T09:00:00+00:00",
                                       f"2025-01-01T{9 + (10 - i) % 10:02d}:30:00+00:00") for i in range(8)]}
    r = FakeResolver({f"ChIJFAKE_{i}": {"error": "HTTP 404"} for i in range(8)})
    res = run(cfg, doc, dry_run=False, resolver=r)
    assert len(r.calls) == N.MAX_CONSECUTIVE_PLACE_ERRORS and res.stopped


def test_apply_names_is_idempotent_and_publishes(cfg):
    run(cfg, dry_run=False, resolver=FakeResolver())
    cfg.current_dir.mkdir(parents=True)
    cfg.current_export.write_text(json.dumps(_doc()), encoding="utf-8")
    assert N.publish_names(cfg) == 4
    doc = json.loads(cfg.current_export.read_text(encoding="utf-8"))
    tc = doc["semanticSegments"][1]["visit"]["topCandidate"]
    assert tc["placeName"] == "Synthetic B" and tc["placeCategory"] == "Cafe"
    assert tc["placeLocation"]["town"] == "Testville"
    once = cfg.current_export.read_text(encoding="utf-8")
    N.publish_names(cfg)
    assert cfg.current_export.read_text(encoding="utf-8") == once


def test_key_loading_validates_shape_and_env_fallback(cfg, monkeypatch):
    assert N.load_api_key(cfg, env={}) is None
    assert N.load_api_key(cfg, env={N.KEY_ENV: FAKE_KEY}).reveal() == FAKE_KEY
    cfg.secrets_dir.mkdir(parents=True)
    cfg.places_key_file.write_text("not a key\n", encoding="utf-8")
    with pytest.raises(N.NamesError):
        N.load_api_key(cfg, env={})
    cfg.places_key_file.write_text(FAKE_KEY + "\n", encoding="utf-8")
    assert N.load_api_key(cfg, env={}).reveal() == FAKE_KEY


def test_enterprise_fields_are_refused(monkeypatch):
    mod = upstream.place_names()
    assert "displayName" in mod.FIELDS
    monkeypatch.setattr(mod, "FIELDS", mod.FIELDS + ",rating,internationalPhoneNumber")
    with pytest.raises(upstream.UpstreamError, match="Enterprise"):
        upstream.place_names()


def test_cli_dry_run_and_key_never_printed(cfg, capsys, monkeypatch):
    monkeypatch.setenv("TIMELINE_DATA_DIR", str(cfg.data_dir))
    monkeypatch.setenv("TIMELINE_SECRETS_DIR", str(cfg.secrets_dir))
    cfg.current_dir.mkdir(parents=True)
    cfg.current_export.write_text(json.dumps(_doc()), encoding="utf-8")
    cfg.secrets_dir.mkdir(parents=True)
    cfg.places_key_file.write_text(FAKE_KEY, encoding="utf-8")
    assert main(["names", "--method", "api", "--dry-run"]) == 0
    o = capsys.readouterr()
    assert "DRY RUN" in o.out and "would send   : 3" in o.out
    assert FAKE_KEY not in o.out + o.err


def test_cli_real_run_with_fake_resolver(cfg, capsys, monkeypatch):
    monkeypatch.setenv("TIMELINE_DATA_DIR", str(cfg.data_dir))
    monkeypatch.setenv("TIMELINE_SECRETS_DIR", str(cfg.secrets_dir))
    cfg.current_dir.mkdir(parents=True)
    cfg.current_export.write_text(json.dumps(_doc()), encoding="utf-8")
    cfg.secrets_dir.mkdir(parents=True)
    cfg.places_key_file.write_text(FAKE_KEY, encoding="utf-8")
    fake = FakeResolver()

    class Mod:
        FIELDS = "displayName"
        resolve = staticmethod(fake)
    monkeypatch.setattr(upstream, "place_names", lambda: Mod)
    monkeypatch.setattr(N.time, "sleep", lambda s: None)
    assert main(["names", "--method", "api", "--max", "2"]) == 0
    o = capsys.readouterr()
    assert "looked up this run    : 2" in o.out and "remaining             : 1" in o.out
    assert FAKE_KEY not in o.out + o.err
    doc = json.loads(cfg.current_export.read_text(encoding="utf-8"))
    assert doc["semanticSegments"][1]["visit"]["topCandidate"]["placeName"] == "Synthetic B"


def test_sync_reapplies_cached_names_offline(cfg):
    from timeline_sync.sources import SyntheticSource
    from timeline_sync.sync import run_sync
    assert run_sync(cfg, SyntheticSource(cfg)).ok
    doc = json.loads(cfg.current_export.read_text(encoding="utf-8"))
    ref = N.collect_places(doc)[0]
    N.save_cache(cfg, {ref.feature_id: {"name": "Synthetic Home Base", "placeId": ref.place_id}})
    assert run_sync(cfg, SyntheticSource(cfg)).ok
    doc = json.loads(cfg.current_export.read_text(encoding="utf-8"))
    names = {(s.get("visit") or {}).get("topCandidate", {}).get("placeName") for s in doc["semanticSegments"]}
    assert "Synthetic Home Base" in names


# ------------------------------------------------------------------ headless-browser method
def fake_browser_runner(cfg, answers=None, rc=0, calls=None):
    """Stands in for upstream resolve_names.js: reads the batch file, writes the browser cache."""
    answers = answers or {}

    def run(input_json, *, chrome, timeout_s=None):
        batch = [s["visit"]["topCandidate"]["featureId"]
                 for s in json.loads(input_json.read_text(encoding="utf-8"))["semanticSegments"]]
        if calls is not None:
            calls.append(batch)
        cache = N.load_browser_cache(cfg)
        for fid in batch:
            cache[fid] = answers.get(fid, {"name": f"Browser {fid[-1]}", "ftidMatch": True,
                                           "address": "2 Fake Rd, Testville", "category": "Park"})
        cfg.names_browser_cache.parent.mkdir(parents=True, exist_ok=True)
        cfg.names_browser_cache.write_text(json.dumps(cache), encoding="utf-8")
        return rc
    return run


def test_browser_dry_run_opens_nothing(cfg):
    calls = []
    res = N.resolve_names_browser(cfg, _doc(), dry_run=True, runner=fake_browser_runner(cfg, calls=calls), chrome="x")
    assert calls == [] and res.todo == 3 and res.method == "browser"


def test_browser_batch_is_capped_most_visited_first_and_resumable(cfg):
    calls = []
    res = N.resolve_names_browser(cfg, _doc(), dry_run=False, max_lookups=2, chrome="x",
                                  runner=fake_browser_runner(cfg, calls=calls))
    assert calls == [["0x02:0x02", "0x01:0x01"]] and res.resolved == 2 and res.remaining == 1
    res2 = N.resolve_names_browser(cfg, _doc(), dry_run=False, chrome="x", runner=fake_browser_runner(cfg, calls=calls))
    assert calls[-1] == ["0x03:0x03"] and res2.cached == 2
    assert not (cfg.cache_dir / "resolve-batch.json").exists()


def test_browser_errors_are_retried_and_mismatches_flagged(cfg):
    answers = {"0x02:0x02": {"name": None, "ftidMatch": False, "error": "Navigation timeout"},
               "0x01:0x01": {"name": "Moved Place", "ftidMatch": False, "address": None, "category": None}}
    res = N.resolve_names_browser(cfg, _doc(), dry_run=False, chrome="x", runner=fake_browser_runner(cfg, answers))
    assert res.errors == 1 and res.resolved == 2 and res.mismatched == 1
    calls = []
    N.resolve_names_browser(cfg, _doc(), dry_run=False, chrome="x", runner=fake_browser_runner(cfg, calls=calls))
    assert calls == [["0x02:0x02"]]   # only the failed place is retried


def test_browser_consent_wall_is_reported(cfg):
    answers = {f: {"name": None, "ftidMatch": False, "error": "consent-wall (refresh cookie)"}
               for f in ("0x01:0x01", "0x02:0x02", "0x03:0x03")}
    res = N.resolve_names_browser(cfg, _doc(), dry_run=False, chrome="x", runner=fake_browser_runner(cfg, answers))
    assert res.stopped and "consent" in res.stopped


def test_api_results_override_browser_results(cfg):
    N.resolve_names_browser(cfg, _doc(), dry_run=False, chrome="x", runner=fake_browser_runner(cfg))
    run(cfg, dry_run=False, resolver=FakeResolver(), max_lookups=1)   # API names only place B
    merged = N.merged_cache(cfg)
    assert merged["0x02:0x02"]["name"] == "Synthetic B"   # API wins
    assert merged["0x01:0x01"]["name"] == "Browser 1"     # browser fills the rest


def test_cli_browser_run(cfg, capsys, monkeypatch):
    monkeypatch.setenv("TIMELINE_DATA_DIR", str(cfg.data_dir))
    monkeypatch.setenv("TIMELINE_SECRETS_DIR", str(cfg.secrets_dir))
    cfg.current_dir.mkdir(parents=True)
    cfg.current_export.write_text(json.dumps(_doc()), encoding="utf-8")
    monkeypatch.setattr(upstream, "detect_browser", lambda env=None: "fake-chrome")
    monkeypatch.setattr(upstream, "run_resolve_names", fake_browser_runner(cfg))
    assert main(["names", "--method", "browser", "--dry-run"]) == 0
    assert "DRY RUN: no pages were opened" in capsys.readouterr().out
    assert main(["names", "--method", "browser"]) == 0
    o = capsys.readouterr().out
    assert "named 3" in o
    doc = json.loads(cfg.current_export.read_text(encoding="utf-8"))
    assert doc["semanticSegments"][0]["visit"]["topCandidate"]["placeName"] == "Browser 1"


def test_browser_runs_in_chunks_with_a_fresh_browser_each(cfg):
    calls = []
    res = N.resolve_names_browser(cfg, _doc(), dry_run=False, chrome="x", chunk_size=2,
                                  runner=fake_browser_runner(cfg, calls=calls))
    assert calls == [["0x02:0x02", "0x01:0x01"], ["0x03:0x03"]]
    assert res.resolved == 3 and res.requested == 3 and not res.stopped


def test_crashed_tab_only_costs_the_rest_of_its_chunk(cfg):
    # first chunk: one place read, then the tab died ("detached Frame") -> next chunk still runs
    answers = {"0x01:0x01": {"name": None, "ftidMatch": False, "error": "Attempted to use detached Frame 'X'."}}
    calls = []
    res = N.resolve_names_browser(cfg, _doc(), dry_run=False, chrome="x", chunk_size=2,
                                  runner=fake_browser_runner(cfg, answers, calls=calls))
    assert len(calls) == 2 and res.resolved == 2 and res.errors == 1 and not res.stopped


def test_a_chunk_with_nothing_readable_stops_the_run(cfg):
    answers = {f: {"name": None, "ftidMatch": False, "error": "Navigation timeout of 45000 ms exceeded"}
               for f in ("0x01:0x01", "0x02:0x02")}
    calls = []
    res = N.resolve_names_browser(cfg, _doc(), dry_run=False, chrome="x", chunk_size=2,
                                  runner=fake_browser_runner(cfg, answers, calls=calls))
    assert len(calls) == 1 and res.stopped and "chunk of 2" in res.stopped
