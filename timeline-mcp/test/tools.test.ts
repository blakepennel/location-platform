import { afterEach, describe, expect, it } from "vitest";
import { haversineMeters } from "@location/shared";
import { setMetaJson } from "../src/db.ts";
import { TOOL_NAMES } from "../src/tools.ts";
import { connectInMemory } from "./helpers/client.ts";
import {
  CAFE,
  COORD_KEYS,
  HOME,
  OFFICE,
  allKeys,
  memoryIndex,
  standardDataset,
  visit,
} from "./helpers/synthetic.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(segments: unknown[] = standardDataset(), cfg: Parameters<typeof memoryIndex>[1] = {}) {
  const idx = memoryIndex(segments, cfg);
  const c = await connectInMemory(idx.db, idx.config);
  cleanups.push(async () => {
    await c.close();
    idx.cleanup();
  });
  return { ...c, idx };
}

const TZ = "Etc/GMT-2"; // fixed +02:00, no DST
const COORD_NUMBER = /\b(10|20)\.\d{3,}/; // synthetic coordinates always live near 10.x / 20.x

describe("envelope", () => {
  it("every tool returns source/semantics/precision and structured + text content", async () => {
    const { call, client } = await setup();
    const day = { start: "2025-01-02T00:00:00+02:00", end: "2025-01-03T00:00:00+02:00" };
    const calls: [string, Record<string, unknown>][] = [
      ["timeline_status", {}],
      ["where_was_i", { timestamp: "2025-01-02T12:00:00+02:00" }],
      ["visits", day],
      ["timeline_between", day],
      ["search_places", { query: "synthetic" }],
      ["visit_history", { place: "Synthetic Cafe" }],
      ["time_at_place", { place: "Synthetic Cafe" }],
      ["trips", {}],
      ["activities", day],
      ["distance_traveled", day],
      ["summarize_day", { date: "2025-01-02", timezone: TZ }],
      ["summarize_week", { week_start: "2025-01-02", timezone: TZ }],
      ["visits_near", { latitude: CAFE.lat, longitude: CAFE.lng, radius_meters: 200 }],
    ];
    expect(calls.map((c) => c[0]).sort()).toEqual([...TOOL_NAMES].sort());
    for (const [name, args] of calls) {
      const r = await call(name, args);
      expect(r.isError, `${name}: ${r.text}`).toBe(false);
      expect(r.data.source).toBe("google_timeline");
      expect(r.data.semantics).toBe("google_semantic_reconstruction");
      expect(r.data.precision).toBe("semantic");
      expect(JSON.parse(r.text)).toEqual(r.data);
    }
    // list tools always report truncated + total_available
    for (const name of ["visits", "timeline_between", "search_places", "visit_history", "trips", "activities"]) {
      const args = calls.find((c) => c[0] === name)![1];
      const r = await call(name, args);
      expect(typeof r.data.truncated, name).toBe("boolean");
      expect(typeof r.data.total_available, name).toBe("number");
    }
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(13);
  });
});

describe("visits", () => {
  it("finds visits by place name (case-insensitive substring), placeId and semantic type", async () => {
    const { call } = await setup();
    const range = { start: "2025-01-01T00:00:00+02:00", end: "2025-02-01T00:00:00+02:00" };
    const byName = await call("visits", { ...range, place: "cafe" });
    expect(byName.data.items).toHaveLength(2);
    expect(byName.data.items.every((i: any) => i.place.name === "Synthetic Cafe")).toBe(true);
    expect(byName.data.items[0].start_time < byName.data.items[1].start_time).toBe(true);

    const byId = await call("visits", { ...range, place: CAFE.placeId });
    expect(byId.data.items).toHaveLength(2);

    const home = await call("visits", { ...range, semantic_type: "home" });
    expect(home.data.items.map((i: any) => i.segment_id)).toEqual(["seg-v-home-1", "seg-v-home-2"]);
    expect(home.data.items[0]).toMatchObject({ kind: "visit", confidence: 0.9, is_confirmed: true });

    const none = await call("visits", { ...range, place: "no such place anywhere" });
    expect(none.data.items).toEqual([]);
    expect(none.data.total_available).toBe(0);
  });

  it("returns ISO times with each segment's own offset, including across a DST change", async () => {
    const { call } = await setup();
    const west = await call("visits", { start: "2025-01-10T00:00:00-05:00", end: "2025-01-11T00:00:00-05:00" });
    expect(west.data.items[0]).toMatchObject({ start_time: "2025-01-10T09:00:00-05:00", end_time: "2025-01-10T12:30:00-05:00", duration_seconds: 12600 });
    const dst = await call("visits", { start: "2025-03-09T00:00:00-05:00", end: "2025-03-09T23:00:00-04:00" });
    expect(dst.data.items[0]).toMatchObject({ start_time: "2025-03-09T00:00:00-05:00", end_time: "2025-03-09T09:00:00-04:00", duration_seconds: 28800 });
  });

  it("interprets offset-less times in the requested time zone", async () => {
    const { call } = await setup();
    const a = await call("visits", { start: "2025-01-02T00:00:00", end: "2025-01-03T00:00:00", timezone: TZ });
    const b = await call("visits", { start: "2025-01-02T00:00:00+02:00", end: "2025-01-03T00:00:00+02:00" });
    expect(a.data.items.map((i: any) => i.segment_id)).toEqual(b.data.items.map((i: any) => i.segment_id));
    expect(a.data.items).toHaveLength(4);
  });
});

