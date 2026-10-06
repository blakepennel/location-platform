"""GellerCloudSource against httpx.MockTransport: no network, synthetic tokens only."""
import base64

import httpx
import pytest

from helpers import (FAKE_BEARER, FAKE_MASTER, FIXED_NOW, const_clock, rows, setup_geller_secrets)
from timeline_sync import synthetic, upstream
from timeline_sync.sources import GELLER_URL, GellerCloudSource, SourceError

KEY = synthetic.synthetic_key(7)


def make_source(cfg, handler, *, oauth=None, key=KEY, secrets=True):
    if secrets:
        setup_geller_secrets(cfg, key)
    calls = []

    def default_oauth(email, master, android_id, service, app, client_sig):
        calls.append({"email": email, "service": service, "app": app, "sig": client_sig})
        return {"Auth": FAKE_BEARER}

    src = GellerCloudSource(cfg, transport=httpx.MockTransport(handler), oauth_func=oauth or default_oauth,
                            clock=const_clock())
    return src, calls


def ok_handler(seen=None, key=KEY, compress=False):
    resp = synthetic.build_batch_sync_response(rows(), key, mutation_ms=1_790_000_000_000, compress=compress)

    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        headers = {"content-type": "application/grpc", "grpc-status": "0"}
        if resp.grpc_encoding:
            headers["grpc-encoding"] = resp.grpc_encoding
        return httpx.Response(200, content=resp.body, headers=headers)
    return handler


def test_success_writes_db_and_sends_the_exact_request(cfg, tmp_path):
    seen = []
    src, oauth_calls = make_source(cfg, ok_handler(seen))
    dest = tmp_path / "raw" / "odlh-storage.db"
    res = src.fetch(dest)
    assert dest.is_file() and res.segments_written == len(rows()) and res.snapshots == 4
    assert res.cloud_request_ok_at == "2026-09-28T09:00:00Z"
    assert res.newest_mutation_ms == 1_790_000_000_000
    assert "SyncToken".lower() not in repr(res).lower() and "synthetic-sync-token" not in repr(res)
    assert src.check_auth().state == "ok"

    (req,) = seen
    g = upstream.geller()
    assert str(req.url) == GELLER_URL and req.method == "POST"
    assert req.headers["content-type"] == "application/grpc"      # +proto would 404 upstream
    assert req.headers["authorization"] == "Bearer " + FAKE_BEARER
    assert req.headers["te"] == "trailers"
    assert req.content == g.grpc_frame(g.build_request(None))
    tok_mod = upstream.get_token()
    assert oauth_calls == [{"email": "tester@example.invalid", "service": tok_mod.SCOPE,
                            "app": tok_mod.APP, "sig": tok_mod.CLIENT_SIG}]


def test_bearer_is_never_written_to_disk(cfg, tmp_path):
    src, _ = make_source(cfg, ok_handler())
    src.fetch(tmp_path / "raw" / "odlh-storage.db")
    needle = FAKE_BEARER.encode()
    for f in tmp_path.rglob("*"):
        if f.is_file():
            assert needle not in f.read_bytes(), f"bearer token leaked into {f.name}"


def test_gzip_response_through_source(cfg, tmp_path):
    src, _ = make_source(cfg, ok_handler(compress=True))
    assert src.fetch(tmp_path / "o.db").segments_written == len(rows())


def test_http_401_marks_auth_expired(cfg, tmp_path):
    src, _ = make_source(cfg, lambda r: httpx.Response(401, content=b"unauthorized"))
    with pytest.raises(SourceError) as ei:
        src.fetch(tmp_path / "o.db")
    assert ei.value.stage == "auth" and ei.value.auth_state == "expired"
    assert src.check_auth().state == "expired"
    assert not (tmp_path / "o.db").exists()


def test_grpc_status_nonzero_is_a_fetch_error(cfg, tmp_path):
    def handler(request):
        return httpx.Response(200, content=b"", headers={"grpc-status": "14", "grpc-message": "unavailable"})
    src, _ = make_source(cfg, handler)
    with pytest.raises(SourceError) as ei:
        src.fetch(tmp_path / "o.db")
    assert ei.value.stage == "fetch" and "gRPC error 14" in ei.value.message
    assert ei.value.auth_state is None and ei.value.cloud_request_ok_at is None


