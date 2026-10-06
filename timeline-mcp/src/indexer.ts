/**
 * Idempotent importer: timeline export → SQLite index.
 *
 *  - full-snapshot semantics: the export IS the truth; anything indexed that is no longer in it is removed
 *  - upsert by segment_id inside one transaction (all-or-nothing)
 *  - malformed segments are skipped and counted, never fatal to the batch
 *  - same export sha256 twice → no-op
 */
import { createHash } from "node:crypto";
import { isoWithOffset, parseLatLngString, redactString, transaction, type Logger } from "@location/shared";
import { getMeta, setMeta, setMetaJson, type Database } from "./db.ts";
import {
  ExportFormatError,
  ExportMissingError,
  type ExportData,
  type ExportMeta,
  type HistoricalLocationSource,
} from "./source.ts";

export type SegmentKind = "visit" | "activity" | "timeline_path" | "trip";
export const KINDS: SegmentKind[] = ["visit", "activity", "timeline_path", "trip"];

const TABLE: Record<SegmentKind, string> = {
  visit: "visits",
  activity: "activities",
  timeline_path: "timeline_paths",
  trip: "trips",
};

export class ImportRejectedError extends Error {
  override name = "ImportRejectedError";
}

/* ------------------------------------------------------------------ parsing helpers */

const TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

export interface ParsedTime {
  ms: number;
  offsetMin: number;
}

/**
 * Parse a Timeline timestamp keeping its own UTC offset ("2025-01-02T14:01:06.171+02:00").
 * If the string carries no offset, `fallbackOffsetMin` (the segment's *TimezoneUtcOffsetMinutes field) is used, else UTC.
 */