describe("where_was_i", () => {
  it("exact: visit preferred, then activity", async () => {
    const { call } = await setup();
    const v = await call("where_was_i", { timestamp: "2025-01-02T12:00:00+02:00" });
    expect(v.data).toMatchObject({ match: "exact", item: { kind: "visit", place: { name: "Synthetic Office", semantic_type: "WORK" } } });
    const a = await call("where_was_i", { timestamp: "2025-01-02T08:40:00+02:00" });
    expect(a.data).toMatchObject({ match: "exact", item: { kind: "activity", mode: "walking", distance_meters: 1200 } });
    const local = await call("where_was_i", { timestamp: "2025-01-02T12:00:00", timezone: TZ });
    expect(local.data.item.place.name).toBe("Synthetic Office");
    expect(local.data.timestamp).toBe("2025-01-02T12:00:00+02:00");
  });

  it("nearest: within tolerance reports gap seconds and direction", async () => {
    const { call } = await setup();
    const r = await call("where_was_i", { timestamp: "2025-01-02T17:32:00+02:00" });
    expect(r.data.match).toBe("nearest");
    expect(r.data.gap_seconds).toBe(120);
    expect(r.data.relation).toBe("item_ended_before_timestamp");
    expect(r.data.item.kind).toBe("activity");
    // a tighter tolerance turns it into "none" (nothing within 1 minute)
    const tight = await call("where_was_i", { timestamp: "2025-01-02T17:32:00+02:00", tolerance_minutes: 1 });
    expect(tight.data.match).toBe("none");
  });

  it("estimate: interpolates between path points when nothing else is in range (coordinates only if precision allows)", async () => {
    const { call } = await setup();
    const args = { timestamp: "2025-01-02T19:05:00+02:00", tolerance_minutes: 1 };
    const exact = await call("where_was_i", { ...args, precision: "exact" });
    expect(exact.data).toMatchObject({ match: "estimate", estimate: true, gap_seconds: 60 });
    expect(exact.data.item).toMatchObject({ kind: "timeline_path", estimated: true, method: "path_interpolation" });
    expect(exact.data.item.latitude).toBeCloseTo(10.501, 6);
    expect(exact.data.item.longitude).toBeCloseTo(20.501, 6);
    const approx = await call("where_was_i", { ...args, precision: "approximate" });
    expect(approx.data.item.latitude).toBe(10.5);
    const sem = await call("where_was_i", args);
    expect(sem.data.match).toBe("estimate");
    expect(sem.data.item.latitude).toBeUndefined();
    expect(sem.data.item.coordinates_withheld).toBeTruthy();
  });

  it("none: far from any data, with coverage notes", async () => {
    const { call } = await setup();
    const before = await call("where_was_i", { timestamp: "2024-06-01T12:00:00Z" });
    expect(before.data).toMatchObject({ match: "none", item: null });
    expect(before.data.notes.join(" ")).toMatch(/before the oldest/);
    const after = await call("where_was_i", { timestamp: "2025-06-01T00:00:00Z" });
    expect(after.data.match).toBe("none");
    expect(after.data.notes.join(" ")).toMatch(/not real-time/);
    const gap = await call("where_was_i", { timestamp: "2025-01-04T12:00:00+02:00" });
    expect(gap.data.match).toBe("none");
  });

  it("rejects an unparseable timestamp and an unknown zone", async () => {
    const { call } = await setup();
    expect((await call("where_was_i", { timestamp: "last tuesday" })).isError).toBe(true);
    const tz = await call("where_was_i", { timestamp: "now", timezone: "Mars/Olympus" });
    expect(tz.isError).toBe(true);
    expect(tz.text).toMatch(/time zone/);
  });
});