def test_grpc_unauthenticated_marks_auth_expired(cfg, tmp_path):
    src, _ = make_source(cfg, lambda r: httpx.Response(200, headers={"grpc-status": "16", "grpc-message": "expired"}))
    with pytest.raises(SourceError) as ei:
        src.fetch(tmp_path / "o.db")
    assert ei.value.stage == "auth" and ei.value.auth_state == "expired"


def test_http_500_is_a_fetch_error(cfg, tmp_path):
    src, _ = make_source(cfg, lambda r: httpx.Response(500, content=b"<html>oops</html>"))
    with pytest.raises(SourceError) as ei:
        src.fetch(tmp_path / "o.db")
    assert ei.value.stage == "fetch" and "500" in ei.value.message and "oops" not in ei.value.message


def test_wrong_key_is_a_decrypt_error_but_records_the_cloud_success(cfg, tmp_path):
    wrong = synthetic.synthetic_key(999)
    src, _ = make_source(cfg, ok_handler(key=wrong))          # server encrypted with a different key
    with pytest.raises(SourceError) as ei:
        src.fetch(tmp_path / "o.db")
    assert ei.value.stage == "decrypt"
    assert ei.value.cloud_request_ok_at == "2026-09-28T09:00:00Z"   # HTTP 200 + grpc 0 did happen
    assert not (tmp_path / "o.db").exists()                          # nothing written


def test_bearer_failure_bad_authentication_is_expired_and_makes_no_request(cfg, tmp_path):
    seen = []
    src, _ = make_source(cfg, ok_handler(seen), oauth=lambda *a, **k: {"Error": "BadAuthentication"})
    with pytest.raises(SourceError) as ei:
        src.fetch(tmp_path / "o.db")
    assert ei.value.stage == "auth" and ei.value.auth_state == "expired" and not seen
    assert "master token no longer valid" in ei.value.message


def test_bearer_library_exception_does_not_leak_its_message(cfg, tmp_path):
    def boom(*a, **k):
        raise ConnectionError(f"failed talking to host with {FAKE_MASTER} and {FAKE_BEARER}")
    src, _ = make_source(cfg, ok_handler(), oauth=boom)
    with pytest.raises(SourceError) as ei:
        src.fetch(tmp_path / "o.db")
    assert ei.value.stage == "auth" and ei.value.auth_state == "error"
    assert FAKE_MASTER not in ei.value.message and FAKE_BEARER not in ei.value.message
    assert "ConnectionError" in ei.value.message


def test_network_error_message_is_sanitized(cfg, tmp_path):
    def handler(request):
        raise httpx.ConnectError(f"boom {FAKE_BEARER}")
    src, _ = make_source(cfg, handler)
    with pytest.raises(SourceError) as ei:
        src.fetch(tmp_path / "o.db")
    assert ei.value.stage == "fetch" and "ConnectError" in ei.value.message and "ya29" not in ei.value.message


def test_missing_credentials(cfg, tmp_path):
    src, _ = make_source(cfg, ok_handler(), secrets=False)
    health = src.check_auth()
    assert health.state == "missing" and not health.master_token_present and not health.key_present
    with pytest.raises(SourceError) as ei:
        src.fetch(tmp_path / "o.db")
    assert ei.value.stage == "auth" and ei.value.auth_state == "missing"


def test_invalid_key_file(cfg, tmp_path):
    src, _ = make_source(cfg, ok_handler())
    from timeline_sync.secrets import write_secret
    write_secret(cfg.key_file, "not base64 !!!")
    with pytest.raises(SourceError) as ei:
        src.fetch(tmp_path / "o.db")
    assert ei.value.stage == "decrypt"
    write_secret(cfg.key_file, base64.b64encode(b"short").decode())
    with pytest.raises(SourceError) as ei:
        src.fetch(tmp_path / "o.db")
    assert ei.value.stage == "decrypt" and "32 bytes" in ei.value.message


def test_check_auth_reports_presence_booleans_only(cfg):
    src, _ = make_source(cfg, ok_handler())
    h = src.check_auth()
    assert h.state == "unknown" and h.master_token_present and h.key_present and h.checked_at == "2026-09-28T09:00:00Z"
    assert FAKE_MASTER not in repr(h)


