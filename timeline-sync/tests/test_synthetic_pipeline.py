"""Protobuf writer -> upstream decoders -> encrypted BatchSync -> db -> export (all offline)."""
import json
from datetime import datetime

import pytest

from helpers import END_DATE, FIXED_NOW, make_db, rows
from timeline_sync import synthetic, upstream
from timeline_sync.export import build_document, build_segments, dumps_document, export_db
from timeline_sync.sources import SourceError, decode_batch_sync, write_records_db

PLACE = synthetic.PLACES["home"]


def test_visit_roundtrip_through_upstream_decoder():
    o = upstream.odlh()
    blob = synthetic.encode_visit(PLACE, start=(1_700_000_000, 0), end=(1_700_003_600, 0), seg_id="v1",
                                  off_start=0, off_end=0, lat=10.0012, lng=20.0034, prob=0.9, top_prob=0.8,
                                  confirmed=True)
    got = o.dec_visit(o.fields(blob))["visit"]
    assert got["probability"] == 0.9
    assert got["isConfirmed"] is True
    tc = got["topCandidate"]
    assert tc["placeLocation"]["latLng"] == "10.0012000°, 20.0034000°"
    assert tc["semanticType"] == "HOME" and tc["semanticTypeCode"] == 1
    assert tc["placeTypeCode"] == 100 and tc["probability"] == 0.8
    # featureId halves: cell = odlh field #2, fprint = field #1 (upstream's documented order)
    pid = o.chij_place_id(PLACE.cell, PLACE.fprint)
    assert tc["placeId"] == pid and pid.startswith("ChIJ")
    assert tc["featureId"] == f"0x{PLACE.cell:016x}:0x{PLACE.fprint:016x}"


def test_activity_and_path_and_trip_roundtrip():
    o = upstream.odlh()
    blob = synthetic.encode_activity(start=(1, 0), end=(2, 0), seg_id="a1", off_start=60, off_end=60,
                                     from_ll=(10.001, 20.002), to_ll=(10.003, 20.004), distance_m=1234.5,
                                     mode=29, prob=0.5)
    act = o.dec_activity(o.fields(blob))["activity"]
    assert act["distanceMeters"] == 1234.5
    assert act["start"]["latLng"] == "10.0010000°, 20.0020000°"
    assert act["end"]["latLng"] == "10.0030000°, 20.0040000°"
    assert act["topCandidate"] == {"type": "in passenger vehicle", "typeCode": 29, "probability": 0.5}

    pts = [(10.0, 20.0), (10.5, 20.5), (-10.25, -20.75)]
    blob = synthetic.encode_path(start=(1, 0), end=(2, 0), seg_id="p1", points=pts, minute_offsets=[0, 130, 300])
    path = o.dec_path(o.fields(blob), 1, 0)["timelinePath"]
    assert [p["point"] for p in path] == ["10.0000000°, 20.0000000°", "10.5000000°, 20.5000000°",
                                          "-10.2500000°, -20.7500000°"]
    assert [p["durationMinutesOffsetFromStartTime"] for p in path] == ["0", "130", "300"]  # multi-byte varints

    blob = synthetic.encode_trip(start=(1, 0), end=(2, 0), seg_id="trip_1", off_start=0, off_end=0)
    assert o.dec_trip(o.fields(blob), "trip_1") == {"trip": {"name": "trip_1"}}


def test_negative_offsets_are_ten_byte_sign_extended_varints():
    o = upstream.odlh()
    assert len(synthetic.varint(-300)) == 10
    blob = synthetic.encode_trip(start=(1, 0), end=(2, 0), seg_id="t", off_start=-300, off_end=-300)
    p = o.fields(blob)
    raw = o.first(p, 7)[1]
    assert raw > (1 << 63) and o.to_signed(raw) == -300


def test_encrypted_batchsync_to_db_to_export_with_segment_ids(tmp_path):
    rs = rows()
    key = synthetic.synthetic_key(1)
    resp = synthetic.build_batch_sync_response(rs, key, mutation_ms=1_790_000_000_000)
    batch = decode_batch_sync(resp.body, resp.grpc_encoding, key)
    assert batch.snapshots == 4              # 3 chunks of <=60 rows + 1 decoy table
    assert len(batch.records) == len(rs)     # decoy table ignored
    assert batch.sync_token == "synthetic-sync-token-0001"
    assert batch.newest_mutation_ms == 1_790_000_000_000

    db = tmp_path / "odlh.db"
    assert write_records_db(db, batch.records) == len(rs)
    segs, stats = build_segments(db)
    assert stats.deleted_skipped == 1 and stats.decode_errors == 0 and stats.other == 0
    assert stats.total == len(rs) - 1 == len(segs)
    assert {s["segmentId"] for s in segs} == {r.segment_id for r in rs if not _is_deleted(r)}
    assert all(s["segmentId"] and s["segmentType"] in (1, 2, 3, 4) for s in segs)
    kinds = {1: "visit", 2: "activity", 3: "timelinePath", 4: "trip"}
    assert all(kinds[s["segmentType"]] in s for s in segs)      # type <-> payload key agree