describe("timeline_between", () => {
  const day = { start: "2025-01-02T00:00:00+02:00", end: "2025-01-03T00:00:00+02:00" };

  it("is compact by default: chronological visits+activities, no path points", async () => {
    const { call } = await setup();
    const r = await call("timeline_between", day);
    expect(r.data.items.map((i: any) => i.kind)).toEqual(["visit", "activity", "visit", "activity", "visit", "activity", "visit"]);
    expect(r.data.points).toBeUndefined();
    expect(r.data.items.some((i: any) => i.kind === "timeline_path")).toBe(false);
    const times = r.data.items.map((i: any) => i.start_time);
    expect([...times].sort()).toEqual(times);
    expect(r.text.length).toBeLessThan(4000);
    // compact visit items carry name + type, not the full place object
    expect(r.data.items[0]).toMatchObject({ place_name: "Synthetic Home", semantic_type: "HOME" });
    expect(r.data.items[0].place).toBeUndefined();
  });

  it("include_points returns downsampled points capped by max_points (and always keeps first and last)", async () => {
    const { call } = await setup();
    const all = await call("timeline_between", { ...day, include_points: true, precision: "approximate" });
    expect(all.data.points_total).toBe(12);
    expect(all.data.points).toHaveLength(12);
    expect(all.data.points_downsampled).toBe(false);
    const few = await call("timeline_between", { ...day, include_points: true, max_points: 5, precision: "approximate" });
    expect(few.data.points).toHaveLength(5);
    expect(few.data.points_downsampled).toBe(true);
    expect(few.data.points[0].time).toBe(all.data.points[0].time);
    expect(few.data.points[4].time).toBe(all.data.points[11].time);
    expect(few.data.points[0]).toHaveProperty("latitude");
    const huge = await call("timeline_between", { ...day, include_points: true, max_points: 100000, precision: "exact" });
    expect(huge.data.points.length).toBeLessThanOrEqual(500);
    // at semantic precision points are withheld entirely
    const sem = await call("timeline_between", { ...day, include_points: true });
    expect(sem.data.points).toBeUndefined();
    expect(sem.data.points_omitted).toMatch(/semantic/);
  });

  it("marks trips as markers", async () => {
    const { call } = await setup();
    const r = await call("timeline_between", { start: "2025-01-05T00:00:00+02:00", end: "2025-01-09T00:00:00+02:00" });
    const trip = r.data.items.find((i: any) => i.kind === "trip");
    expect(trip).toMatchObject({ marker: true, name: "trip_synthetic_1" });
  });
});

describe("limits", () => {
  const many = () =>
    Array.from({ length: 700 }, (_, i) => {
      const s = new Date(Date.parse("2025-02-01T00:00:00Z") + i * 3600_000);
      return visit({ id: `bulk-${i}`, start: s.toISOString(), end: new Date(s.getTime() + 1800_000).toISOString(), place: CAFE });
    });
  const range = { start: "2025-02-01T00:00:00Z", end: "2025-03-05T00:00:00Z" };

  it("defaults to 50, clamps to 500, and reports truncated/total_available", async () => {
    const { call } = await setup(many());
    const def = await call("visits", range);
    expect(def.data.items).toHaveLength(50);
    expect(def.data).toMatchObject({ truncated: true, total_available: 700, returned: 50 });
    const clamp = await call("visits", { ...range, limit: 10000 });
    expect(clamp.data.items).toHaveLength(500);
    expect(clamp.data).toMatchObject({ truncated: true, total_available: 700 });
    const small = await call("visits", { ...range, limit: 3 });
    expect(small.data.items).toHaveLength(3);
    const bogus = await call("visits", { ...range, limit: -5 });
    expect(bogus.data.items).toHaveLength(50);
    const all = await call("visits", { start: "2025-02-01T00:00:00Z", end: "2025-02-03T00:00:00Z", limit: 500 });
    expect(all.data).toMatchObject({ truncated: false, total_available: 48, returned: 48 });
    const hist = await call("visit_history", { place: "Synthetic Cafe", limit: 7 });
    expect(hist.data).toMatchObject({ returned: 7, truncated: true, total_available: 700 });
    expect(hist.data.items[0].start_time > hist.data.items[1].start_time).toBe(true); // newest first
    const tb = await call("timeline_between", { ...range, limit: 20 });
    expect(tb.data).toMatchObject({ returned: 20, truncated: true, total_available: 700 });
  });
});

