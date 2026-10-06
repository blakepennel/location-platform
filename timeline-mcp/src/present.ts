/**
 * Shapes DB rows into tool output. This is the ONLY module that turns stored coordinates into
 * response fields, and it always goes through applyPrecision(): at "semantic" precision no
 * coordinate-bearing key is ever emitted.
 */
import { applyPrecision, freshnessSeconds, humanDuration, isoWithOffset, type Precision } from "@location/shared";
import type { ActivityRow, PathPoint, PlaceRow, PlaceWithStats, TripRow, VisitRow } from "./queries.ts";

export const SOURCE = "google_timeline" as const;
export const SEMANTICS = "google_semantic_reconstruction" as const;

export function baseFields(precision: Precision, newestEndMs: number | null, now: number, extra: Record<string, unknown> = {}) {
  return {
    source: SOURCE,
    semantics: SEMANTICS,
    precision,
    freshness_seconds: newestEndMs == null ? null : freshnessSeconds(new Date(newestEndMs).toISOString(), now),
    ...extra,
  };
}

export function iso(ms: number, offsetMin: number): string {
  return isoWithOffset(ms, offsetMin);
}

function loc(lat: number | null, lng: number | null, precision: Precision): Record<string, number> {
  return applyPrecision(lat, lng, precision) as Record<string, number>;
}

function locObj(key: string, lat: number | null, lng: number | null, precision: Precision): Record<string, unknown> {
  const c = applyPrecision(lat, lng, precision);
  return c.latitude === undefined ? {} : { [key]: c };
}

export interface PlaceFields {
  place_key: string | null;
  place_id: string | null;
  name: string | null;
  address: string | null;
  category: string | null;
  semantic_type: string | null;
  lat: number | null;
  lng: number | null;
}

export function placeFromVisit(v: VisitRow): PlaceFields {
  return {
    place_key: v.place_key,
    place_id: v.p_place_id,
    name: v.p_name,
    address: v.p_address,
    category: v.p_category,
    semantic_type: v.semantic_type ?? v.p_semantic_type,
    lat: v.p_lat,
    lng: v.p_lng,
  };
}

/** Full place object. Address is treated as location data: only at approximate/exact. */
export function placeObject(p: PlaceFields, precision: Precision): Record<string, unknown> {
  const o: Record<string, unknown> = {
    place_key: p.place_key,
    place_id: p.place_id,
    name: p.name,
    category: p.category,
    semantic_type: p.semantic_type,
  };
  if (precision !== "semantic") {
    o.address = p.address;
    const c = loc(p.lat, p.lng, precision);
    Object.assign(o, c);
    const url = mapsUrl(p.place_id, c.latitude, c.longitude, precision);
    if (url) o.maps_url = url;
  }
  return o;
}

/** Google Maps link: by placeId at exact precision (it pinpoints the place), else by the shown coordinates. */
export function mapsUrl(placeId: string | null, lat: number | undefined, lng: number | undefined, precision: Precision): string | null {
  if (precision === "semantic") return null;
  if (precision === "exact" && placeId) return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`;
  if (lat === undefined || lng === undefined) return null;
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

export function visitItem(v: VisitRow, precision: Precision, compact = false): Record<string, unknown> {
  const dur = Math.max(0, Math.round((v.end_ms - v.start_ms) / 1000));
  const base: Record<string, unknown> = {
    kind: "visit",
    segment_id: v.segment_id,
    start_time: iso(v.start_ms, v.start_offset_min),
    end_time: iso(v.end_ms, v.end_offset_min),
    duration_seconds: dur,
  };
  const p = placeFromVisit(v);
  if (compact) {
    Object.assign(base, {
      place_key: p.place_key,
      place_name: p.name,
      semantic_type: p.semantic_type,
      confidence: v.probability,
    });
    Object.assign(base, loc(p.lat, p.lng, precision));
    return base;
  }
  return {
    ...base,
    duration: humanDuration(dur),
    place: placeObject(p, precision),
    confidence: v.probability,
    place_confidence: v.candidate_probability,
    is_confirmed: v.is_confirmed === 1,
  };
}

export function activityItem(a: ActivityRow, precision: Precision, compact = false): Record<string, unknown> {
  const dur = Math.max(0, Math.round((a.end_ms - a.start_ms) / 1000));
  const o: Record<string, unknown> = {
    kind: "activity",
    segment_id: a.segment_id,
    start_time: iso(a.start_ms, a.start_offset_min),
    end_time: iso(a.end_ms, a.end_offset_min),
    duration_seconds: dur,
    mode: a.mode ?? "unknown",
    distance_meters: a.distance_m,
    confidence: a.mode_probability,
  };
  if (!compact) {
    o.mode_code = a.mode_code;
    o.duration = humanDuration(dur);
  }
  Object.assign(o, locObj("start_location", a.start_lat, a.start_lng, precision));
  Object.assign(o, locObj("end_location", a.end_lat, a.end_lng, precision));
  return o;
}

export function tripItem(t: TripRow): Record<string, unknown> {
  const dur = Math.max(0, Math.round((t.end_ms - t.start_ms) / 1000));
  return {
    kind: "trip",
    segment_id: t.segment_id,
    name: t.name,
    start_time: iso(t.start_ms, t.start_offset_min),
    end_time: iso(t.end_ms, t.end_offset_min),
    duration_seconds: dur,
  };
}

export function pointItem(p: PathPoint, offsetMin: number, precision: Precision): Record<string, unknown> {
  return { time: p.ms == null ? null : iso(p.ms, offsetMin), ...loc(p.lat, p.lng, precision) };
}

export function placeSummary(p: PlaceWithStats | (PlaceRow & { total_ms?: number }), precision: Precision, fmt: (ms: number) => string): Record<string, unknown> {
  const o: Record<string, unknown> = {
    ...placeObject(
      {
        place_key: p.place_key,
        place_id: p.place_id,
        name: p.name,
        address: p.address,
        category: p.category,
        semantic_type: p.semantic_type,
        lat: p.lat,
        lng: p.lng,
      },
      precision,
    ),
    visit_count: p.visit_count,
  };
  if (p.total_ms !== undefined) {
    const s = Math.round(p.total_ms / 1000);
    o.total_seconds = s;
    o.total_duration = humanDuration(s);
  }
  o.first_seen = p.first_seen == null ? null : fmt(p.first_seen);
  o.last_seen = p.last_seen == null ? null : fmt(p.last_seen);
  return o;
}