def test_wrong_key_fails_cleanly_at_decrypt_stage(tmp_path):
    rs = rows()
    good, bad = synthetic.synthetic_key(1), synthetic.synthetic_key(2)
    resp = synthetic.build_batch_sync_response(rs, good, mutation_ms=1)
    with pytest.raises(SourceError) as ei:
        decode_batch_sync(resp.body, resp.grpc_encoding, bad)
    assert ei.value.stage == "decrypt"
    assert "wrong key" in ei.value.message


def test_gzip_compressed_grpc_frame():
    rs = rows()
    key = synthetic.synthetic_key(1)
    plain = synthetic.build_batch_sync_response(rs, key, mutation_ms=5)
    comp = synthetic.build_batch_sync_response(rs, key, mutation_ms=5, compress=True)
    assert plain.body[0] == 0 and comp.body[0] == 1 and comp.grpc_encoding == "gzip"
    a = decode_batch_sync(plain.body, None, key)
    b = decode_batch_sync(comp.body, comp.grpc_encoding, key)
    c = decode_batch_sync(comp.body, None, key)          # header missing -> upstream defaults to gzip
    assert [r["segment_id"] for r in a.records] == [r["segment_id"] for r in b.records] == \
           [r["segment_id"] for r in c.records]


def test_unsupported_grpc_encoding_and_garbage_are_fetch_errors():
    key = synthetic.synthetic_key(1)
    comp = synthetic.build_batch_sync_response(rows(), key, mutation_ms=5, compress=True)
    with pytest.raises(SourceError) as ei:
        decode_batch_sync(comp.body, "br", key)
    assert ei.value.stage == "fetch"
    with pytest.raises(SourceError) as ei:
        decode_batch_sync(b"", "gzip", key)
    assert ei.value.stage == "fetch" and "empty" in ei.value.message


def test_deleted_segments_skipped_but_includable(tmp_path):
    rs = rows()
    deleted = [r for r in rs if r.segment_id.startswith("synthetic-") and _is_deleted(r)]
    assert len(deleted) == 1
    db = make_db(tmp_path / "x.db", rs)
    segs, stats = build_segments(db)
    assert deleted[0].segment_id not in {s["segmentId"] for s in segs}
    assert stats.deleted_skipped == 1
    segs2, stats2 = build_segments(db, include_deleted=True)
    assert deleted[0].segment_id in {s["segmentId"] for s in segs2} and stats2.deleted_skipped == 0


def _is_deleted(row):
    o = upstream.odlh()
    d = o.first(o.fields(row.blob), 4)
    return bool(d and d[1])


def test_parity_with_upstream_build_minus_additive_fields(tmp_path):
    """Our reimplemented loop must equal upstream odlh_export.build() except segmentId/segmentType."""
    o = upstream.odlh()
    db = make_db(tmp_path / "x.db", rows())
    ours, ostats = build_segments(db, default_utc_offset_min=120)
    theirs, tstats = o.build(str(db))
    stripped = [{k: v for k, v in s.items() if k not in ("segmentId", "segmentType")} for s in ours]
    key = lambda s: json.dumps(s, sort_keys=True)  # noqa: E731 - ties ordering is not part of the contract
    assert sorted(map(key, stripped)) == sorted(map(key, theirs))
    assert (ostats.visit, ostats.activity, ostats.timelinePath, ostats.trip, ostats.deleted_skipped) == \
           (tstats[1], tstats[2], tstats[3], tstats[4], tstats["deleted"])


def _segs(tmp_path):
    return build_segments(make_db(tmp_path / "x.db", rows()))[0]


def test_negative_utc_offset_rendering_and_path_carry(tmp_path):
    segs = _segs(tmp_path)
    neg = [s for s in segs if s["startTimeTimezoneUtcOffsetMinutes"] == -300 and "visit" in s]
    assert len(neg) == 1
    v = neg[0]
    assert v["startTime"].endswith("-05:00") and v["endTime"].endswith("-05:00")
    i = segs.index(v)
    nxt = segs[i + 1]
    # timelinePath rows carry no offset in the store: it inherits the last seen one (-300)
    assert "timelinePath" in nxt and nxt["startTime"].endswith("-05:00")
    assert nxt["startTimeTimezoneUtcOffsetMinutes"] == -300
    # ... and the next offset-bearing segment resets it
    after = next(s for s in segs[i + 2:] if "visit" in s)
    assert after["startTimeTimezoneUtcOffsetMinutes"] == 120 and after["startTime"].endswith("+02:00")