describe("precision", () => {
  const day = { start: "2025-01-02T00:00:00+02:00", end: "2025-01-03T00:00:00+02:00" };

  it("semantic (default): no coordinate keys or numbers anywhere, and no address", async () => {
    const { call } = await setup();
    const calls: [string, Record<string, unknown>][] = [
      ["visits", day],
      ["activities", day],
      ["timeline_between", { ...day, include_points: true }],
      ["where_was_i", { timestamp: "2025-01-02T12:00:00+02:00" }],
      ["where_was_i", { timestamp: "2025-01-02T08:40:00+02:00" }],
      ["where_was_i", { timestamp: "2025-01-02T19:05:00+02:00", tolerance_minutes: 1 }],
      ["search_places", { query: "synthetic" }],
      ["visit_history", { place: "Synthetic Cafe" }],
      ["time_at_place", { place: "Synthetic Cafe" }],
      ["trips", {}],
      ["distance_traveled", day],
      ["summarize_day", { date: "2025-01-02", timezone: TZ }],
      ["summarize_week", { week_start: "2025-01-02", timezone: TZ }],
      ["timeline_status", {}],
    ];
    for (const [name, args] of calls) {
      const r = await call(name, args);
      expect(r.isError, `${name}: ${r.text}`).toBe(false);
      const bad = [...allKeys(r.data)].filter((k) => COORD_KEYS.test(k));
      expect(bad, `${name} leaked keys`).toEqual([]);
      expect(r.text, `${name} leaked coordinate-like numbers`).not.toMatch(COORD_NUMBER);
      expect(r.text, `${name} leaked address`).not.toContain(CAFE.address);
    }
  });

  it("approximate rounds to 2 decimals; exact keeps full precision", async () => {
    const { call } = await setup();
    const args = { ...day, place: "Synthetic Home" };
    const approx = await call("visits", { ...args, precision: "approximate" });
    expect(approx.data.precision).toBe("approximate");
    expect(approx.data.items[0].place).toMatchObject({ latitude: 10.1, longitude: 20.11 });
    const exact = await call("visits", { ...args, precision: "exact" });
    expect(exact.data.items[0].place).toMatchObject({ latitude: HOME.lat, longitude: HOME.lng });

    const acts = await call("activities", { ...day, mode: "walking", precision: "approximate" });
    expect(acts.data.items[0].start_location).toEqual({ latitude: 10.1, longitude: 20.11 });
    expect(acts.data.items[0].end_location).toEqual({ latitude: 10.2, longitude: 20.21 });
    const actsExact = await call("activities", { ...day, mode: "walking", precision: "exact" });
    expect(actsExact.data.items[0].end_location).toEqual({ latitude: OFFICE.lat, longitude: OFFICE.lng });

    const places = await call("search_places", { query: "cafe", precision: "approximate" });
    expect(places.data.items[0]).toMatchObject({ address: CAFE.address, latitude: 10.3, longitude: 20.31 });
    const compact = await call("timeline_between", { ...day, precision: "exact" });
    expect(compact.data.items[0]).toMatchObject({ latitude: HOME.lat, longitude: HOME.lng });
  });

  it("the server cap (TIMELINE_MAX_PRECISION) clamps requests and says so", async () => {
    const approxCap = await setup(standardDataset(), { maxPrecision: "approximate" });
    const r = await approxCap.call("visits", { ...day, place: "Synthetic Home", precision: "exact" });
    expect(r.data).toMatchObject({ precision: "approximate", precision_clamped: true, requested_precision: "exact" });
    expect(r.data.items[0].place.latitude).toBe(10.1);
    const semCap = await setup(standardDataset(), { maxPrecision: "semantic" });
    const s = await semCap.call("visits", { ...day, precision: "approximate" });
    expect(s.data).toMatchObject({ precision: "semantic", precision_clamped: true });
    expect([...allKeys(s.data)].filter((k) => COORD_KEYS.test(k))).toEqual([]);
  });
});

describe("distance_traveled", () => {
  it("keeps Google's distance and haversine estimates separate and flagged", async () => {
    const { call } = await setup();
    const r = await call("distance_traveled", { start: "2025-01-02T00:00:00+02:00", end: "2025-01-03T00:00:00+02:00" });
    const expected = haversineMeters({ lat: CAFE.lat, lng: CAFE.lng }, { lat: HOME.lat, lng: HOME.lng });
    const walking = r.data.groups.find((g: any) => g.mode === "walking");
    expect(walking).toMatchObject({ source_meters: 1200, source_activity_count: 1, estimated_activity_count: 1, method: "haversine_estimate" });
    expect(walking.estimated_meters).toBe(Math.round(expected));
    const car = r.data.groups.find((g: any) => g.mode === "in passenger vehicle");
    expect(car).toMatchObject({ source_meters: 5000, estimated_meters: 0, estimated_activity_count: 0, method: null });
    expect(r.data.totals).toMatchObject({ source_meters: 6200, estimated_meters: Math.round(expected), method: "haversine_estimate", activity_count: 3 });
    // never silently merged
    expect(r.data.totals.total_meters).toBeUndefined();
    expect(r.data.totals.source_meters).not.toBe(6200 + Math.round(expected));
  });

  it("groups by day and by none, attributing activities to the day they start (in the zone)", async () => {
    const { call } = await setup();
    const range = { start: "2025-01-02T00:00:00+02:00", end: "2025-01-09T00:00:00+02:00", timezone: TZ };
    const byDay = await call("distance_traveled", { ...range, group_by: "day" });
    expect(byDay.data.groups.map((g: any) => [g.day, g.source_meters])).toEqual([
      ["2025-01-02", 6200],
      ["2025-01-03", 3000],
      ["2025-01-05", 300000],
      ["2025-01-06", 2000],
    ]);
    const none = await call("distance_traveled", { ...range, group_by: "none" });
    expect(none.data.groups).toEqual([]);
    expect(none.data.totals.source_meters).toBe(311200);
    const flying = (await call("distance_traveled", range)).data.groups[0];
    expect(flying).toMatchObject({ mode: "flying", source_meters: 300000 });
  });
});

