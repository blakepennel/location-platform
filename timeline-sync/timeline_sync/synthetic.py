"""Offline synthetic Timeline data, built as *wire-exact* Geller/ODLH protobufs.

This is a deliberately independent protobuf **writer** (upstream only ships a reader/decoder),
so running its output through upstream's own decoders proves the real pipeline end to end
without any network or real data:

    generate_rows()  ->  LocationHistorySegmentProto blobs
    build_batch_sync_response()  ->  ExternalDbSnapshot -> ExternalDbSync -> GellerAny
        -> AES-256-GCM(synthetic key) -> GellerE2eeElement -> GellerAny -> GellerElement
        -> SyncResult -> SyncResponseItem -> BatchSyncResponse -> gRPC frame (opt. gzip)
    sources.decode_batch_sync()  ->  upstream grpc_unframe -> parse -> snapshots -> rows_of -> write_db

Wire shapes (mirroring what upstream ``odlh_export`` / ``geller_fetch`` read):

  segment:  1 start{1 seconds,2 nanos}  2 end  3 data  4 is_deleted  6 segment_id  7/8 utc offsets
            (negative = sign-extended 10-byte varint)  9/10/11 optional varints
  data:     1 visit{2 prob f32, 6 confirmed, 4 top{1 featureId{1 fprint f64, 2 cellId f64},
            2 semanticType, 3 prob f32, 5 loc{1 latE7 f32, 2 lngE7 f32}, 1000 placeTypeCode}}
            2 activity{1 startLoc, 2 endLoc, 3 dist f32, 6 {1 mode, 2 prob f32}}
            3 path{4 packed latE7, 5 packed lngE7, 6 packed varint minute offsets}
  snapshot: 1 table name, 4 (repeated STRING) column names, 5 rows{1 (repeated) value msgs
            {1 int | 2 double | 3 string | 4 bytes | 5 bool}}, 6 database id
            (note: upstream ``rows_of`` decodes field 4 entries directly as column-name strings)

Everything is fake: places sit around lat 10.0 / lng 20.0 with made-up feature ids. No real
locations exist anywhere in this module.
"""
from __future__ import annotations

import gzip
import hashlib
import random
import struct
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Optional

# ============================================================== protobuf writer
def varint(n: int) -> bytes:
    if n < 0:
        n += 1 << 64  # protobuf sign-extends negative int32/int64 to 10 bytes
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def tag(field: int, wire: int) -> bytes:
    return varint((field << 3) | wire)


def f_varint(f: int, n: int) -> bytes:
    return tag(f, 0) + varint(n)


def f_bytes(f: int, b: bytes) -> bytes:
    return tag(f, 2) + varint(len(b)) + b


def f_str(f: int, s: str) -> bytes:
    return f_bytes(f, s.encode("utf-8"))


def f_float(f: int, x: float) -> bytes:
    return tag(f, 5) + struct.pack("<f", x)


def f_fixed32_signed(f: int, n: int) -> bytes:
    return tag(f, 5) + struct.pack("<i", n)


def f_fixed64(f: int, n: int) -> bytes:
    return tag(f, 1) + struct.pack("<Q", n)


def f_double(f: int, x: float) -> bytes:
    return tag(f, 1) + struct.pack("<d", x)


def e7(deg: float) -> int:
    return int(round(deg * 1e7))


def f_e7(f: int, deg: float) -> bytes:
    return f_fixed32_signed(f, e7(deg))


def ts_msg(seconds: int, nanos: int = 0) -> bytes:
    return f_varint(1, seconds) + (f_varint(2, nanos) if nanos else b"")


def latlng_msg(lat: float, lng: float) -> bytes:
    return f_e7(1, lat) + f_e7(2, lng)


# ============================================================== fake places
@dataclass(frozen=True)
class Place:
    key: str
    lat: float
    lng: float
    semantic_type: int  # 1 HOME, 2 WORK, 4 INFERRED, 5 SEARCHED_ADDRESS, 0 UNKNOWN
    place_type_code: int

    @property
    def fprint(self) -> int:
        return int.from_bytes(hashlib.sha256(b"synthetic-place:" + self.key.encode()).digest()[:8], "little")

    @property
    def cell(self) -> int:
        return int.from_bytes(hashlib.sha256(b"synthetic-place:" + self.key.encode()).digest()[8:16], "little")


