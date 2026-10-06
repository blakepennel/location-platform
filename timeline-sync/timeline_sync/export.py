"""Decode an ODLH SQLite db into the Timeline export document (TIMELINE_EXPORT_CONTRACT.md).

This reimplements ONLY the row loop of upstream ``odlh_export.build()`` (about 30 lines) because
upstream drops ``segment_id`` for every non-trip segment and never closes its sqlite handle
(which pins the file on Windows). Everything that decides *what a segment means* is upstream's:
``fields / first / submsg / ts_of / iso / to_signed / dec_visit / dec_activity / dec_path /
dec_trip``. Semantics kept identical to upstream:

* segments flagged ``is_deleted`` (field 4) are skipped (counted in ``deleted``)
* start/end UTC offsets come from fields 7/8, sign-extended negatives are decoded via
  ``to_signed``; rows without an offset (timelinePath) inherit the last seen offset, seeded
  with ``default_utc_offset_min`` (upstream: 120, override TIMELINE_DEFAULT_UTC_OFFSET_MIN)
* fields 9/10/11 -> finalizationStatus / displayMode / source
* unknown ``segment_type`` counts as ``other`` and is dropped; a decode exception counts as
  ``err`` and the segment is dropped

Deliberate, documented differences: rows are ordered ``start_timestamp_seconds, rowid`` (upstream
orders by start only, leaving ties to sqlite), and each segment gains ``segmentId`` /
``segmentType`` (contract), plus a top-level ``exportMeta``.
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from . import upstream
from .logging import log

TYPE_KEYS = {1: "visit", 2: "activity", 3: "timelinePath", 4: "trip"}
GENERATOR = "timeline-sync"


class ExportError(RuntimeError):
    pass


@dataclass
class ExportStats:
    visit: int = 0
    activity: int = 0
    timelinePath: int = 0
    trip: int = 0
    deleted_skipped: int = 0
    decode_errors: int = 0
    other: int = 0

    @property
    def total(self) -> int:
        return self.visit + self.activity + self.timelinePath + self.trip

    def as_record_counts(self) -> dict:
        return {"visit": self.visit, "activity": self.activity, "timelinePath": self.timelinePath,
                "trip": self.trip, "total": self.total, "deleted_skipped": self.deleted_skipped,
                "decode_errors": self.decode_errors}


@dataclass
class ExportResult:
    path: Path
    stats: ExportStats
    oldest_start: Optional[str] = None
    newest_end: Optional[str] = None
    adapter: str = ""
    extra: dict = field(default_factory=dict)


def build_segments(db_path, *, default_utc_offset_min: int = 120, include_paths: bool = True,
                   include_deleted: bool = False) -> tuple[list[dict], ExportStats]:
    o = upstream.odlh()
    con = sqlite3.connect(str(db_path))
    try:
        rows = con.execute(
            "SELECT segment_id, segment_type, start_timestamp_seconds, end_timestamp_seconds, "
            "semantic_segment FROM semantic_segment_table "
            "ORDER BY start_timestamp_seconds, rowid").fetchall()
    except sqlite3.Error as e:
        raise ExportError(f"cannot read semantic_segment_table: {type(e).__name__}") from None
    finally:
        con.close()

    segs: list[dict] = []
    st = ExportStats()
    last_off = default_utc_offset_min
    for seg_id, stype, ts0, ts1, blob in rows:
        try:
            p = o.fields(blob)
            offs = o.first(p, 7)
            offe = o.first(p, 8)
            off0 = o.to_signed(offs[1]) if offs else last_off
            off1 = o.to_signed(offe[1]) if offe else off0
            if offs:
                last_off = off0
            st_s, st_ns = o.ts_of(o.submsg(p, 1))
            en_s, en_ns = o.ts_of(o.submsg(p, 2))
            st_s = st_s if st_s is not None else ts0
            en_s = en_s if en_s is not None else ts1
            deleted = o.first(p, 4)
            if deleted and deleted[0] == 0 and deleted[1] and not include_deleted:
                st.deleted_skipped += 1
                continue
            seg = {"startTime": o.iso(st_s, st_ns, off0), "endTime": o.iso(en_s, en_ns, off1),
                   "startTimeTimezoneUtcOffsetMinutes": off0, "endTimeTimezoneUtcOffsetMinutes": off1}
            for fnum, name in ((9, "finalizationStatus"), (10, "displayMode"), (11, "source")):
                v = o.first(p, fnum)
                if v and v[0] == 0:
                    seg[name] = v[1]
            if stype == 1:
                seg.update(o.dec_visit(p))
                st.visit += 1
            elif stype == 2:
                seg.update(o.dec_activity(p))
                st.activity += 1
            elif stype == 3:
                if not include_paths:
                    continue
                seg.update(o.dec_path(p, st_s, off0))
                st.timelinePath += 1
            elif stype == 4:
                seg.update(o.dec_trip(p, seg_id))
                st.trip += 1
            else:
                st.other += 1
                continue
            seg["segmentId"] = seg_id
            seg["segmentType"] = stype
            segs.append(seg)
        except Exception as ex:  # noqa: BLE001 - mirrors upstream: count and continue
            st.decode_errors += 1
            log.warning("export.segment_decode_failed", segment_id=str(seg_id), segment_type=stype,
                        error=type(ex).__name__)
    return segs, st


def _to_utc(iso_text: Optional[str]) -> Optional[datetime]:
    if not iso_text:
        return None
    try:
        d = datetime.fromisoformat(iso_text)
    except ValueError:
        return None
    return d.astimezone(timezone.utc)


def _fmt_utc(d: Optional[datetime]) -> Optional[str]:
    return d.strftime("%Y-%m-%dT%H:%M:%SZ") if d else None


def record_span(segs: list[dict]) -> tuple[Optional[str], Optional[str]]:
    """(oldest startTime, newest endTime) across segments, both UTC ISO-8601."""
    starts = [d for d in (_to_utc(s.get("startTime")) for s in segs) if d]
    ends = [d for d in (_to_utc(s.get("endTime")) for s in segs) if d]
    return _fmt_utc(min(starts)) if starts else None, _fmt_utc(max(ends)) if ends else None


def build_document(segs: list[dict], *, adapter: str, generated_at: datetime,
                   upstream_commit: Optional[str] = None) -> dict:
    return {
        "semanticSegments": segs,
        "exportMeta": {
            "generator": GENERATOR,
            "upstreamCommit": upstream_commit or upstream.upstream_commit_or_pin(),
            "generatedAt": generated_at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "adapter": adapter,
        },
    }


def dumps_document(doc: dict) -> bytes:
    return (json.dumps(doc, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def export_db(db_path, out_path, *, adapter: str, now: datetime, default_utc_offset_min: int = 120,
              upstream_commit: Optional[str] = None) -> ExportResult:
    """Decode ``db_path`` and atomically write the export document to ``out_path``."""
    from .publish import atomic_write_bytes  # local import: publish has no dependency on export

    if not Path(db_path).is_file():
        raise ExportError("raw database not found; run `timeline-sync fetch` first")
    segs, stats = build_segments(db_path, default_utc_offset_min=default_utc_offset_min)
    oldest, newest = record_span(segs)
    doc = build_document(segs, adapter=adapter, generated_at=now, upstream_commit=upstream_commit)
    atomic_write_bytes(Path(out_path), dumps_document(doc))
    log.info("export.written", segments=stats.total, deleted_skipped=stats.deleted_skipped,
             decode_errors=stats.decode_errors)
    return ExportResult(path=Path(out_path), stats=stats, oldest_start=oldest, newest_end=newest, adapter=adapter)