describe("places and history", () => {
  it("search_places ranks by time, filters by semantic type, and treats address as location data", async () => {
    const { call } = await setup();
    const all = await call("search_places", { query: "synthetic", timezone: TZ });
    expect(all.data.total_available).toBe(6);
    expect(all.data.items[0]).toMatchObject({ kind: "place", name: "Synthetic Office", visit_count: 4, total_seconds: 97200, semantic_type: "WORK" });
    expect(all.data.items[1]).toMatchObject({ kind: "place", name: "Synthetic Home", visit_count: 3, total_seconds: 76740, semantic_type: "HOME" });
    expect(all.data.items[1].first_seen).toBe("2025-01-02T00:00:00+02:00");
    const work = await call("search_places", { semantic_type: "work" });
    expect(work.data.items.map((i: any) => i.name)).toEqual(["Synthetic Office"]);
    expect((await call("search_places", { query: "1 Synthetic Street" })).data.total_available).toBe(0);
    const addr = await call("search_places", { query: "1 Synthetic Street", precision: "approximate" });
    expect(addr.data.items.map((i: any) => i.name)).toEqual(["Synthetic Cafe"]);
    const cat = await call("search_places", { query: "cafe" });
    expect(cat.data.items[0].category).toBe("cafe");
    expect((await call("search_places", { query: "%" })).data.total_available).toBe(0); // LIKE wildcards are escaped
    const id = await call("search_places", { query: CAFE.placeId });
    expect(id.data.items).toHaveLength(1);
    expect(id.data.items[0].place_id).toBe(CAFE.placeId);
  });

  it("visit_history resolves key/placeId/name, newest first, with optional range", async () => {
    const { call } = await setup();
    const h = await call("visit_history", { place: "Synthetic Cafe" });
    expect(h.data.place_match).toMatchObject({ match_type: "name_exact", matched_count: 1 });
    expect(h.data.items.map((i: any) => i.segment_id)).toEqual(["seg-v-cafe-2", "seg-v-cafe-1"]);
    const asc = await call("visit_history", { place: CAFE.placeId, order: "asc" });
    expect(asc.data.place_match.match_type).toBe("key");
    expect(asc.data.items.map((i: any) => i.segment_id)).toEqual(["seg-v-cafe-1", "seg-v-cafe-2"]);
    const ranged = await call("visit_history", { place: "cafe", start: "2025-01-02T00:00:00+02:00", end: "2025-01-03T00:00:00+02:00" });
    expect(ranged.data.place_match.match_type).toBe("name_partial");
    expect(ranged.data.items).toHaveLength(1);
    const multi = await call("visit_history", { place: "Synthetic", limit: 500 });
    expect(multi.data.place_match).toMatchObject({ match_type: "name_partial", matched_count: 6 });
    const missing = await call("visit_history", { place: "Nowhere Land" });
    expect(missing.isError).toBe(true);
    expect(missing.text.length).toBeLessThan(120);
  });

  it("time_at_place sums, clips to the range and splits per day in the zone", async () => {
    const { call } = await setup();
    const whole = await call("time_at_place", { place: "Synthetic Office" });
    expect(whole.data).toMatchObject({ total_seconds: 97200, visit_count: 4, per_day_truncated: false });
    const jan = await call("time_at_place", { place: "Synthetic Office", start: "2025-01-01T00:00:00+02:00", end: "2025-02-01T00:00:00+02:00", timezone: TZ });
    expect(jan.data.total_seconds).toBe(39600);
    expect(jan.data.visit_count).toBe(2);
    expect(jan.data.per_day).toEqual([
      { date: "2025-01-02", seconds: 28800 },
      { date: "2025-01-03", seconds: 10800 },
    ]);
    const clipped = await call("time_at_place", { place: "Synthetic Office", start: "2025-01-02T10:00:00+02:00", end: "2025-01-02T12:00:00+02:00" });
    expect(clipped.data).toMatchObject({ total_seconds: 7200, visit_count: 1 });
    const overnight = await call("time_at_place", { place: HOTEL_ID, timezone: TZ });
    expect(overnight.data.per_day).toEqual([
      { date: "2025-01-05", seconds: 21600 },
      { date: "2025-01-06", seconds: 32400 },
    ]);
    // overlapping visits are merged, never double-counted
    const overlapping = await setup([
      visit({ id: "o1", start: "2025-01-02T09:00:00+02:00", end: "2025-01-02T11:00:00+02:00", place: OFFICE }),
      visit({ id: "o2", start: "2025-01-02T10:00:00+02:00", end: "2025-01-02T12:00:00+02:00", place: OFFICE }),
    ]);
    const o = await overlapping.call("time_at_place", { place: "Synthetic Office" });
    expect(o.data).toMatchObject({ total_seconds: 3 * 3600, visit_count: 2 });
  });

  it("trips summarise contained visits, source distance by mode and top places", async () => {
    const { call } = await setup();
    const r = await call("trips", {});
    expect(r.data.items).toHaveLength(1);
    const t = r.data.items[0];
    expect(t).toMatchObject({ kind: "trip", name: "trip_synthetic_1", visit_count: 2, activity_count: 2, source_distance_meters: 302000 });
    expect(t.distance_by_mode).toEqual([
      { mode: "flying", source_meters: 300000, activity_count: 1 },
      { mode: "in passenger vehicle", source_meters: 2000, activity_count: 1 },
    ]);
    expect(t.top_places.map((p: any) => p.name)).toEqual(["Synthetic Lakeside Hotel", "Synthetic Museum"]);
    expect((await call("trips", { start: "2025-02-01T00:00:00Z", end: "2025-02-10T00:00:00Z" })).data.items).toEqual([]);
  });

  it("activities filters by mode substring", async () => {
    const { call } = await setup();
    const day = { start: "2025-01-02T00:00:00+02:00", end: "2025-01-03T00:00:00+02:00" };
    expect((await call("activities", day)).data.items).toHaveLength(3);
    expect((await call("activities", { ...day, mode: "walk" })).data.items).toHaveLength(2);
    const v = await call("activities", { ...day, mode: "vehicle" });
    expect(v.data.items).toMatchObject([{ mode: "in passenger vehicle", distance_meters: 5000, confidence: 0.9 }]);
    const noDistance = (await call("activities", { ...day, mode: "walk" })).data.items[1];
    expect(noDistance.distance_meters).toBeNull();
  });
});

