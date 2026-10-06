/**
 * Higher-level, still read-only computations over the index: where_was_i, distance rollups,
 * time-at-place, trip statistics and day/week summaries. Output is fully presented
 * (precision applied) so tools.ts stays thin.
 */
import { applyPrecision, haversineMeters, humanDuration, isoInZone, type Precision } from "@location/shared";
import type { Database } from "./db.ts";
import { activityItem, iso, pointItem, placeFromVisit, placeObject, tripItem, visitItem } from "./present.ts";
import {
  DayCalendar,
  activitiesStartingIn,
  activityAfter,
  activityBefore,
  activityContaining,
  dataHorizon,
  decodePoints,
  pathsNear,
  queryActivities,
  queryTrips,
  queryVisits,
  visitAfter,
  visitBefore,
  visitContaining,
  pathPointCount,
  placeVisitIntervals,
  type ActivityRow,
  type PathPoint,
  type VisitRow,
} from "./queries.ts";

const MIN_GAP_SECONDS = 600;
const DAY_ROW_CAP = 2000;

/* ------------------------------------------------------------------ where_was_i */

export function whereWasI(
  db: Database,
  o: { t: number; toleranceMs: number; precision: Precision; tz: string },
): Record<string, unknown> {
  const { t, toleranceMs, precision, tz } = o;
  const out: Record<string, unknown> = {
    timestamp: isoInZone(t, tz),
    timezone: tz,
    tolerance_minutes: Math.round(toleranceMs / 60000),
  };
  const horizon = dataHorizon(db);
  const notes: string[] = [];
  if (horizon.newest !== null && t > horizon.newest) {
    notes.push("Timestamp is after the newest indexed record. Google Timeline is not real-time: the phone backs up hours to a day late.");
  }
  if (horizon.oldest !== null && t < horizon.oldest) notes.push("Timestamp is before the oldest indexed record.");
  if (notes.length) out.notes = notes;

  // 1. containing visit, 2. containing activity
  const v = visitContaining(db, t);
  if (v) return { ...out, match: "exact", item: visitItem(v, precision) };
  const a = activityContaining(db, t);
  if (a) return { ...out, match: "exact", item: activityItem(a, precision) };

  // 3. nearest visit/activity within tolerance
  type Cand = { gap: number; relation: "before" | "after"; visit?: VisitRow; activity?: ActivityRow };
  const cands: Cand[] = [];
  const vb = visitBefore(db, t);
  if (vb) cands.push({ gap: t - vb.end_ms, relation: "before", visit: vb });
  const va = visitAfter(db, t);
  if (va) cands.push({ gap: va.start_ms - t, relation: "after", visit: va });
  const ab = activityBefore(db, t);
  if (ab) cands.push({ gap: t - ab.end_ms, relation: "before", activity: ab });
  const aa = activityAfter(db, t);
  if (aa) cands.push({ gap: aa.start_ms - t, relation: "after", activity: aa });
  const near = cands.filter((c) => c.gap <= toleranceMs).sort((x, y) => x.gap - y.gap || (x.visit ? -1 : 1))[0];
  if (near) {
    return {
      ...out,
      match: "nearest",
      gap_seconds: Math.round(near.gap / 1000),
      relation: near.relation === "before" ? "item_ended_before_timestamp" : "item_starts_after_timestamp",
      item: near.visit ? visitItem(near.visit, precision) : activityItem(near.activity!, precision),
    };
  }

  // 4. path-point interpolation (estimate)
  const rows = pathsNear(db, t - toleranceMs, t + toleranceMs);
  const pts: { p: PathPoint & { ms: number }; off: number }[] = [];
  for (const r of rows) {
    for (const p of decodePoints(r)) if (p.ms !== null) pts.push({ p: p as PathPoint & { ms: number }, off: r.start_offset_min });
  }
  let prev: (typeof pts)[number] | undefined;
  let next: (typeof pts)[number] | undefined;
  for (const x of pts) {
    if (x.p.ms <= t && (!prev || x.p.ms > prev.p.ms)) prev = x;
    if (x.p.ms >= t && (!next || x.p.ms < next.p.ms)) next = x;
  }
  if (prev && t - prev.p.ms > toleranceMs) prev = undefined;
  if (next && next.p.ms - t > toleranceMs) next = undefined;
  if (prev || next) {
    let lat: number;
    let lng: number;
    let method: string;
    let gap: number;
    if (prev && next && next.p.ms > prev.p.ms) {
      const f = (t - prev.p.ms) / (next.p.ms - prev.p.ms);
      lat = prev.p.lat + (next.p.lat - prev.p.lat) * f;
      lng = prev.p.lng + (next.p.lng - prev.p.lng) * f;
      method = "path_interpolation";
      gap = Math.min(t - prev.p.ms, next.p.ms - t);
    } else {
      const only = (prev ?? next)!;
      lat = only.p.lat;
      lng = only.p.lng;
      method = "nearest_path_point";
      gap = Math.abs(only.p.ms - t);
    }
    const first = (prev ?? next)!;
    const last = (next ?? prev)!;
    const item: Record<string, unknown> = {
      kind: "timeline_path",
      estimated: true,
      method,
      start_time: iso(first.p.ms, first.off),
      end_time: iso(last.p.ms, last.off),
      confidence: null,
      ...(applyPrecision(lat, lng, precision) as Record<string, unknown>),
    };
    if (precision === "semantic") item.coordinates_withheld = "precision is semantic; request approximate or exact for an estimated position";
    return { ...out, match: "estimate", estimate: true, gap_seconds: Math.round(gap / 1000), item };
  }

  return {
    ...out,
    match: "none",
    item: null,
    reason: "no visit, activity or path point within the tolerance window",
  };
}