# ---------------------------------------------------------------- multiple corpora (sync parts)
def corpus_of(request) -> str | None:
    """SyncItem.corpusName (field 3) of a captured BatchSync request, or None."""
    g = upstream.geller()
    msg = g.parse(g.grpc_unframe(request.content, "identity")[0])
    item = g.parse(g.one(msg, 1) or b"")
    v = g.one(item, 3)
    return v.decode() if isinstance(v, bytes) else None


def multi_corpus_handler(responses, seen):
    def handler(request):
        seen.append(corpus_of(request))
        resp = responses[corpus_of(request)]
        return httpx.Response(200, content=resp.body, headers={"content-type": "application/grpc", "grpc-status": "0"})
    return handler


def test_follows_advertised_corpora_and_merges_them(cfg, tmp_path):
    all_rows = rows(days=14)
    old, new = all_rows[: len(all_rows) // 2], all_rows[len(all_rows) // 2:]
    responses = {
        None: synthetic.build_batch_sync_response(old, KEY, mutation_ms=1_780_000_000_000, corpus_refs=("CORPUS_NEW",)),
        "CORPUS_NEW": synthetic.build_batch_sync_response(new, KEY, mutation_ms=1_790_000_000_000, element_prefix="new"),
    }
    seen = []
    src, _ = make_source(cfg, multi_corpus_handler(responses, seen))
    res = src.fetch(tmp_path / "odlh.db")
    assert seen == [None, "CORPUS_NEW"]                       # default first, then the advertised corpus
    assert res.segments_written == len(all_rows)              # nothing from the newer corpus is lost
    assert res.newest_mutation_ms == 1_790_000_000_000


def test_corpus_chain_is_followed_and_cycles_do_not_loop(cfg, tmp_path):
    r = rows(days=12)
    a, b, c = r[:20], r[20:40], r[40:]
    responses = {
        None: synthetic.build_batch_sync_response(a, KEY, mutation_ms=1, corpus_refs=("B",)),
        "B": synthetic.build_batch_sync_response(b, KEY, mutation_ms=2, corpus_refs=("C", "B"), element_prefix="b"),
        "C": synthetic.build_batch_sync_response(c, KEY, mutation_ms=3, corpus_refs=("B",), element_prefix="c"),
    }
    seen = []
    src, _ = make_source(cfg, multi_corpus_handler(responses, seen))
    res = src.fetch(tmp_path / "odlh.db")
    assert seen == [None, "B", "C"] and res.segments_written == len(r)


def test_overlapping_corpora_keep_one_row_per_segment_newest_write_wins(cfg, tmp_path):
    from timeline_sync.sources import merge_corpus_records, DecodedBatch
    older = DecodedBatch([{"segment_id": "s1", "timestamp_millis": 10, "v": "old"}, {"segment_id": "s2", "v": "x"}], 1, None, 10)
    newer = DecodedBatch([{"segment_id": "s1", "timestamp_millis": 20, "v": "new"}], 1, None, 20)
    merged = {r["segment_id"]: r for r in merge_corpus_records([older, newer])}
    assert len(merged) == 2 and merged["s1"]["v"] == "new"
    merged2 = {r["segment_id"]: r for r in merge_corpus_records([newer, older])}
    assert merged2["s1"]["v"] == "new"                        # newer write wins regardless of order


def test_a_failing_advertised_corpus_fails_the_fetch_so_last_known_good_is_kept(cfg, tmp_path):
    good = synthetic.build_batch_sync_response(rows(days=12), KEY, mutation_ms=1, corpus_refs=("BROKEN",))

    def handler(request):
        if corpus_of(request) == "BROKEN":
            return httpx.Response(200, content=b"", headers={"content-type": "application/grpc", "grpc-status": "13", "grpc-message": "internal"})
        return httpx.Response(200, content=good.body, headers={"content-type": "application/grpc", "grpc-status": "0"})
    src, _ = make_source(cfg, handler)
    with pytest.raises(SourceError) as e:
        src.fetch(tmp_path / "odlh.db")
    assert e.value.stage == "fetch"                            # partial data is never published