def test_dst_like_offset_change(tmp_path):
    segs = _segs(tmp_path)
    offs = [s["startTimeTimezoneUtcOffsetMinutes"] for s in segs if "trip" not in s]
    assert 60 in offs and 120 in offs
    change = [s for s in segs if s["startTimeTimezoneUtcOffsetMinutes"] == 60
              and s["endTimeTimezoneUtcOffsetMinutes"] == 120]
    assert len(change) == 1
    c = change[0]
    assert c["startTime"].endswith("+01:00") and c["endTime"].endswith("+02:00")
    # the wall clock skips an hour but the instants stay contiguous with the previous segment
    prev = max((s for s in segs if s["endTimeTimezoneUtcOffsetMinutes"] == 60 and "visit" in s
                and datetime.fromisoformat(s["endTime"]) <= datetime.fromisoformat(c["startTime"])),
               key=lambda s: datetime.fromisoformat(s["endTime"]))
    assert datetime.fromisoformat(prev["endTime"]) == datetime.fromisoformat(c["startTime"])
    assert datetime.fromisoformat(c["endTime"]) > datetime.fromisoformat(c["startTime"])


def test_default_offset_seed_for_leading_path_rows(tmp_path):
    blob = synthetic.encode_path(start=(1_700_000_000, 0), end=(1_700_003_600, 0), seg_id="p",
                                 points=[(10.0, 20.0)], minute_offsets=[0])
    row = synthetic.SynthRow("p", 3, 1_700_000_000, 1_700_003_600, blob)
    db = make_db(tmp_path / "p.db", [row])
    assert build_segments(db)[0][0]["startTime"].endswith("+02:00")                        # upstream default 120
    assert build_segments(db, default_utc_offset_min=-60)[0][0]["startTime"].endswith("-01:00")


def test_idempotent_reexport_same_segment_ids_and_bytes(tmp_path):
    rs = rows()
    db1 = make_db(tmp_path / "a.db", rs)
    db2 = make_db(tmp_path / "b.db", rows())        # regenerated from scratch
    e1 = export_db(db1, tmp_path / "e1.json", adapter="synthetic", now=FIXED_NOW)
    e2 = export_db(db2, tmp_path / "e2.json", adapter="synthetic", now=FIXED_NOW)
    d1 = json.loads(e1.path.read_text(encoding="utf-8"))
    d2 = json.loads(e2.path.read_text(encoding="utf-8"))
    assert [s["segmentId"] for s in d1["semanticSegments"]] == [s["segmentId"] for s in d2["semanticSegments"]]
    assert len({s["segmentId"] for s in d1["semanticSegments"]}) == len(d1["semanticSegments"])
    assert e1.path.read_bytes() == e2.path.read_bytes()


def test_dataset_is_deterministic_and_seed_sensitive():
    a, b = rows(seed=1), rows(seed=1)
    assert [(r.segment_id, r.blob) for r in a] == [(r.segment_id, r.blob) for r in b]
    assert [r.blob for r in rows(seed=2)] != [r.blob for r in a]
    with pytest.raises(ValueError):
        synthetic.generate_rows(1, 5, END_DATE)


def test_export_document_shape_and_contract(tmp_path):
    db = make_db(tmp_path / "x.db", rows())
    res = export_db(db, tmp_path / "e.json", adapter="synthetic", now=FIXED_NOW)
    doc = json.loads(res.path.read_text(encoding="utf-8"))
    meta = doc["exportMeta"]
    assert meta["generator"] == "timeline-sync" and meta["adapter"] == "synthetic"
    assert meta["generatedAt"] == "2026-09-28T09:00:00Z" and meta["upstreamCommit"].startswith("3c1faa0")
    assert set(doc) == {"semanticSegments", "exportMeta"}
    assert res.stats.total == 131 and res.oldest_start and res.newest_end
    # coordinates are "lat°, lng°" strings
    v = next(s for s in doc["semanticSegments"] if "visit" in s)
    assert v["visit"]["topCandidate"]["placeLocation"]["latLng"].count("°") == 2
    assert build_document([], adapter="local_db", generated_at=FIXED_NOW)["exportMeta"]["adapter"] == "local_db"
    assert dumps_document({"a": "°"}).decode("utf-8").count("°") == 1   # UTF-8, not \u escapes


def test_synthetic_places_are_obviously_fake():
    for p in synthetic.PLACES.values():
        assert 9.0 < p.lat < 13.0 and 19.0 < p.lng < 23.0
    o = upstream.odlh()
    for r in rows():
        assert o.fields(r.blob)                       # every blob parses