/* ------------------------------------------------------------------ distance */

export interface DistanceGroup {
  key: string;
  activity_count: number;
  duration_seconds: number;
  source_meters: number;
  source_activity_count: number;
  estimated_meters: number;
  estimated_activity_count: number;
  unmeasured_activity_count: number;
  method: "haversine_estimate" | null;
}

const newGroup = (key: string): DistanceGroup => ({
  key,
  activity_count: 0,
  duration_seconds: 0,
  source_meters: 0,
  source_activity_count: 0,
  estimated_meters: 0,
  estimated_activity_count: 0,
  unmeasured_activity_count: 0,
  method: null,
});

function tidy(g: DistanceGroup): DistanceGroup {
  g.source_meters = Math.round(g.source_meters * 10) / 10;
  g.estimated_meters = Math.round(g.estimated_meters);
  g.duration_seconds = Math.round(g.duration_seconds);
  g.method = g.estimated_activity_count > 0 ? "haversine_estimate" : null;
  return g;
}

/**
 * Sum Google's own `distanceMeters` and, only where it is missing but both end points exist, a straight-line
 * haversine estimate. The two are always kept in separate fields — never added together.
 */
export function aggregateDistance(rows: ActivityRow[], groupBy: "mode" | "day" | "none", cal: DayCalendar) {
  const total = newGroup("all");
  const groups = new Map<string, DistanceGroup>();
  for (const r of rows) {
    const key = groupBy === "mode" ? r.mode ?? "unknown" : groupBy === "day" ? cal.dayOf(r.start_ms) : "all";
    let g = groups.get(key);
    if (!g) groups.set(key, (g = newGroup(key)));
    for (const t of groupBy === "none" ? [g] : [g, total]) {
      t.activity_count++;
      t.duration_seconds += Math.max(0, (r.end_ms - r.start_ms) / 1000);
      if (r.distance_m !== null) {
        t.source_meters += r.distance_m;
        t.source_activity_count++;
      } else if (r.start_lat !== null && r.start_lng !== null && r.end_lat !== null && r.end_lng !== null) {
        t.estimated_meters += haversineMeters({ lat: r.start_lat, lng: r.start_lng }, { lat: r.end_lat, lng: r.end_lng });
        t.estimated_activity_count++;
      } else t.unmeasured_activity_count++;
    }
  }
  let list = [...groups.values()].map(tidy);
  if (groupBy === "day") list.sort((a, b) => a.key.localeCompare(b.key));
  else if (groupBy === "mode") list.sort((a, b) => b.source_meters + b.estimated_meters - (a.source_meters + a.estimated_meters));
  const totals = tidy(groupBy === "none" ? (list[0] ?? newGroup("all")) : total);
  const { key: _k, ...totalsOut } = totals;
  return { totals: totalsOut, groups: groupBy === "none" ? [] : list.map(({ ...g }) => g) };
}

