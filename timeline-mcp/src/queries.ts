/**
 * Pure read-only query layer over the index database. No coordinates are filtered here —
 * precision is applied exclusively in present.ts so there is a single place that can leak them.
 */
import { formatDateInZone, dayBounds, haversineMeters } from "@location/shared";
import type { Database } from "./db.ts";

/* ------------------------------------------------------------------ row types */

export interface PlaceRow {
  place_key: string;
  place_id: string | null;
  feature_id: string | null;
  name: string | null;
  address: string | null;
  category: string | null;
  semantic_type: string | null;
  semantic_type_code: number | null;
  place_type_code: number | null;
  lat: number | null;
  lng: number | null;
  first_seen: number | null;
  last_seen: number | null;
  visit_count: number;
}

export interface VisitRow {
  segment_id: string;
  place_key: string | null;
  start_ms: number;
  end_ms: number;
  start_offset_min: number;
  end_offset_min: number;
  probability: number | null;
  candidate_probability: number | null;
  semantic_type: string | null;
  is_confirmed: number;
  finalization_status: number | null;
  import_id: number | null;
  p_place_id: string | null;
  p_name: string | null;
  p_address: string | null;
  p_category: string | null;
  p_semantic_type: string | null;
  p_lat: number | null;
  p_lng: number | null;
}

export interface ActivityRow {
  segment_id: string;
  start_ms: number;
  end_ms: number;
  start_offset_min: number;
  end_offset_min: number;
  mode: string | null;
  mode_code: number | null;
  mode_probability: number | null;
  distance_m: number | null;
  start_lat: number | null;
  start_lng: number | null;
  end_lat: number | null;
  end_lng: number | null;
}

export interface PathRow {
  segment_id: string;
  start_ms: number;
  end_ms: number;
  start_offset_min: number;
  end_offset_min: number;
  point_count: number;
  points_json: string;
}

export interface TripRow {
  segment_id: string;
  start_ms: number;
  end_ms: number;
  start_offset_min: number;
  end_offset_min: number;
  name: string | null;
}

export interface PathPoint {
  /** absolute epoch ms, or null when the source gave no per-point offset */
  ms: number | null;
  lat: number;
  lng: number;
}

const VISIT_SELECT = `SELECT v.segment_id, v.place_key, v.start_ms, v.end_ms, v.start_offset_min, v.end_offset_min, v.probability,
  v.candidate_probability, v.semantic_type, v.is_confirmed, v.finalization_status, v.import_id,
  p.place_id AS p_place_id, p.name AS p_name, p.address AS p_address, p.category AS p_category,
  p.semantic_type AS p_semantic_type, p.lat AS p_lat, p.lng AS p_lng
  FROM visits v LEFT JOIN places p ON p.place_key = v.place_key`;

const ACTIVITY_SELECT = `SELECT segment_id, start_ms, end_ms, start_offset_min, end_offset_min, mode, mode_code, mode_probability,
  distance_m, start_lat, start_lng, end_lat, end_lng FROM activities`;

const TRIP_SELECT = `SELECT segment_id, start_ms, end_ms, start_offset_min, end_offset_min, name FROM trips`;

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}
const like = (s: string) => `%${escapeLike(s)}%`;

type Param = string | number | null;