describe("summaries", () => {
  it("summarize_day: ordered timeline, places, movement, first/last place, gaps and coverage", async () => {
    const { call } = await setup();
    const r = (await call("summarize_day", { date: "2025-01-02", timezone: TZ })).data;
    expect(r).toMatchObject({ date: "2025-01-02", timezone: TZ, day_length_hours: 24, day_start: "2025-01-02T00:00:00+02:00", day_end: "2025-01-03T00:00:00+02:00", visit_count: 4 });
    expect(r.timeline).toHaveLength(7);
    expect(r.timeline.map((i: any) => i.start_time)).toEqual([...r.timeline.map((i: any) => i.start_time)].sort());
    expect(r.places_visited.map((p: any) => [p.name, p.visit_count, p.total_seconds])).toEqual([
      ["Synthetic Home", 2, 47940],
      ["Synthetic Office", 1, 28800],
      ["Synthetic Cafe", 1, 3600],
    ]);
    expect(r.first_known_place).toMatchObject({ name: "Synthetic Home", start_time: "2025-01-02T00:00:00+02:00" });
    expect(r.last_known_place).toMatchObject({ name: "Synthetic Home", end_time: "2025-01-02T23:59:00+02:00" });
    expect(r.movement.by_mode.map((m: any) => m.mode).sort()).toEqual(["in passenger vehicle", "walking"]);
    expect(r.movement.totals.source_meters).toBe(6200);
    expect(r.time_accounting.gaps.map((g: any) => g.duration_seconds)).toEqual([600, 600, 600]);
    expect(r.time_accounting).toMatchObject({ unknown_seconds: 1860, covered_seconds: 84540 });
    expect(r.time_accounting.gaps[0]).toMatchObject({ start_time: "2025-01-02T08:50:00+02:00", end_time: "2025-01-02T09:00:00+02:00" });
    expect(r.coverage.has_data).toBe(true);
    expect(r.coverage.path_points).toBe(12);
    expect(r.coverage.flags).toContain("unknown_time_gaps_present");
  });

  it("summarize_day handles a 23-hour DST day in the requested zone", async () => {
    const { call } = await setup();
    const r = (await call("summarize_day", { date: "2025-03-09", timezone: "America/New_York" })).data;
    expect(r.day_length_hours).toBe(23);
    expect(r.day_start).toBe("2025-03-09T00:00:00-05:00");
    expect(r.day_end).toBe("2025-03-10T00:00:00-04:00");
    expect(r.places_visited.map((p: any) => [p.name, p.total_seconds])).toEqual([
      ["Synthetic Home", 28800],
      ["Synthetic Office", 28800],
    ]);
    expect(r.time_accounting.gaps.map((g: any) => g.duration_seconds)).toEqual([3600, 21600]);
    expect(r.time_accounting).toMatchObject({ unknown_seconds: 25200, covered_seconds: 57600 });
    expect(r.time_accounting.gaps[0].start_time).toBe("2025-03-09T09:00:00-04:00");
    // the same instants viewed in another zone are a different day
    const utc = (await call("summarize_day", { date: "2025-03-09", timezone: "UTC" })).data;
    expect(utc.day_length_hours).toBe(24);
    // and a fall-back day is 25 hours
    expect((await call("summarize_day", { date: "2025-11-02", timezone: "America/New_York" })).data.day_length_hours).toBe(25);
  });

  it("summarize_day flags days outside the indexed range instead of reporting unknown time", async () => {
    const { call } = await setup();
    const after = (await call("summarize_day", { date: "2025-03-12", timezone: "UTC" })).data;
    expect(after.coverage.flags).toContain("day_is_after_newest_indexed_record");
    expect(after.timeline).toEqual([]);
    expect(after.time_accounting.unknown_seconds).toBe(0);
    const before = (await call("summarize_day", { date: "2024-01-01", timezone: "UTC" })).data;
    expect(before.coverage.flags).toContain("day_is_before_oldest_indexed_record");
    const partial = (await call("summarize_day", { date: "2025-03-10", timezone: "America/New_York" })).data;
    expect(partial.coverage.flags.join()).toMatch(/day_extends_past_newest/);
    expect(partial.time_accounting.gaps.map((g: any) => g.duration_seconds)).toEqual([9 * 3600]); // 00:00-09:00 only; tail is "not yet synced"
  });

  it("summarize_week: exactly 7 days with rollups, top places and totals", async () => {
    const { call } = await setup();
    const r = (await call("summarize_week", { week_start: "2025-01-02", timezone: TZ })).data;
    expect(r.days.map((d: any) => d.date)).toEqual(["2025-01-02", "2025-01-03", "2025-01-04", "2025-01-05", "2025-01-06", "2025-01-07", "2025-01-08"]);
    expect(r.days.map((d: any) => d.visit_count)).toEqual([4, 2, 0, 1, 2, 0, 0]);
    expect(r.days[0]).toMatchObject({ first_place: "Synthetic Home", last_place: "Synthetic Home", has_data: true, source_distance_meters: 6200 });
    expect(r.days[2].has_data).toBe(false);
    expect(r.top_places.map((p: any) => [p.name, p.total_seconds]).slice(0, 3)).toEqual([
      ["Synthetic Lakeside Hotel", 54000],
      ["Synthetic Home", 47940],
      ["Synthetic Office", 39600],
    ]);
    expect(r.totals).toMatchObject({ days_with_data: 4, visit_count: 9 });
    expect(r.totals.movement.by_mode[0]).toMatchObject({ mode: "flying", source_meters: 300000 });
    expect(r.range_start).toBe("2025-01-02T00:00:00+02:00");
    expect(r.range_end).toBe("2025-01-09T00:00:00+02:00");
  });
});