export function distanceTraveled(
  db: Database,
  o: { startMs: number; endMs: number; groupBy: "mode" | "day" | "none"; tz: string },
) {
  const rows = activitiesStartingIn(db, o.startMs, o.endMs);
  const cal = new DayCalendar(o.tz);
  const agg = aggregateDistance(rows, o.groupBy, cal);
  const groups = agg.groups.map((g) => {
    const { key, ...rest } = g;
    return o.groupBy === "mode" ? { mode: key, ...rest } : { day: key, ...rest };
  });
  return { totals: agg.totals, groups, activities_considered: rows.length };
}

/* ------------------------------------------------------------------ time at place */

export function mergeIntervals(iv: [number, number][]): [number, number][] {
  const s = [...iv].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function timeAtPlaces(
  db: Database,
  o: { keys: string[]; startMs?: number; endMs?: number; tz: string; maxDays?: number },
) {
  const raw = placeVisitIntervals(db, o.keys, o.startMs, o.endMs);
  const clipped: [number, number][] = [];
  let visitCount = 0;
  for (const r of raw) {
    const a = Math.max(r.start_ms, o.startMs ?? -Infinity);
    const b = Math.min(r.end_ms, o.endMs ?? Infinity);
    if (b > a || (b === a && r.start_ms === r.end_ms)) {
      visitCount++;
      if (b > a) clipped.push([a, b]);
    }
  }
  const merged = mergeIntervals(clipped);
  const cal = new DayCalendar(o.tz);
  const perDay = new Map<string, number>();
  let totalMs = 0;
  for (const [a, b] of merged) {
    totalMs += b - a;
    for (const piece of cal.split(a, b)) perDay.set(piece.day, (perDay.get(piece.day) ?? 0) + piece.ms);
  }
  const days = [...perDay.entries()].sort((x, y) => x[0].localeCompare(y[0]));
  const maxDays = o.maxDays ?? 366;
  const kept = days.length > maxDays ? days.slice(days.length - maxDays) : days;
  return {
    total_seconds: Math.round(totalMs / 1000),
    total_duration: humanDuration(Math.round(totalMs / 1000)),
    visit_count: visitCount,
    days_with_presence: days.length,
    per_day: kept.map(([date, ms]) => ({ date, seconds: Math.round(ms / 1000) })),
    per_day_truncated: days.length > maxDays,
    rows_truncated: raw.length >= 100_000,
  };
}

/* ------------------------------------------------------------------ trips */

export function tripStats(db: Database, trip: { start_ms: number; end_ms: number }, precision: Precision = "semantic") {
  const cnt = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE start_ms < ? AND end_ms > ?`).get(trip.end_ms, trip.start_ms) as { n: number }).n;
  const acts = activitiesStartingIn(db, trip.start_ms, trip.end_ms);
  const dist = aggregateDistance(acts, "mode", new DayCalendar("UTC"));
  const top = db
    .prepare(
      `SELECT v.place_key, p.place_id, p.name, p.address, p.semantic_type, p.category, p.lat, p.lng, COUNT(*) AS visits,
              SUM(MIN(v.end_ms, ?) - MAX(v.start_ms, ?)) AS ms
       FROM visits v LEFT JOIN places p ON p.place_key = v.place_key
       WHERE v.start_ms < ? AND v.end_ms > ? AND v.place_key IS NOT NULL
       GROUP BY v.place_key ORDER BY ms DESC LIMIT 5`,
    )
    .all(trip.end_ms, trip.start_ms, trip.end_ms, trip.start_ms) as {
    place_key: string;
    place_id: string | null;
    name: string | null;
    address: string | null;
    semantic_type: string | null;
    category: string | null;
    lat: number | null;
    lng: number | null;
    visits: number;
    ms: number;
  }[];
  return {
    visit_count: cnt("visits"),
    activity_count: cnt("activities"),
    distance_by_mode: dist.groups.map((g) => ({
      mode: g.key,
      source_meters: g.source_meters,
      activity_count: g.activity_count,
    })),
    source_distance_meters: dist.totals.source_meters,
    top_places: top.map((t) => ({
      ...placeObject(
        { place_key: t.place_key, place_id: t.place_id, name: t.name, address: t.address, category: t.category,
          semantic_type: t.semantic_type, lat: t.lat, lng: t.lng },
        precision,
      ),
      visits: t.visits,
      total_seconds: Math.round(t.ms / 1000),
    })),
  };
}

/* ------------------------------------------------------------------ day / week summaries */

interface DayBrief {
  place_key: string | null;
  name: string | null;
  semantic_type: string | null;
  since: string;
  until: string;
}

export interface DayData {
  date: string;
  start: number;
  end: number;
  visits: VisitRow[];
  activities: ActivityRow[];
  truncated: boolean;
  placeTotals: Map<string, { p: VisitRow; visits: number; ms: number; first: number }>;
  covered_ms: number;
  gaps: { start: number; end: number }[];
  unknown_ms: number;
  movement: ReturnType<typeof aggregateDistance>;
  flags: string[];
  coverage: Record<string, unknown>;
}

const placeIdOf = (v: VisitRow) => v.place_key ?? "unknown";

export function loadDay(db: Database, date: string, cal: DayCalendar): DayData {
  const b = cal.boundsOf(date);
  const v = queryVisits(db, { startMs: b.start, endMs: b.end, limit: DAY_ROW_CAP });
  const a = queryActivities(db, { startMs: b.start, endMs: b.end, limit: DAY_ROW_CAP });
  const truncated = v.total > v.rows.length || a.total > a.rows.length;

  const placeTotals: DayData["placeTotals"] = new Map();
  const intervals: [number, number][] = [];
  for (const r of v.rows) {
    const cs = Math.max(r.start_ms, b.start);
    const ce = Math.min(r.end_ms, b.end);
    if (ce > cs) intervals.push([cs, ce]);
    const key = placeIdOf(r);
    const cur = placeTotals.get(key) ?? { p: r, visits: 0, ms: 0, first: cs };
    cur.visits++;
    cur.ms += Math.max(0, ce - cs);
    cur.first = Math.min(cur.first, cs);
    placeTotals.set(key, cur);
  }
  for (const r of a.rows) {
    const cs = Math.max(r.start_ms, b.start);
    const ce = Math.min(r.end_ms, b.end);
    if (ce > cs) intervals.push([cs, ce]);
  }
  const merged = mergeIntervals(intervals);
  const horizon = dataHorizon(db);
  const gaps: { start: number; end: number }[] = [];
  let covered = 0;
  let unknown = 0;
  const flags: string[] = [];
  const hasAny = horizon.newest !== null;
  const winStart = hasAny ? Math.max(b.start, horizon.oldest!) : b.start;
  const winEnd = hasAny ? Math.min(b.end, horizon.newest!) : b.start;
  if (winEnd > winStart) {
    let cursor = winStart;
    for (const [s, e] of merged) {
      const cs = Math.max(s, winStart);
      const ce = Math.min(e, winEnd);
      if (ce <= cs) continue;
      if (cs > cursor) {
        unknown += cs - cursor;
        if ((cs - cursor) / 1000 >= MIN_GAP_SECONDS) gaps.push({ start: cursor, end: cs });
      }
      covered += ce - cs;
      cursor = Math.max(cursor, ce);
    }
    if (winEnd > cursor) {
      unknown += winEnd - cursor;
      if ((winEnd - cursor) / 1000 >= MIN_GAP_SECONDS) gaps.push({ start: cursor, end: winEnd });
    }
  }

  const dayAfterNewest = !hasAny || b.start >= horizon.newest!;
  const dayBeforeOldest = hasAny && b.end <= horizon.oldest!;
  if (!hasAny) flags.push("index_empty");
  else if (dayBeforeOldest) flags.push("day_is_before_oldest_indexed_record");
  else if (dayAfterNewest) flags.push("day_is_after_newest_indexed_record");
  else {
    if (b.end > horizon.newest!) flags.push("day_extends_past_newest_indexed_record_timeline_lags_hours_to_a_day");
    if (b.start < horizon.oldest!) flags.push("day_starts_before_oldest_indexed_record");
  }
  if (v.rows.length === 0 && a.rows.length === 0) flags.push("no_visits_or_activities");
  if (gaps.length) flags.push("unknown_time_gaps_present");
  if (truncated) flags.push("results_truncated");

  const starting = activitiesStartingIn(db, b.start, b.end);
  const movement = aggregateDistance(starting, "mode", cal);

  return {
    date,
    start: b.start,
    end: b.end,
    visits: v.rows,
    activities: a.rows,
    truncated,
    placeTotals,
    covered_ms: covered,
    gaps,
    unknown_ms: unknown,
    movement,
    flags,
    coverage: {
      has_data: v.rows.length + a.rows.length > 0,
      path_points: pathPointCount(db, b.start, b.end),
      indexed_range_covers_full_day: hasAny && b.start >= horizon.oldest! && b.end <= horizon.newest!,
    },
  };
}

function movementOut(m: ReturnType<typeof aggregateDistance>) {
  return {
    by_mode: m.groups.map((g) => ({
      mode: g.key,
      activity_count: g.activity_count,
      duration_seconds: g.duration_seconds,
      source_meters: g.source_meters,
      estimated_meters: g.estimated_meters,
      method: g.method,
    })),
    totals: m.totals,
  };
}

export function summarizeDay(db: Database, o: { date: string; tz: string; precision: Precision; maxItems?: number }) {
  const cal = new DayCalendar(o.tz);
  const d = loadDay(db, o.date, cal);
  const { precision } = o;
  const maxItems = o.maxItems ?? 500;

  const trips = queryTrips(db, { startMs: d.start, endMs: d.end, limit: 50 });
  const items: { ms: number; item: Record<string, unknown> }[] = [];
  for (const v of d.visits) {
    const cs = Math.max(v.start_ms, d.start);
    const ce = Math.min(v.end_ms, d.end);
    items.push({ ms: v.start_ms, item: { ...visitItem(v, precision, true), seconds_in_day: Math.max(0, Math.round((ce - cs) / 1000)) } });
  }
  for (const a of d.activities) items.push({ ms: a.start_ms, item: activityItem(a, precision, true) });
  for (const t of trips.rows) items.push({ ms: t.start_ms, item: { ...tripItem(t), marker: true } });
  items.sort((x, y) => x.ms - y.ms);
  const timeline = items.slice(0, maxItems).map((x) => x.item);

  const places = [...d.placeTotals.values()]
    .sort((a, b) => b.ms - a.ms)
    .map((t) => ({
      ...placeObject(placeFromVisit(t.p), precision),
      visit_count: t.visits,
      total_seconds: Math.round(t.ms / 1000),
      total_duration: humanDuration(Math.round(t.ms / 1000)),
      first_arrival_time: iso(t.first, t.p.start_offset_min),
    }));

  const sorted = [...d.visits].sort((a, b) => a.start_ms - b.start_ms);
  const brief = (v: VisitRow | undefined): Record<string, unknown> | null =>
    v
      ? {
          ...placeObject(placeFromVisit(v), precision),
          start_time: iso(v.start_ms, v.start_offset_min),
          end_time: iso(v.end_ms, v.end_offset_min),
        }
      : null;
  const lastVisit = [...d.visits].sort((a, b) => b.end_ms - a.end_ms)[0];

  const dayLen = (d.end - d.start) / 3600_000;
  return {
    date: o.date,
    timezone: o.tz,
    day_start: isoInZone(d.start, o.tz),
    day_end: isoInZone(d.end, o.tz),
    day_length_hours: Math.round(dayLen * 100) / 100,
    timeline,
    timeline_truncated: items.length > maxItems,
    places_visited: places,
    visit_count: d.visits.length,
    movement: movementOut(d.movement),
    first_known_place: brief(sorted[0]),
    last_known_place: brief(lastVisit),
    time_accounting: {
      covered_seconds: Math.round(d.covered_ms / 1000),
      unknown_seconds: Math.round(d.unknown_ms / 1000),
      gaps: d.gaps.map((g) => ({
        start_time: isoInZone(g.start, o.tz),
        end_time: isoInZone(g.end, o.tz),
        duration_seconds: Math.round((g.end - g.start) / 1000),
      })),
      min_gap_seconds: MIN_GAP_SECONDS,
    },
    coverage: { ...d.coverage, flags: d.flags },
    notes: [
      "Visits and activities are clipped to the calendar day for durations; movement distance is attributed to the day an activity starts.",
      "Unknown time excludes periods outside the indexed data range (Timeline lags hours to a day).",
    ],
  };
}

export function summarizeWeek(db: Database, o: { weekStart: string; tz: string; precision: Precision }) {
  const cal = new DayCalendar(o.tz);
  const days: string[] = [];
  const [y, m, dd] = o.weekStart.split("-").map(Number);
  for (let i = 0; i < 7; i++) days.push(new Date(Date.UTC(y, m - 1, dd + i)).toISOString().slice(0, 10));

  const weekPlaces = new Map<string, { p: VisitRow; visits: number; ms: number }>();
  const weekActs: ActivityRow[] = [];
  const perDay = days.map((date) => {
    const d = loadDay(db, date, cal);
    for (const [k, t] of d.placeTotals) {
      const cur = weekPlaces.get(k) ?? { p: t.p, visits: 0, ms: 0 };
      cur.visits += t.visits;
      cur.ms += t.ms;
      weekPlaces.set(k, cur);
    }
    const sorted = [...d.visits].sort((a, b) => a.start_ms - b.start_ms);
    const nameOf = (v: VisitRow | undefined) => (v ? v.p_name ?? v.semantic_type ?? v.p_semantic_type ?? v.place_key : null);
    const last = [...d.visits].sort((a, b) => b.end_ms - a.end_ms)[0];
    weekActs.push(...activitiesStartingIn(db, d.start, d.end));
    return {
      date,
      day_length_hours: Math.round(((d.end - d.start) / 3600_000) * 100) / 100,
      has_data: d.coverage.has_data,
      visit_count: d.visits.length,
      distinct_places: d.placeTotals.size,
      time_at_places_seconds: Math.round([...d.placeTotals.values()].reduce((s, t) => s + t.ms, 0) / 1000),
      unknown_seconds: Math.round(d.unknown_ms / 1000),
      first_place: nameOf(sorted[0]),
      last_place: nameOf(last),
      movement_by_mode: d.movement.groups.map((g) => ({
        mode: g.key,
        source_meters: g.source_meters,
        estimated_meters: g.estimated_meters,
        method: g.method,
      })),
      source_distance_meters: d.movement.totals.source_meters,
      estimated_distance_meters: d.movement.totals.estimated_meters,
      flags: d.flags,
    };
  });

  const topPlaces = [...weekPlaces.values()]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10)
    .map((t) => ({
      ...placeObject(placeFromVisit(t.p), o.precision),
      visit_count: t.visits,
      total_seconds: Math.round(t.ms / 1000),
    }));

  const week = aggregateDistance(weekActs, "mode", cal);
  const bounds = { start: cal.boundsOf(days[0]).start, end: cal.boundsOf(days[6]).end };
  return {
    week_start: days[0],
    week_end: days[6],
    timezone: o.tz,
    range_start: isoInZone(bounds.start, o.tz),
    range_end: isoInZone(bounds.end, o.tz),
    days: perDay,
    top_places: topPlaces,
    totals: {
      days_with_data: perDay.filter((d) => d.has_data).length,
      visit_count: perDay.reduce((s, d) => s + d.visit_count, 0),
      distinct_places: weekPlaces.size,
      time_at_places_seconds: perDay.reduce((s, d) => s + d.time_at_places_seconds, 0),
      movement: movementOut(week),
    },
  };
}