function count(db: Database, sql: string, params: Param[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

/* ------------------------------------------------------------------ visits */

export interface VisitQuery {
  startMs?: number;
  endMs?: number;
  placeKeys?: string[];
  semanticType?: string;
  limit: number;
  order?: "asc" | "desc";
}

/** Visits overlapping [startMs, endMs). */
export function queryVisits(db: Database, q: VisitQuery): { rows: VisitRow[]; total: number } {
  const where: string[] = [];
  const params: Param[] = [];
  if (q.endMs !== undefined) {
    where.push("v.start_ms < ?");
    params.push(q.endMs);
  }
  if (q.startMs !== undefined) {
    where.push("v.end_ms > ?");
    params.push(q.startMs);
  }
  if (q.placeKeys) {
    if (q.placeKeys.length === 0) return { rows: [], total: 0 };
    where.push(`v.place_key IN (${q.placeKeys.map(() => "?").join(",")})`);
    params.push(...q.placeKeys);
  }
  if (q.semanticType) {
    where.push("upper(v.semantic_type) = upper(?)");
    params.push(q.semanticType);
  }
  const w = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const dir = q.order === "desc" ? "DESC" : "ASC";
  const rows = db.prepare(`${VISIT_SELECT}${w} ORDER BY v.start_ms ${dir}, v.segment_id LIMIT ?`).all(...params, q.limit) as unknown as VisitRow[];
  const total = count(db, `SELECT COUNT(*) AS n FROM visits v${w}`, params);
  return { rows, total };
}

export function visitContaining(db: Database, t: number): VisitRow | null {
  return (
    (db
      .prepare(`${VISIT_SELECT} WHERE v.start_ms <= ? AND v.end_ms >= ? ORDER BY v.start_ms DESC, v.segment_id LIMIT 1`)
      .get(t, t) as unknown as VisitRow | undefined) ?? null
  );
}

export function visitBefore(db: Database, t: number): VisitRow | null {
  return (
    (db.prepare(`${VISIT_SELECT} WHERE v.end_ms < ? ORDER BY v.end_ms DESC, v.segment_id LIMIT 1`).get(t) as unknown as VisitRow | undefined) ?? null
  );
}
export function visitAfter(db: Database, t: number): VisitRow | null {
  return (
    (db.prepare(`${VISIT_SELECT} WHERE v.start_ms > ? ORDER BY v.start_ms ASC, v.segment_id LIMIT 1`).get(t) as unknown as VisitRow | undefined) ?? null
  );
}

/* ------------------------------------------------------------------ activities */

export interface ActivityQuery {
  startMs: number;
  endMs: number;
  mode?: string;
  limit: number;
}

/** Activities overlapping [startMs, endMs). */
export function queryActivities(db: Database, q: ActivityQuery): { rows: ActivityRow[]; total: number } {
  const where = ["start_ms < ?", "end_ms > ?"];
  const params: Param[] = [q.endMs, q.startMs];
  if (q.mode) {
    where.push("lower(mode) LIKE lower(?) ESCAPE '\\'");
    params.push(like(q.mode));
  }
  const w = ` WHERE ${where.join(" AND ")}`;
  const rows = db.prepare(`${ACTIVITY_SELECT}${w} ORDER BY start_ms ASC, segment_id LIMIT ?`).all(...params, q.limit) as unknown as ActivityRow[];
  return { rows, total: count(db, `SELECT COUNT(*) AS n FROM activities${w}`, params) };
}

export function activityContaining(db: Database, t: number): ActivityRow | null {
  return (
    (db.prepare(`${ACTIVITY_SELECT} WHERE start_ms <= ? AND end_ms >= ? ORDER BY start_ms DESC, segment_id LIMIT 1`).get(t, t) as unknown as
      | ActivityRow
      | undefined) ?? null
  );
}
export function activityBefore(db: Database, t: number): ActivityRow | null {
  return (
    (db.prepare(`${ACTIVITY_SELECT} WHERE end_ms < ? ORDER BY end_ms DESC, segment_id LIMIT 1`).get(t) as unknown as ActivityRow | undefined) ?? null
  );
}
export function activityAfter(db: Database, t: number): ActivityRow | null {
  return (
    (db.prepare(`${ACTIVITY_SELECT} WHERE start_ms > ? ORDER BY start_ms ASC, segment_id LIMIT 1`).get(t) as unknown as ActivityRow | undefined) ??
    null
  );
}

/** Activities that START in [startMs, endMs) — used for distance attribution (no double counting). */
export function activitiesStartingIn(db: Database, startMs: number, endMs: number, cap = 200_000): ActivityRow[] {
  return db
    .prepare(`${ACTIVITY_SELECT} WHERE start_ms >= ? AND start_ms < ? ORDER BY start_ms ASC LIMIT ?`)
    .all(startMs, endMs, cap) as unknown as ActivityRow[];
}

/* ------------------------------------------------------------------ paths */

export function pathsNear(db: Database, fromMs: number, toMs: number, cap = 200): PathRow[] {
  return db
    .prepare(
      `SELECT segment_id, start_ms, end_ms, start_offset_min, end_offset_min, point_count, points_json FROM timeline_paths
       WHERE start_ms <= ? AND end_ms >= ? ORDER BY start_ms ASC LIMIT ?`,
    )
    .all(toMs, fromMs, cap) as unknown as PathRow[];
}

export function pathPointCount(db: Database, startMs: number, endMs: number): number {
  return count(db, "SELECT COALESCE(SUM(point_count),0) AS n FROM timeline_paths WHERE start_ms < ? AND end_ms > ?", [endMs, startMs]);
}

export function decodePoints(row: PathRow): PathPoint[] {
  let arr: unknown;
  try {
    arr = JSON.parse(row.points_json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: PathPoint[] = [];
  for (const p of arr as unknown[]) {
    if (!Array.isArray(p) || typeof p[0] !== "number" || typeof p[1] !== "number") continue;
    out.push({ ms: typeof p[2] === "number" ? row.start_ms + p[2] * 60_000 : null, lat: p[0], lng: p[1] });
  }
  return out;
}

/* ------------------------------------------------------------------ trips */

export function queryTrips(db: Database, q: { startMs?: number; endMs?: number; limit: number }): { rows: TripRow[]; total: number } {
  const where: string[] = [];
  const params: Param[] = [];
  if (q.endMs !== undefined) {
    where.push("start_ms < ?");
    params.push(q.endMs);
  }
  if (q.startMs !== undefined) {
    where.push("end_ms > ?");
    params.push(q.startMs);
  }
  const w = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  return {
    rows: db.prepare(`${TRIP_SELECT}${w} ORDER BY start_ms ASC, segment_id LIMIT ?`).all(...params, q.limit) as unknown as TripRow[],
    total: count(db, `SELECT COUNT(*) AS n FROM trips${w}`, params),
  };
}

/* ------------------------------------------------------------------ places */

export interface PlaceWithStats extends PlaceRow {
  total_ms: number;
}

export function searchPlaces(
  db: Database,
  q: { query?: string; semanticType?: string; limit: number; matchAddress: boolean },
): { rows: PlaceWithStats[]; total: number } {
  const where: string[] = [];
  const params: Param[] = [];
  if (q.query) {
    const cols = ["p.name", "p.place_id", "p.feature_id", "p.place_key", "p.category"];
    if (q.matchAddress) cols.push("p.address");
    where.push("(" + cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(" OR ") + ")");
    for (let i = 0; i < cols.length; i++) params.push(like(q.query));
  }
  if (q.semanticType) {
    where.push("upper(p.semantic_type) = upper(?)");
    params.push(q.semanticType);
  }
  const w = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT p.*, (SELECT COALESCE(SUM(v.end_ms - v.start_ms),0) FROM visits v WHERE v.place_key = p.place_key) AS total_ms
       FROM places p${w} ORDER BY total_ms DESC, p.visit_count DESC, p.place_key LIMIT ?`,
    )
    .all(...params, q.limit) as unknown as PlaceWithStats[];
  return { rows, total: count(db, `SELECT COUNT(*) AS n FROM places p${w}`, params) };
}

/** Places within radiusM of a point, nearest first (bounding-box prefilter, then haversine). */
export function placesNear(db: Database, lat: number, lng: number, radiusM: number, cap = 2000): { place: PlaceWithStats; distance_m: number }[] {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  const rows = db
    .prepare(
      `SELECT p.*, (SELECT COALESCE(SUM(v.end_ms - v.start_ms),0) FROM visits v WHERE v.place_key = p.place_key) AS total_ms
       FROM places p
       WHERE p.lat BETWEEN ? AND ? AND p.lng BETWEEN ? AND ?
       LIMIT ?`,
    )
    .all(lat - dLat, lat + dLat, lng - dLng, lng + dLng, cap * 4) as unknown as PlaceWithStats[];
  return rows
    .map((p) => ({ place: p, distance_m: haversineMeters({ lat, lng }, { lat: p.lat as number, lng: p.lng as number }) }))
    .filter((x) => x.distance_m <= radiusM)
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, cap);
}

export interface ResolvedPlaces {
  matchType: "key" | "name_exact" | "name_partial" | "none";
  places: PlaceRow[];
  truncated: boolean;
}

const RESOLVE_CAP = 50;

/** Resolve a place reference: place_key / placeId / featureId, else exact name, else name substring. */
export function resolvePlaces(db: Database, ref: string): ResolvedPlaces {
  const r = ref.trim();
  if (!r) return { matchType: "none", places: [], truncated: false };
  const byKey = db
    .prepare("SELECT * FROM places WHERE place_key = ? OR place_id = ? OR feature_id = ? LIMIT ?")
    .all(r, r, r, RESOLVE_CAP) as unknown as PlaceRow[];
  if (byKey.length) return { matchType: "key", places: byKey, truncated: false };
  const exact = db
    .prepare("SELECT * FROM places WHERE lower(name) = lower(?) ORDER BY visit_count DESC LIMIT ?")
    .all(r, RESOLVE_CAP + 1) as unknown as PlaceRow[];
  if (exact.length) return { matchType: "name_exact", places: exact.slice(0, RESOLVE_CAP), truncated: exact.length > RESOLVE_CAP };
  const part = db
    .prepare("SELECT * FROM places WHERE name LIKE ? ESCAPE '\\' ORDER BY visit_count DESC LIMIT ?")
    .all(like(r), RESOLVE_CAP + 1) as unknown as PlaceRow[];
  if (part.length) return { matchType: "name_partial", places: part.slice(0, RESOLVE_CAP), truncated: part.length > RESOLVE_CAP };
  return { matchType: "none", places: [], truncated: false };
}

/** Compact visit intervals for a set of places overlapping the range (for time-at-place math). */
export function placeVisitIntervals(
  db: Database,
  keys: string[],
  startMs?: number,
  endMs?: number,
  cap = 100_000,
): { start_ms: number; end_ms: number; place_key: string }[] {
  if (!keys.length) return [];
  const where = [`place_key IN (${keys.map(() => "?").join(",")})`];
  const params: Param[] = [...keys];
  if (endMs !== undefined) {
    where.push("start_ms < ?");
    params.push(endMs);
  }
  if (startMs !== undefined) {
    where.push("end_ms > ?");
    params.push(startMs);
  }
  return db
    .prepare(`SELECT start_ms, end_ms, place_key FROM visits WHERE ${where.join(" AND ")} ORDER BY start_ms LIMIT ?`)
    .all(...params, cap) as unknown as { start_ms: number; end_ms: number; place_key: string }[];
}

/* ------------------------------------------------------------------ status / coverage */

export interface Coverage {
  oldest_ms: number | null;
  oldest_offset_min: number;
  newest_ms: number | null;
  newest_offset_min: number;
  newest_kind: string | null;
}

export function coverage(db: Database): Coverage {
  const oldest = db
    .prepare(
      `SELECT start_ms, start_offset_min FROM (
         SELECT start_ms, start_offset_min FROM visits UNION ALL SELECT start_ms, start_offset_min FROM activities
         UNION ALL SELECT start_ms, start_offset_min FROM timeline_paths UNION ALL SELECT start_ms, start_offset_min FROM trips)
       ORDER BY start_ms ASC LIMIT 1`,
    )
    .get() as { start_ms: number; start_offset_min: number } | undefined;
  const newest = db
    .prepare(
      `SELECT kind, end_ms, end_offset_min FROM (
         SELECT 'visit' AS kind, end_ms, end_offset_min FROM visits UNION ALL SELECT 'activity', end_ms, end_offset_min FROM activities
         UNION ALL SELECT 'timeline_path', end_ms, end_offset_min FROM timeline_paths UNION ALL SELECT 'trip', end_ms, end_offset_min FROM trips)
       ORDER BY end_ms DESC LIMIT 1`,
    )
    .get() as { kind: string; end_ms: number; end_offset_min: number } | undefined;
  return {
    oldest_ms: oldest?.start_ms ?? null,
    oldest_offset_min: oldest?.start_offset_min ?? 0,
    newest_ms: newest?.end_ms ?? null,
    newest_offset_min: newest?.end_offset_min ?? 0,
    newest_kind: newest?.kind ?? null,
  };
}

/** Newest end among visits + activities only (the "real" data horizon; paths/trips can span ahead). */
export function dataHorizon(db: Database): { oldest: number | null; newest: number | null } {
  const r = db
    .prepare(
      `SELECT MIN(s) AS oldest, MAX(e) AS newest FROM (
         SELECT start_ms AS s, end_ms AS e FROM visits UNION ALL SELECT start_ms, end_ms FROM activities)`,
    )
    .get() as { oldest: number | null; newest: number | null };
  return r;
}

/* ------------------------------------------------------------------ day calendar (timezone aware, cached) */

export class DayCalendar {
  private bounds = new Map<string, { start: number; end: number }>();
  constructor(readonly tz: string) {}

  dayOf(ms: number): string {
    return formatDateInZone(ms, this.tz);
  }
  boundsOf(day: string): { start: number; end: number } {
    let b = this.bounds.get(day);
    if (!b) {
      b = dayBounds(day, this.tz);
      this.bounds.set(day, b);
    }
    return b;
  }
  /** Split [startMs, endMs) into per-calendar-day pieces (milliseconds in each day). */
  split(startMs: number, endMs: number, maxDays = 1000): { day: string; ms: number }[] {
    const out: { day: string; ms: number }[] = [];
    let cur = startMs;
    for (let i = 0; i < maxDays && cur < endMs; i++) {
      const day = this.dayOf(cur);
      const b = this.boundsOf(day);
      const to = Math.min(endMs, b.end);
      if (to <= cur) break; // defensive: never loop forever on odd zone data
      out.push({ day, ms: to - cur });
      cur = to;
    }
    return out;
  }
}