describe("timeline_status", () => {
  it("reports coverage, counts, freshness and sanitized sync health", async () => {
    const { call, idx } = await setup();
    setMetaJson(idx.db, "sync_status", {
      schema_version: 1,
      source: "google_timeline",
      adapter: "synthetic",
      last_attempt_at: "2025-03-10T23:30:00Z",
      last_success_at: "2025-03-10T23:00:00Z",
      last_cloud_request_at: "2025-03-10T22:59:00Z",
      consecutive_failures: 2,
      last_error: {
        at: "2025-03-10T23:30:00Z",
        stage: "fetch",
        message: "GET failed for Bearer abc.def.ghi at C:\\Users\\someone\\secret\\key.txt near 10.123456, 20.123456 token ya29.SECRETVALUE",
      },
      auth: { state: "ok", checked_at: "2025-03-10T22:59:00Z" },
    });
    const r = (await call("timeline_status")).data;
    expect(r.counts).toEqual({ places: 7, visits: 13, activities: 6, timeline_paths: 2, trips: 1 });
    expect(r.coverage).toEqual({ oldest_start: "2025-01-02T00:00:00+02:00", newest_end: "2025-03-10T17:00:00-04:00" });
    expect(r.newest_record).toMatchObject({ kind: "visit", end_time: "2025-03-10T17:00:00-04:00" });
    expect(r.freshness_seconds).toBe(3 * 3600);
    expect(r.lag).toMatchObject({ newest_record_age_seconds: 3 * 3600, last_sync_age_seconds: 3600, last_cloud_request_age_seconds: 3660 });
    expect(r.sync).toMatchObject({ last_success_at: "2025-03-10T23:00:00Z", last_cloud_request_at: "2025-03-10T22:59:00Z", consecutive_failures: 2 });
    expect(r.auth).toEqual({ state: "ok", checked_at: "2025-03-10T22:59:00Z" });
    expect(r.health).toBe("degraded");
    expect(r.last_error.stage).toBe("fetch");
    for (const secret of ["abc.def.ghi", "someone", "SECRETVALUE", "10.123456"]) expect(r.last_error.message).not.toContain(secret);
    expect(r.index).toMatchObject({ present: true, generator: "timeline-sync", adapter: "synthetic" });
    expect(r.notes.join(" ")).toMatch(/NOT real-time/);
  });

  it("reports no_data for an empty index", async () => {
    const { call } = await setup([]);
    const r = (await call("timeline_status")).data;
    expect(r.health).toBe("no_data");
    expect(r.coverage).toEqual({ oldest_start: null, newest_end: null });
    expect(r.freshness_seconds).toBeNull();
  });
});