PLACES = {p.key: p for p in (
    Place("home", 10.00120, 20.00340, 1, 100),
    Place("work", 10.01210, 20.01870, 2, 200),
    Place("cafe", 10.00450, 20.00910, 4, 300),
    Place("park", 10.00780, 20.00120, 0, 400),
    Place("gym", 10.00230, 20.01500, 4, 500),
    Place("layover", 10.03500, 20.04100, 0, 900),
    Place("far_hotel", 12.00100, 22.00400, 0, 600),
    Place("far_sight", 12.00900, 22.01200, 5, 700),
    Place("far_food", 12.00400, 22.00800, 0, 800),
)}


# ============================================================== segment encoders
Instant = tuple  # (seconds, nanos)


def _segment(start: Instant, end: Instant, data: Optional[bytes], seg_id: str, *,
             off_start: Optional[int] = None, off_end: Optional[int] = None,
             deleted: bool = False, extras: Optional[dict] = None) -> bytes:
    out = f_bytes(1, ts_msg(*start)) + f_bytes(2, ts_msg(*end))
    if data is not None:
        out += f_bytes(3, data)
    if deleted:
        out += f_varint(4, 1)
    out += f_str(6, seg_id)
    if off_start is not None:
        out += f_varint(7, off_start)
    if off_end is not None:
        out += f_varint(8, off_end)
    for fnum, val in sorted((extras or {}).items()):
        out += f_varint(fnum, val)
    return out


def encode_visit(place: Place, *, start: Instant, end: Instant, seg_id: str, off_start: Optional[int],
                 off_end: Optional[int], lat: Optional[float] = None, lng: Optional[float] = None,
                 prob: float = 0.9, top_prob: float = 0.8, confirmed: bool = False,
                 deleted: bool = False, extras: Optional[dict] = None) -> bytes:
    loc = latlng_msg(place.lat if lat is None else lat, place.lng if lng is None else lng)
    top = (f_bytes(1, f_fixed64(1, place.fprint) + f_fixed64(2, place.cell))
           + f_varint(2, place.semantic_type) + f_float(3, top_prob)
           + f_bytes(5, loc) + f_varint(1000, place.place_type_code))
    cand = f_float(2, prob) + (f_varint(6, 1) if confirmed else b"") + f_bytes(4, top)
    return _segment(start, end, f_bytes(1, cand), seg_id, off_start=off_start, off_end=off_end,
                    deleted=deleted, extras=extras)


def encode_activity(*, start: Instant, end: Instant, seg_id: str, off_start: Optional[int],
                    off_end: Optional[int], from_ll: tuple, to_ll: tuple, distance_m: float,
                    mode: int, prob: float = 0.95, deleted: bool = False) -> bytes:
    act = (f_bytes(1, latlng_msg(*from_ll)) + f_bytes(2, latlng_msg(*to_ll))
           + f_float(3, distance_m) + f_bytes(6, f_varint(1, mode) + f_float(2, prob)))
    return _segment(start, end, f_bytes(2, act), seg_id, off_start=off_start, off_end=off_end, deleted=deleted)


def encode_path(*, start: Instant, end: Instant, seg_id: str, points: list, minute_offsets: list,
                off_start: Optional[int] = None, off_end: Optional[int] = None) -> bytes:
    lats = b"".join(struct.pack("<i", e7(p[0])) for p in points)
    lngs = b"".join(struct.pack("<i", e7(p[1])) for p in points)
    offs = b"".join(varint(m) for m in minute_offsets)
    inner = f_bytes(4, lats) + f_bytes(5, lngs) + f_bytes(6, offs)
    return _segment(start, end, f_bytes(3, inner), seg_id, off_start=off_start, off_end=off_end)


def encode_trip(*, start: Instant, end: Instant, seg_id: str, off_start: Optional[int],
                off_end: Optional[int]) -> bytes:
    return _segment(start, end, None, seg_id, off_start=off_start, off_end=off_end)


# ============================================================== dataset
@dataclass
class SynthRow:
    segment_id: str
    segment_type: int  # 1 visit 2 activity 3 timelinePath 4 trip
    start_s: int
    end_s: int
    blob: bytes


def _sid(kind: str, *parts) -> str:
    return "synthetic-" + hashlib.sha1("|".join([kind, *map(str, parts)]).encode()).hexdigest()[:20]