export function parseSegmentTime(value: unknown, fallbackOffsetMin?: unknown): ParsedTime | null {
  if (typeof value !== "string") return null;
  const m = TIME_RE.exec(value.trim());
  if (!m) return null;
  const [, ys, mos, ds, hs, mis, ss = "0", frac = "0", zone] = m;
  const y = +ys, mo = +mos, d = +ds, h = +hs, mi = +mis, s = +ss;
  if (y < 1970 || y > 2200 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  const ms = Number(frac.padEnd(3, "0").slice(0, 3));
  const wall = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  if (new Date(wall).getUTCDate() !== d) return null; // e.g. Feb 30
  let offsetMin: number;
  if (zone) {
    if (zone.toUpperCase() === "Z") offsetMin = 0;
    else {
      const sign = zone[0] === "-" ? -1 : 1;
      const digits = zone.slice(1).replace(":", "");
      const oh = +digits.slice(0, 2);
      const om = digits.length > 2 ? +digits.slice(2, 4) : 0;
      if (om > 59) return null;
      offsetMin = sign * (oh * 60 + om);
    }
  } else if (typeof fallbackOffsetMin === "number" && Number.isFinite(fallbackOffsetMin)) {
    offsetMin = Math.round(fallbackOffsetMin);
  } else {
    offsetMin = 0;
  }
  if (Math.abs(offsetMin) > 18 * 60) return null;
  return { ms: wall - offsetMin * 60_000, offsetMin };
}

const COORD_RE = /(-?\d+(?:\.\d+)?)[^\d\-]*,[^\d\-]*(-?\d+(?:\.\d+)?)/;

/** Tolerant "lat°, lng°" parser (also survives a mojibake'd degree sign) and {latitude, longitude} objects. */
export function parseCoord(v: unknown): { lat: number; lng: number } | null {
  if (typeof v === "string") {
    const strict = parseLatLngString(v);
    if (strict) return strict;
    const m = COORD_RE.exec(v);
    if (!m) return null;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const lat = Number(o.latitude);
    const lng = Number(o.longitude);
    if (o.latitude != null && o.longitude != null && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)
      return { lat, lng };
  }
  return null;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function str(v: unknown, max = 500): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/* ------------------------------------------------------------------ normalization */

interface PlaceAttrs {
  placeId: string | null;
  featureId: string | null;
  name: string | null;
  address: string | null;
  category: string | null;
  semanticType: string | null;
  semanticTypeCode: number | null;
  placeTypeCode: number | null;
  lat: number | null;
  lng: number | null;
}

interface Base {
  segmentId: string;
  startMs: number;
  endMs: number;
  startOff: number;
  endOff: number;
  finalization: number | null;
  source: number | null;
  contentHash: string;
}
export interface NormVisit extends Base {
  kind: "visit";
  placeKey: string | null;
  place: PlaceAttrs | null;
  probability: number | null;
  candidateProbability: number | null;
  semanticType: string | null;
  isConfirmed: boolean;
}
export interface NormActivity extends Base {
  kind: "activity";
  mode: string | null;
  modeCode: number | null;
  modeProbability: number | null;
  distanceM: number | null;
  start: { lat: number; lng: number } | null;
  end: { lat: number; lng: number } | null;
}
export interface NormPath extends Base {
  kind: "timeline_path";
  points: [number, number, number | null][];
}
export interface NormTrip extends Base {
  kind: "trip";
  name: string | null;
}
type Norm = NormVisit | NormActivity | NormPath | NormTrip;
type NormResult = { ok: true; seg: Norm } | { ok: false; reason: string };

export const ERROR_REASONS = ["not_an_object", "missing_kind", "bad_shape", "bad_time", "end_before_start", "bad_coords"] as const;

/** Rounded (~11 m) location fingerprint used as a place key when Google gave no placeId/featureId. */
export function locationPlaceKey(lat: number, lng: number): string {
  return "loc_" + sha(`place|${lat.toFixed(4)}|${lng.toFixed(4)}`).slice(0, 16);
}

export function normalizeSegment(raw: unknown): NormResult {
  if (!isObj(raw)) return { ok: false, reason: "not_an_object" };

  let kind: SegmentKind | null = null;
  if ("visit" in raw) kind = "visit";
  else if ("activity" in raw) kind = "activity";
  else if ("timelinePath" in raw) kind = "timeline_path";
  else if ("trip" in raw) kind = "trip";
  if (!kind) return { ok: false, reason: "missing_kind" };

  const body = kind === "timeline_path" ? raw.timelinePath : raw[kind];
  if (kind === "timeline_path" ? !Array.isArray(body) : !isObj(body)) return { ok: false, reason: "bad_shape" };

  const st = parseSegmentTime(raw.startTime, raw.startTimeTimezoneUtcOffsetMinutes);
  const en = parseSegmentTime(raw.endTime, raw.endTimeTimezoneUtcOffsetMinutes ?? raw.startTimeTimezoneUtcOffsetMinutes);
  if (!st || !en) return { ok: false, reason: "bad_time" };
  if (en.ms < st.ms) return { ok: false, reason: "end_before_start" };

  let idPart = ""; // "placeId or first point" for derived ids
  let result: Norm;

  const common = {
    startMs: st.ms,
    endMs: en.ms,
    startOff: st.offsetMin,
    endOff: en.offsetMin,
    finalization: int(raw.finalizationStatus),
    source: int(raw.source),
  };

  if (kind === "visit") {
    const v = body as Record<string, any>;
    const tc = isObj(v.topCandidate) ? v.topCandidate : null;
    let loc: { lat: number; lng: number } | null = null;
    const rawLoc = tc && isObj(tc.placeLocation) ? tc.placeLocation.latLng : undefined;
    if (rawLoc !== undefined && rawLoc !== null) {
      loc = parseCoord(rawLoc);
      if (!loc) return { ok: false, reason: "bad_coords" };
    }
    const placeId = tc ? str(tc.placeId, 200) : null;
    const featureId = tc ? str(tc.featureId, 200) : null;
    const place: PlaceAttrs | null = tc
      ? {
          placeId,
          featureId,
          name: str(tc.placeName ?? tc.name),
          address: str(tc.placeAddress ?? tc.address, 1000),
          category: str(tc.placeCategory ?? tc.category, 200),
          semanticType: str(tc.semanticType, 60),
          semanticTypeCode: int(tc.semanticTypeCode),
          placeTypeCode: int(tc.placeTypeCode),
          lat: loc?.lat ?? null,
          lng: loc?.lng ?? null,
        }
      : null;
    const placeKey = placeId ?? featureId ?? (loc ? locationPlaceKey(loc.lat, loc.lng) : null);
    idPart = placeId ?? featureId ?? (loc ? `${loc.lat},${loc.lng}` : "");
    result = {
      kind,
      ...common,
      segmentId: "",
      contentHash: "",
      placeKey,
      place: placeKey ? place : null,
      probability: num(v.probability),
      candidateProbability: tc ? num(tc.probability) : null,
      semanticType: place?.semanticType ?? null,
      isConfirmed: v.isConfirmed === true,
    };
  } else if (kind === "activity") {
    const a = body as Record<string, any>;
    const sRaw = isObj(a.start) ? a.start.latLng : undefined;
    const eRaw = isObj(a.end) ? a.end.latLng : undefined;
    let start: { lat: number; lng: number } | null = null;
    let end: { lat: number; lng: number } | null = null;
    if (sRaw !== undefined && sRaw !== null) {
      start = parseCoord(sRaw);
      if (!start) return { ok: false, reason: "bad_coords" };
    }
    if (eRaw !== undefined && eRaw !== null) {
      end = parseCoord(eRaw);
      if (!end) return { ok: false, reason: "bad_coords" };
    }
    const dm = num(a.distanceMeters);
    const tc = isObj(a.topCandidate) ? a.topCandidate : null;
    idPart = start ? `${start.lat},${start.lng}` : "";
    result = {
      kind,
      ...common,
      segmentId: "",
      contentHash: "",
      mode: tc ? str(tc.type, 80) : null,
      modeCode: tc ? int(tc.typeCode) : null,
      modeProbability: tc ? num(tc.probability) : null,
      distanceM: dm !== null && dm >= 0 ? dm : null,
      start,
      end,
    };
  } else if (kind === "timeline_path") {
    const pts: [number, number, number | null][] = [];
    for (const p of body as unknown[]) {
      if (!isObj(p)) return { ok: false, reason: "bad_coords" };
      const c = parseCoord(p.point);
      if (!c) return { ok: false, reason: "bad_coords" };
      pts.push([c.lat, c.lng, num(p.durationMinutesOffsetFromStartTime)]);
    }
    idPart = pts.length ? `${pts[0][0]},${pts[0][1]}` : "";
    result = { kind, ...common, segmentId: "", contentHash: "", points: pts };
  } else {
    const t = body as Record<string, any>;
    const name = str(t.name, 200);
    idPart = name ?? "";
    result = { kind, ...common, segmentId: "", contentHash: "", name };
  }

  const given = typeof raw.segmentId === "string" || typeof raw.segmentId === "number" ? String(raw.segmentId).trim() : "";
  // Derived id: sha256(kind|startTime|endTime|placeId-or-first-point), on normalized epoch ms so re-formatting can't change it.
  result.segmentId = given
    ? given.slice(0, 200)
    : "d-" + sha(`${kind}|${st.ms}|${en.ms}|${idPart}`).slice(0, 32);
  result.contentHash = sha(JSON.stringify(raw));
  return { ok: true, seg: result };
}

/* ------------------------------------------------------------------ import */

export interface KindStats {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
}

export interface ImportResult {
  status: "imported" | "unchanged" | "failed";
  import_id: number | null;
  sha256: string | null;
  error?: string;
  generator?: string;
  upstream_commit?: string;
  segments_in_export: number;
  valid: number;
  skipped: number;
  duplicates: number;
  errors: Record<string, number>;
  error_samples: { index: number; reason: string }[];
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  by_kind: Record<SegmentKind, KindStats>;
  totals: Record<SegmentKind | "place", number>;
}

const zeroKind = (): KindStats => ({ added: 0, updated: 0, unchanged: 0, removed: 0 });

export function tableCounts(db: Database): Record<SegmentKind | "place", number> {
  const c = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return { place: c("places"), visit: c("visits"), activity: c("activities"), timeline_path: c("timeline_paths"), trip: c("trips") };
}

function emptyResult(status: ImportResult["status"], db: Database): ImportResult {
  return {
    status,
    import_id: null,
    sha256: null,
    segments_in_export: 0,
    valid: 0,
    skipped: 0,
    duplicates: 0,
    errors: {},
    error_samples: [],
    added: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    by_kind: { visit: zeroKind(), activity: zeroKind(), timeline_path: zeroKind(), trip: zeroKind() },
    totals: tableCounts(db),
  };
}

export interface ImportOptions {
  now?: Date;
  /** Re-import even if this exact export was imported before. */
  force?: boolean;
  /** Allow an export with zero valid segments to wipe a non-empty index. */
  allowEmpty?: boolean;
}

export function importExport(db: Database, exp: ExportData, opts: ImportOptions = {}): ImportResult {
  if (!Array.isArray(exp.segments)) throw new ExportFormatError("export must be a JSON object with a semanticSegments array");

  const lastSha = getMeta(db, "last_import_sha256");
  if (!opts.force && lastSha === exp.sha256) {
    const r = emptyResult("unchanged", db);
    r.sha256 = exp.sha256;
    r.import_id = Number(getMeta(db, "last_import_id")) || null;
    r.segments_in_export = exp.segments.length;
    return r;
  }

  // 1. normalise everything outside the transaction (CPU only)
  const errors: Record<string, number> = {};
  const samples: { index: number; reason: string }[] = [];
  const byKind: Record<SegmentKind, Map<string, Norm>> = {
    visit: new Map(),
    activity: new Map(),
    timeline_path: new Map(),
    trip: new Map(),
  };
  let skipped = 0;
  let duplicates = 0;
  exp.segments.forEach((raw, index) => {
    const r = normalizeSegment(raw);
    if (!r.ok) {
      skipped++;
      errors[r.reason] = (errors[r.reason] ?? 0) + 1;
      if (samples.length < 20) samples.push({ index, reason: r.reason });
      return;
    }
    const m = byKind[r.seg.kind];
    if (m.has(r.seg.segmentId)) duplicates++;
    m.set(r.seg.segmentId, r.seg); // last one wins
  });
  const valid = KINDS.reduce((n, k) => n + byKind[k].size, 0);

  const existingTotal = Object.values(tableCounts(db)).reduce((a, b) => a + b, 0);
  if (valid === 0 && existingTotal > 0 && !opts.allowEmpty) {
    throw new ImportRejectedError(
      `export has no valid segments (${exp.segments.length} in file, ${skipped} malformed); refusing to wipe the existing index`,
    );
  }

  // 2. merge place attributes: latest non-null value per field wins (chronological)
  const visits = [...byKind.visit.values()] as NormVisit[];
  visits.sort((a, b) => a.startMs - b.startMs);
  const places = new Map<string, PlaceAttrs>();
  for (const v of visits) {
    if (!v.placeKey || !v.place) continue;
    const cur = places.get(v.placeKey);
    if (!cur) {
      places.set(v.placeKey, { ...v.place });
      continue;
    }
    for (const k of Object.keys(v.place) as (keyof PlaceAttrs)[]) {
      const val = v.place[k];
      if (val !== null) (cur as any)[k] = val;
    }
  }

  const importedAt = (opts.now ?? new Date()).toISOString();
  const meta: ExportMeta = exp.exportMeta ?? {};
  const result = emptyResult("imported", db);
  result.sha256 = exp.sha256;
  result.generator = meta.generator;
  result.upstream_commit = meta.upstreamCommit;
  result.segments_in_export = exp.segments.length;
  result.valid = valid;
  result.skipped = skipped;
  result.duplicates = duplicates;
  result.errors = errors;
  result.error_samples = samples;

  // 3. one transaction: upsert changed, delete vanished, rebuild place aggregates
  transaction(db, () => {
    const ins = db
      .prepare(
        `INSERT INTO imports(sha256, source_path, imported_at, generator, upstream_commit, adapter, export_generated_at, skipped, duplicates, errors_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        exp.sha256,
        exp.sourcePath,
        importedAt,
        meta.generator ?? null,
        meta.upstreamCommit ?? null,
        meta.adapter ?? null,
        meta.generatedAt ?? null,
        skipped,
        duplicates,
        JSON.stringify({ reasons: errors, samples }),
      );
    const importId = Number(ins.lastInsertRowid);
    result.import_id = importId;

    const upsertPlace = db.prepare(
      `INSERT INTO places(place_key, place_id, feature_id, name, address, category, semantic_type, semantic_type_code, place_type_code, lat, lng)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(place_key) DO UPDATE SET place_id=excluded.place_id, feature_id=excluded.feature_id, name=excluded.name,
         address=excluded.address, category=excluded.category, semantic_type=excluded.semantic_type,
         semantic_type_code=excluded.semantic_type_code, place_type_code=excluded.place_type_code, lat=excluded.lat, lng=excluded.lng`,
    );
    for (const [key, p] of places) {
      upsertPlace.run(key, p.placeId, p.featureId, p.name, p.address, p.category, p.semanticType, p.semanticTypeCode, p.placeTypeCode, p.lat, p.lng);
    }

    const stmts: Record<SegmentKind, (s: any) => void> = {
      visit: (() => {
        const st = db.prepare(
          `INSERT INTO visits(segment_id, place_key, start_ms, end_ms, start_offset_min, end_offset_min, start_iso, end_iso, probability,
             candidate_probability, semantic_type, is_confirmed, finalization_status, source, import_id, content_hash)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(segment_id) DO UPDATE SET place_key=excluded.place_key, start_ms=excluded.start_ms, end_ms=excluded.end_ms,
             start_offset_min=excluded.start_offset_min, end_offset_min=excluded.end_offset_min, start_iso=excluded.start_iso,
             end_iso=excluded.end_iso, probability=excluded.probability, candidate_probability=excluded.candidate_probability,
             semantic_type=excluded.semantic_type, is_confirmed=excluded.is_confirmed, finalization_status=excluded.finalization_status,
             source=excluded.source, import_id=excluded.import_id, content_hash=excluded.content_hash`,
        );
        return (s: NormVisit) =>
          void st.run(
            s.segmentId, s.placeKey, s.startMs, s.endMs, s.startOff, s.endOff,
            isoWithOffset(s.startMs, s.startOff), isoWithOffset(s.endMs, s.endOff),
            s.probability, s.candidateProbability, s.semanticType, s.isConfirmed ? 1 : 0, s.finalization, s.source, importId, s.contentHash,
          );
      })(),
      activity: (() => {
        const st = db.prepare(
          `INSERT INTO activities(segment_id, start_ms, end_ms, start_offset_min, end_offset_min, mode, mode_code, mode_probability, distance_m,
             start_lat, start_lng, end_lat, end_lng, finalization_status, source, import_id, content_hash)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(segment_id) DO UPDATE SET start_ms=excluded.start_ms, end_ms=excluded.end_ms, start_offset_min=excluded.start_offset_min,
             end_offset_min=excluded.end_offset_min, mode=excluded.mode, mode_code=excluded.mode_code, mode_probability=excluded.mode_probability,
             distance_m=excluded.distance_m, start_lat=excluded.start_lat, start_lng=excluded.start_lng, end_lat=excluded.end_lat,
             end_lng=excluded.end_lng, finalization_status=excluded.finalization_status, source=excluded.source,
             import_id=excluded.import_id, content_hash=excluded.content_hash`,
        );
        return (s: NormActivity) =>
          void st.run(
            s.segmentId, s.startMs, s.endMs, s.startOff, s.endOff, s.mode, s.modeCode, s.modeProbability, s.distanceM,
            s.start?.lat ?? null, s.start?.lng ?? null, s.end?.lat ?? null, s.end?.lng ?? null,
            s.finalization, s.source, importId, s.contentHash,
          );
      })(),
      timeline_path: (() => {
        const st = db.prepare(
          `INSERT INTO timeline_paths(segment_id, start_ms, end_ms, start_offset_min, end_offset_min, point_count, points_json, import_id, content_hash)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(segment_id) DO UPDATE SET start_ms=excluded.start_ms, end_ms=excluded.end_ms, start_offset_min=excluded.start_offset_min,
             end_offset_min=excluded.end_offset_min, point_count=excluded.point_count, points_json=excluded.points_json,
             import_id=excluded.import_id, content_hash=excluded.content_hash`,
        );
        return (s: NormPath) =>
          void st.run(s.segmentId, s.startMs, s.endMs, s.startOff, s.endOff, s.points.length, JSON.stringify(s.points), importId, s.contentHash);
      })(),
      trip: (() => {
        const st = db.prepare(
          `INSERT INTO trips(segment_id, start_ms, end_ms, start_offset_min, end_offset_min, name, import_id, content_hash)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(segment_id) DO UPDATE SET start_ms=excluded.start_ms, end_ms=excluded.end_ms, start_offset_min=excluded.start_offset_min,
             end_offset_min=excluded.end_offset_min, name=excluded.name, import_id=excluded.import_id, content_hash=excluded.content_hash`,
        );
        return (s: NormTrip) => void st.run(s.segmentId, s.startMs, s.endMs, s.startOff, s.endOff, s.name, importId, s.contentHash);
      })(),
    };

    for (const kind of KINDS) {
      const table = TABLE[kind];
      const stats = result.by_kind[kind];
      const existing = new Map<string, string>();
      for (const r of db.prepare(`SELECT segment_id, content_hash FROM ${table}`).all() as { segment_id: string; content_hash: string }[]) {
        existing.set(r.segment_id, r.content_hash);
      }
      for (const [id, seg] of byKind[kind]) {
        const prev = existing.get(id);
        if (prev === undefined) {
          stmts[kind](seg);
          stats.added++;
        } else if (prev !== seg.contentHash) {
          stmts[kind](seg);
          stats.updated++;
        } else stats.unchanged++;
      }
      const del = db.prepare(`DELETE FROM ${table} WHERE segment_id = ?`);
      for (const id of existing.keys()) {
        if (!byKind[kind].has(id)) {
          del.run(id);
          stats.removed++;
        }
      }
    }

    db.exec(`DELETE FROM places WHERE place_key NOT IN (SELECT DISTINCT place_key FROM visits WHERE place_key IS NOT NULL)`);
    db.exec(`UPDATE places SET
      visit_count = (SELECT COUNT(*) FROM visits v WHERE v.place_key = places.place_key),
      first_seen  = (SELECT MIN(start_ms) FROM visits v WHERE v.place_key = places.place_key),
      last_seen   = (SELECT MAX(end_ms) FROM visits v WHERE v.place_key = places.place_key)`);

    for (const k of KINDS) {
      result.added += result.by_kind[k].added;
      result.updated += result.by_kind[k].updated;
      result.unchanged += result.by_kind[k].unchanged;
      result.removed += result.by_kind[k].removed;
    }
    result.totals = tableCounts(db);
    db.prepare(
      `UPDATE imports SET visit_count=?, activity_count=?, path_count=?, trip_count=?, added=?, updated=?, unchanged=?, removed=? WHERE id=?`,
    ).run(result.totals.visit, result.totals.activity, result.totals.timeline_path, result.totals.trip, result.added, result.updated, result.unchanged, result.removed, importId);
    db.exec(`DELETE FROM imports WHERE id <= (SELECT MAX(id) FROM imports) - 100`);

    setMeta(db, "last_import_sha256", exp.sha256);
    setMeta(db, "last_import_id", String(importId));
    setMeta(db, "last_import_at", importedAt);
    setMeta(db, "last_import_path", exp.sourcePath);
    setMetaJson(db, "last_import_meta", meta);
    setMetaJson(db, "last_import_counts", result.totals);
    setMeta(db, "last_import_error", null);
  });

  return result;
}

/* ------------------------------------------------------------------ index manager (auto reindex) */

export interface IndexCheck {
  status: "skipped" | "no_export" | "unchanged" | "imported" | "failed";
  result?: ImportResult;
  error?: string;
}

export interface IndexManagerOptions {
  db: Database;
  source: HistoricalLocationSource;
  logger: Logger;
  /** Minimum time between filesystem checks (default 60 s). */
  checkIntervalMs?: number;
  now?: () => number;
}

/** Sanitise an error message before storing/returning it (no paths, tokens, coordinates). */
export function sanitizeMessage(msg: string, max = 300): string {
  return redactString(String(msg))
    .replace(/[A-Za-z]:\\[^\s"']+/g, "[path]")
    .replace(/\/(?:[\w.-]+\/){2,}[\w.-]+/g, "[path]")
    .replace(/[\u0000-\u001f]/g, " ")
    .slice(0, max);
}

/**
 * Keeps the index fresh: on start, and at most once per `checkIntervalMs` on request, stat the export;
 * re-import only when its mtime/size changed (and only if the content hash differs).
 * The giant JSON is never parsed per request.
 */
export class IndexManager {
  private lastCheck = 0;
  private inflight: Promise<IndexCheck> | null = null;
  private readonly interval: number;
  private readonly now: () => number;

  constructor(private readonly o: IndexManagerOptions) {
    this.interval = o.checkIntervalMs ?? 60_000;
    this.now = o.now ?? Date.now;
  }

  /** Throttled check. `force` bypasses the throttle. Never throws. */
  ensureFresh(opts: { force?: boolean } = {}): Promise<IndexCheck> {
    if (this.inflight) return this.inflight;
    if (!opts.force && this.lastCheck && this.now() - this.lastCheck < this.interval) {
      return Promise.resolve({ status: "skipped" });
    }
    this.lastCheck = this.now();
    this.inflight = this.run(false).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Explicit (re)index, used by the CLI. `force` re-imports an already-imported export. */
  async reindex(opts: { force?: boolean; allowEmpty?: boolean } = {}): Promise<IndexCheck> {
    if (this.inflight) await this.inflight.catch(() => {});
    this.lastCheck = this.now();
    return this.run(true, opts);
  }

  private async refreshSyncStatus(): Promise<void> {
    try {
      const s = await this.o.source.readSyncStatus();
      setMetaJson(this.o.db, "sync_status", s);
      setMeta(this.o.db, "sync_status_read_at", new Date(this.now()).toISOString());
    } catch (e) {
      this.o.logger.warn("index.sync_status_failed", { error: sanitizeMessage((e as Error).message) });
    }
  }

  private async run(explicit: boolean, opts: { force?: boolean; allowEmpty?: boolean } = {}): Promise<IndexCheck> {
    const { db, source, logger } = this.o;
    await this.refreshSyncStatus();
    let fp: string | null;
    try {
      fp = await source.fingerprint();
    } catch {
      fp = null;
    }
    if (fp === null) {
      if (explicit) {
        // let readExport produce the precise error
      } else return { status: "no_export" };
    }
    if (!explicit && fp === getMeta(db, "export_fingerprint")) return { status: "unchanged" };

    try {
      const exp = await source.readExport();
      const result = importExport(db, exp, { force: opts.force, allowEmpty: opts.allowEmpty, now: new Date(this.now()) });
      if (fp) setMeta(db, "export_fingerprint", fp);
      if (result.status === "imported") {
        logger.info("index.imported", {
          import_id: result.import_id,
          added: result.added,
          updated: result.updated,
          removed: result.removed,
          skipped: result.skipped,
          visits: result.totals.visit,
        });
      }
      return { status: result.status === "unchanged" ? "unchanged" : "imported", result };
    } catch (e) {
      const message = sanitizeMessage((e as Error).message);
      const permanent = e instanceof ExportFormatError || e instanceof ImportRejectedError;
      // Remember the bad file's fingerprint so we do not re-parse it every minute; the old index stays intact.
      if (permanent && fp) setMeta(db, "export_fingerprint", fp);
      setMetaJson(db, "last_import_error", { at: new Date(this.now()).toISOString(), message });
      if (!(e instanceof ExportMissingError) || explicit) logger.warn("index.failed", { error: message });
      return { status: "failed", error: message };
    }
  }
}