describe("validation", () => {
  it("rejects bad ranges with short messages", async () => {
    const { call } = await setup();
    const a = { start: "2025-01-02T00:00:00Z", end: "2025-01-02T00:00:00Z" };
    for (const name of ["visits", "activities", "timeline_between", "distance_traveled"]) {
      const r = await call(name, a);
      expect(r.isError, name).toBe(true);
      expect(r.text).toMatch(/end must be after start/);
    }
    const big = await call("visits", { start: "2024-01-01T00:00:00Z", end: "2025-03-01T00:00:00Z" });
    expect(big.isError).toBe(true);
    expect(big.text).toMatch(/max 400 days/);
    const ok = await call("visits", { start: "2024-02-01T00:00:00Z", end: "2025-03-01T00:00:00Z" }); // 394 days
    expect(ok.isError).toBe(false);
    const openBig = await call("visit_history", { place: "cafe", start: "2020-01-01T00:00:00Z", end: "2025-03-01T00:00:00Z" });
    expect(openBig.isError).toBe(true);
    expect((await call("visits", { start: "garbage", end: "2025-01-02T00:00:00Z" })).isError).toBe(true);
    expect((await call("summarize_day", { date: "2025-02-30" })).isError).toBe(true);
    expect((await call("summarize_day", { date: "yesterday" })).isError).toBe(true);
    expect((await call("summarize_week", { week_start: "2025-1-1" })).isError).toBe(true);
    expect((await call("summarize_week", { week_start: "2025-01-02", timezone: "Nope/Zone" })).isError).toBe(true);
  });

  it("rejects wrong argument types via the schema", async () => {
    const { call, client } = await setup();
    const r = await call("visits", { start: 5, end: "2025-01-02T00:00:00Z" });
    expect(r.isError).toBe(true);
    const bad = await call("summarize_day", { date: "2025-01-02", precision: "ultra" });
    expect(bad.isError).toBe(true);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });
});

const HOTEL_ID = "ChIJSyntheticHotel0000000";


describe("coordinates everywhere + configurable default precision", () => {
  it("defaults to exact when TIMELINE_DEFAULT_PRECISION-style config says so, with maps links", async () => {
    const { call } = await setup(standardDataset(), { defaultPrecision: "exact" });
    const r = await call("visit_history", { place: "Synthetic Cafe" });
    expect(r.data.precision).toBe("exact");
    const place = r.data.items[0].place;
    expect(place.latitude).toBeCloseTo(CAFE.lat, 6);
    expect(place.longitude).toBeCloseTo(CAFE.lng, 6);
    expect(String(place.maps_url)).toContain("place_id:");
  });

  it("the default is clamped by the server cap", async () => {
    const { call } = await setup(standardDataset(), { defaultPrecision: "exact", maxPrecision: "approximate" });
    const r = await call("visit_history", { place: "Synthetic Cafe" });
    expect(r.data.precision).toBe("approximate");
    expect(r.data.items[0].place.latitude).toBe(Math.round(CAFE.lat * 100) / 100);
    expect(String(r.data.items[0].place.maps_url)).toContain("maps?q=");
  });

  it("time_at_place, trips and summarize_week now honor precision", async () => {
    const { call } = await setup();
    const tap = await call("time_at_place", { place: "Synthetic Cafe", precision: "exact" });
    expect(tap.data.place_match.matched_places[0].latitude).toBeCloseTo(CAFE.lat, 6);
    const week = await call("summarize_week", { week_start: "2025-01-02", timezone: TZ, precision: "exact" });
    expect(JSON.stringify(week.data)).toMatch(COORD_NUMBER);
    const trips = await call("trips", { precision: "exact" });
    expect(trips.isError).toBe(false);
    for (const tool of ["time_at_place", "summarize_week"]) {
      const args = tool === "time_at_place" ? { place: "Synthetic Cafe" } : { week_start: "2025-01-02", timezone: TZ };
      const sem = await call(tool, args);
      expect(JSON.stringify(sem.data)).not.toMatch(COORD_NUMBER);   // default stays semantic in code
    }
  });

  it("visits_near finds visits by location, nearest places first, with distances", async () => {
    const { call } = await setup();
    const r = await call("visits_near", { latitude: CAFE.lat, longitude: CAFE.lng, radius_meters: 150, precision: "exact" });
    expect(r.isError).toBe(false);
    expect(r.data.places[0].name).toBe("Synthetic Cafe");
    expect(r.data.places[0].distance_meters).toBeLessThan(5);
    expect(r.data.items.length).toBeGreaterThan(0);
    for (const v of r.data.items) expect(v.place.name).toBe("Synthetic Cafe");
    const far = await call("visits_near", { latitude: 11.5, longitude: 21.5, radius_meters: 100 });
    expect(far.data.places_found).toBe(0);
    expect(far.data.items).toEqual([]);
  });
});