class _Generator:
    """Deterministic, seeded two-week timeline with the timezone edge cases baked in."""

    def __init__(self, seed: int, days: int, end_date: date):
        if days < 10:
            raise ValueError("days must be >= 10 (the dataset embeds a trip, a DST-like change and a layover)")
        self.rng = random.Random(seed)
        self.days = days
        self.start_date = end_date - timedelta(days=days - 1)
        self.switch = days // 2            # DST-like change (+60 -> +120) at 03:00 wall time
        self.trip0 = self.switch - 3       # 3-day trip
        self.deleted_day = self.switch + 1
        self.layover_day = self.switch + 3  # visit rendered at UTC-05:00
        self.midnight = [
            int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp())
            for d in (self.start_date + timedelta(days=i) for i in range(days))
        ]
        self._anch: dict = {}
        self.rows: list[SynthRow] = []

    # ---- time
    def offset_at(self, d: int, wall: int) -> int:
        if d < self.switch:
            return 60
        if d == self.switch:
            return 60 if wall < 180 else 120
        return 120

    def anchor(self, d: int, base: int):
        """(epoch seconds, nanos, utc offset) for wall-clock minute ``base`` of day index ``d``;
        memoised so the end of one segment and the start of the next are the same instant."""
        k = (d, base)
        if k not in self._anch:
            interior = 0 < base < 1440
            jm = self.rng.randint(-4, 4) if interior else 0
            js = self.rng.randint(0, 59) if interior else 0
            ns = self.rng.randint(0, 999) * 1_000_000 if (interior and self.rng.random() < 0.5) else 0
            wall = base + jm
            off = self.offset_at(d, wall)
            self._anch[k] = (self.midnight[d] + wall * 60 + js - off * 60, ns, off)
        return self._anch[k]

    # ---- helpers
    def _jit(self, place: Place):
        return (place.lat + self.rng.uniform(-0.0002, 0.0002), place.lng + self.rng.uniform(-0.0002, 0.0002))

    def _prob(self, lo: float = 0.72, hi: float = 0.99) -> float:
        return round(self.rng.uniform(lo, hi), 2)

    def visit(self, d, key, a0, a1, *, off=None, deleted=False, confirmed=False, extras=None):
        s, sn, o0 = self.anchor(d, a0)
        e, en, o1 = self.anchor(d, a1)
        place = PLACES[key]
        lat, lng = self._jit(place)
        sid = _sid("visit", key, s, e, "d" if deleted else "")
        blob = encode_visit(place, start=(s, sn), end=(e, en), seg_id=sid,
                            off_start=off if off is not None else o0,
                            off_end=off if off is not None else o1, lat=lat, lng=lng,
                            prob=self._prob(), top_prob=self._prob(), confirmed=confirmed,
                            deleted=deleted, extras=extras)
        self.rows.append(SynthRow(sid, 1, s, e, blob))

    def activity(self, d, mode, frm, to, a0, a1, dist):
        s, sn, o0 = self.anchor(d, a0)
        e, en, o1 = self.anchor(d, a1)
        sid = _sid("activity", mode, frm, to, s, e)
        blob = encode_activity(start=(s, sn), end=(e, en), seg_id=sid, off_start=o0, off_end=o1,
                               from_ll=self._jit(PLACES[frm]), to_ll=self._jit(PLACES[to]),
                               distance_m=float(dist), mode=mode, prob=self._prob(0.8, 0.99))
        self.rows.append(SynthRow(sid, 2, s, e, blob))

    def path(self, d, a0, a1, frm, to):
        s, sn, _ = self.anchor(d, a0)
        e, en, _ = self.anchor(d, a1)
        n = self.rng.randint(6, 9)
        dur_min = max(1, (e - s) // 60)
        a, b = PLACES[frm], PLACES[to]
        pts, offs = [], []
        for i in range(n):
            f = i / (n - 1)
            pts.append((a.lat + (b.lat - a.lat) * f + self.rng.uniform(-0.0003, 0.0003),
                        a.lng + (b.lng - a.lng) * f + self.rng.uniform(-0.0003, 0.0003)))
            offs.append(round(dur_min * f))
        sid = _sid("path", s, e, frm, to)
        # like real data: timelinePath rows carry NO utc offset
        blob = encode_path(start=(s, sn), end=(e, en), seg_id=sid, points=pts, minute_offsets=offs)
        self.rows.append(SynthRow(sid, 3, s, e, blob))

    def trip(self, d0, d2):
        s, sn, o0 = self.anchor(d0, 0)
        e, en, o1 = self.anchor(d2, 1380)   # trips end during the last day, not at midnight
        sid = f"trip_{s}"
        self.rows.append(SynthRow(sid, 4, s, e, encode_trip(start=(s, sn), end=(e, en), seg_id=sid,
                                                              off_start=o0, off_end=o1)))

    # ---- day plans (wall-clock minutes since local midnight)
    def _weekday(self, d, evening_park: bool):
        self.visit(d, "home", 0, 450)
        self.activity(d, 2, "home", "cafe", 450, 470, 1200)
        self.visit(d, "cafe", 470, 510)
        self.activity(d, 29, "cafe", "work", 510, 535, 8500)
        self.visit(d, "work", 535, 1050, confirmed=self.rng.random() < 0.3)
        self.path(d, 450, 570, "home", "work")
        if evening_park:
            self.activity(d, 29, "work", "park", 1050, 1075, 7300)
            self.visit(d, "park", 1075, 1140)
            self.activity(d, 2, "park", "home", 1140, 1165, 2100)
            self.visit(d, "home", 1165, 1440, extras={9: 2, 10: 1, 11: 3})
        else:
            self.activity(d, 11, "work", "gym", 1050, 1070, 4000)
            self.visit(d, "gym", 1070, 1140)
            self.activity(d, 2, "gym", "home", 1140, 1170, 2900)
            self.visit(d, "home", 1170, 1440, extras={9: 2, 10: 1, 11: 3})
        self.path(d, 1050, 1170, "work", "home")

    def _weekend(self, d):
        self.visit(d, "home", 0, 600)
        self.activity(d, 2, "home", "park", 600, 630, 1800)
        self.visit(d, "park", 630, 780)
        self.activity(d, 2, "park", "cafe", 780, 795, 900)
        self.visit(d, "cafe", 795, 900)
        self.activity(d, 2, "cafe", "home", 900, 925, 1700)
        self.visit(d, "home", 925, 1440)
        self.path(d, 600, 930, "home", "park")   # 5.5 h bucket -> minute offsets > 127 (2-byte varints)

    def _trip_day(self, d, k):
        if k == 0:
            self.visit(d, "home", 0, 390)
            self.activity(d, 29, "home", "far_hotel", 390, 630, 240000)
            self.visit(d, "far_hotel", 630, 1440)
            self.path(d, 390, 630, "home", "far_hotel")
        elif k == 1:
            self.visit(d, "far_hotel", 0, 540)
            self.activity(d, 2, "far_hotel", "far_sight", 540, 560, 1400)
            self.visit(d, "far_sight", 560, 780)
            self.activity(d, 29, "far_sight", "far_food", 780, 795, 3200)
            self.visit(d, "far_food", 795, 900)
            self.activity(d, 2, "far_food", "far_hotel", 900, 915, 900)
            self.visit(d, "far_hotel", 915, 1440)
            self.path(d, 540, 930, "far_hotel", "far_sight")
        else:
            self.visit(d, "far_hotel", 0, 600)
            self.activity(d, 29, "far_hotel", "home", 600, 840, 240000)
            self.visit(d, "home", 840, 1440)
            self.path(d, 600, 840, "far_hotel", "home")

    def _layover_day(self, d):
        self.visit(d, "home", 0, 450)
        self.activity(d, 2, "home", "cafe", 450, 470, 1200)
        self.visit(d, "cafe", 470, 510)
        self.activity(d, 29, "cafe", "work", 510, 535, 8500)
        self.visit(d, "work", 535, 1050)
        self.path(d, 450, 570, "home", "work")
        self.activity(d, 29, "work", "layover", 1050, 1080, 30000)
        self.visit(d, "layover", 1080, 1170, off=-300)         # UTC-05:00 segment
        self.path(d, 1170, 1260, "layover", "home")            # offset-less -> inherits -300
        self.visit(d, "home", 1260, 1440)                       # own +120 offset again

    def build(self) -> list[SynthRow]:
        for d in range(self.days):
            k = d - self.trip0
            if 0 <= k <= 2:
                self._trip_day(d, k)
            elif d == self.layover_day:
                self._layover_day(d)
            elif (self.start_date + timedelta(days=d)).weekday() >= 5:
                self._weekend(d)
            else:
                self._weekday(d, evening_park=(d % 2 == 1))
            if d == self.deleted_day:
                self.visit(d, "cafe", 720, 750, deleted=True)  # user-deleted; must never be exported
        self.trip(self.trip0, self.trip0 + 2)
        self.rows.sort(key=lambda r: (r.start_s, r.segment_type != 4, r.end_s))
        return self.rows


def default_end_date(now: Optional[datetime] = None) -> date:
    """Last full UTC day before ``now`` (so synthetic data looks freshly synced)."""
    now = now or datetime.now(timezone.utc)
    return (now.astimezone(timezone.utc) - timedelta(days=1)).date()


def generate_rows(seed: int = 1, days: int = 14, end_date: Optional[date] = None) -> list[SynthRow]:
    return _Generator(seed, days, end_date or default_end_date()).build()


def synthetic_key(seed: int = 1) -> bytes:
    """Deterministic 32-byte AES key for synthetic data. Not a secret."""
    return hashlib.sha256(f"timeline-sync-synthetic-key:{seed}".encode()).digest()


# ============================================================== Geller envelope
TYPE_URL_PREFIX = "type.googleapis.com/geller.oneplatform."
ODLH_DATA_TYPE = 79
COLUMNS = ["timestamp_millis", "segment_id", "semantic_segment", "start_timestamp_seconds",
           "end_timestamp_seconds", "segment_type", "hierarchy_level"]


def _value_msg(v) -> bytes:
    if v is None:
        return b""
    if isinstance(v, bool):
        return f_varint(5, int(v))
    if isinstance(v, int):
        return f_varint(1, v)
    if isinstance(v, float):
        return f_double(2, v)
    if isinstance(v, str):
        return f_str(3, v)
    if isinstance(v, (bytes, bytearray)):
        return f_bytes(4, bytes(v))
    raise TypeError(type(v))


def snapshot_msg(table: str, columns: list, rows: list, database_id: int = 1) -> bytes:
    out = f_str(1, table)
    for c in columns:
        out += f_str(4, c)                               # repeated STRING (see module docstring)
    for r in rows:
        out += f_bytes(5, b"".join(f_bytes(1, _value_msg(v)) for v in r))
    return out + f_varint(6, database_id)


def geller_any(type_suffix: str, value: bytes) -> bytes:
    return f_str(1, TYPE_URL_PREFIX + type_suffix) + f_bytes(2, value)


def encrypt_element(plaintext: bytes, key: bytes, iv: bytes) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    return iv + AESGCM(key).encrypt(iv, plaintext, None)  # 12-byte IV || ciphertext+tag


def grpc_frame(msg: bytes, compress: bool = False) -> bytes:
    if compress:
        payload = gzip.compress(msg, mtime=0)
        return b"\x01" + struct.pack(">I", len(payload)) + payload
    return b"\x00" + struct.pack(">I", len(msg)) + msg


@dataclass
class SyntheticResponse:
    body: bytes
    grpc_encoding: Optional[str]
    sync_token: str


def build_batch_sync_response(rows: list[SynthRow], key: bytes, *, mutation_ms: int,
                              compress: bool = False, chunk: int = 60,
                              sync_token: str = "synthetic-sync-token-0001",
                              database_id: int = 1, corpus_refs: tuple = (),
                              element_prefix: str = "synthetic-element") -> SyntheticResponse:
    """Wrap rows into an encrypted, gRPC-framed BatchSyncResponse (exactly what
    ``geller_fetch.snapshots`` unwraps). Rows are split over several mutations; the last chunk
    travels in SyncResult.results (field 6) and a decoy snapshot of another table is included,
    to exercise upstream's multi-element and table-filter paths."""
    chunks = [rows[i:i + chunk] for i in range(0, len(rows), chunk)] or [[]]
    elements: list[bytes] = []
    for n, part in enumerate(chunks):
        table_rows = [[mutation_ms, r.segment_id, r.blob, r.start_s, r.end_s, r.segment_type, 0] for r in part]
        snap = snapshot_msg("semantic_segment_table", COLUMNS, table_rows, database_id)
        inner = geller_any("ExternalDbSync", f_bytes(3, snap))
        eid = f"{element_prefix}-{n:04d}"
        iv = hashlib.sha256(b"iv:" + eid.encode()).digest()[:12]
        e2ee = f_bytes(1, encrypt_element(inner, key, iv))
        payload = geller_any("GellerE2eeElement", e2ee)
        elements.append(f_str(2, eid) + f_bytes(3, payload))
    decoy = snapshot_msg("other_table", ["a", "b"], [[1, "x"], [2, "y"]], database_id)
    decoy_any = geller_any("ExternalDbSync", f_bytes(3, decoy))
    iv = hashlib.sha256(b"iv:decoy").digest()[:12]
    decoy_el = f_str(2, "synthetic-element-decoy") + f_bytes(
        3, geller_any("GellerE2eeElement", f_bytes(1, encrypt_element(decoy_any, key, iv))))

    sr = f_varint(1, ODLH_DATA_TYPE)
    for el in elements[:-1]:
        sr += f_bytes(5, el)
    sr += f_bytes(5, decoy_el)
    sr += f_bytes(6, elements[-1])                    # results (field 6) instead of mutations
    sr += f_str(8, sync_token)
    for ref in corpus_refs:                           # SyncResult.corpusName: other corpora to fetch
        sr += f_str(4, ref)
    item = f_bytes(2, sr) + f_varint(3, ODLH_DATA_TYPE)
    msg = f_bytes(1, item)
    return SyntheticResponse(body=grpc_frame(msg, compress), grpc_encoding="gzip" if compress else None,
                             sync_token=sync_token)
