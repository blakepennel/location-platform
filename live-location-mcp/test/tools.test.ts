import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { haversineMeters, downsample } from "@location/shared";
import { buildServer } from "../src/tools.ts";
import { PERSON, memDb, obs, silentLogger, testConfig } from "./helpers.ts";
import type { LiveDb } from "../src/db.ts";
import type { LiveConfig } from "../src/config.ts";

const NOW = Date.UTC(2026, 0, 20, 12, 0, 0);
const MIN = 60_000;

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

async function connect(db: LiveDb, config: LiveConfig = testConfig()) {
  const server = buildServer({ db, config, logger: silentLogger, now: () => NOW });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: any; content: Array<{ text: string }> };
  return r;
}

/** A straight north-going track along one meridian, one fix per minute. */
function seedTrack(db: LiveDb, n = 10, endTs = NOW - 2 * MIN) {
  const rows = Array.from({ length: n }, (_, i) => obs(endTs - (n - 1 - i) * MIN, 10.0 + i * 0.001, 20.0));
  db.insertObservations(rows, endTs + 1000);
  return rows;
}

describe("tool listing", () => {
  it("exposes the 5 read-only tools with input schemas", async () => {
    const client = await connect(memDb());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["location_status", "movement_since", "recent_locations", "where_am_i", "where_was_i_recently"]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
    expect(tools.find((t) => t.name === "recent_locations")!.inputSchema.required).toEqual(expect.arrayContaining(["start", "end"]));
  });
});

describe("where_am_i", () => {
  it("returns a status result when there is no data", async () => {
    const r = await call(await connect(memDb()), "where_am_i");
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ kind: "status", source: "google_location_sharing", semantics: "raw_point_observation" });
    expect(r.structuredContent.latitude).toBeUndefined();
  });

  it("returns the latest observation with freshness, staleness, accuracy and battery", async () => {
    const db = memDb();
    db.insertObservations([obs(NOW - 3 * MIN, 10.111111111, 20.222222222, { accuracy_m: 33, battery_level: 64, battery_charging: true })], NOW - 2 * MIN);
    db.insertObservations([obs(NOW - 1 * MIN, 10.123456789, 20.987654321, { accuracy_m: 21, battery_level: 63, battery_charging: false })], NOW - 30_000);
    const r = await call(await connect(db), "where_am_i");
    const s = r.structuredContent;
    expect(s).toMatchObject({
      source: "google_location_sharing",
      semantics: "raw_point_observation",
      kind: "observation",
      precision: "exact",
      freshness_seconds: 60,
      accuracy_meters: 21,
      stale: false,
      battery_level: 63,
      battery_charging: false,
      observed_at: new Date(NOW - MIN).toISOString(),
      polled_at: new Date(NOW - 30_000).toISOString(),
    });
    expect(s.latitude).toBeCloseTo(10.123456789, 7);
    expect(s.longitude).toBeCloseTo(20.987654321, 7);
    expect(s.freshness_human).toBe("60 s");
    expect(JSON.parse(r.content[0].text)).toEqual(s);
    expect(JSON.stringify(s)).not.toContain(PERSON); // person id never leaves
  });

  it("marks old data stale and honours approximate precision", async () => {
    const db = memDb();
    db.insertObservations([obs(NOW - 20 * MIN, 10.123456, 20.987654)], NOW - 20 * MIN);
    const r = await call(await connect(db), "where_am_i", { precision: "approximate" });
    expect(r.structuredContent.stale).toBe(true);
    expect(r.structuredContent.freshness_seconds).toBe(1200);
    expect(r.structuredContent.latitude).toBe(10.12);
    expect(r.structuredContent.longitude).toBe(20.99);
    expect(r.structuredContent.precision).toBe("approximate");
  });

  it("caps precision at LIVE_MAX_PRECISION and omits coordinates for semantic", async () => {
    const db = memDb();
    seedTrack(db, 3);
    const approxOnly = await call(await connect(db, testConfig({ maxPrecision: "approximate" })), "where_am_i", { precision: "exact" });
    expect(approxOnly.structuredContent.precision).toBe("approximate");
    expect(approxOnly.structuredContent.latitude).toBe(10);
    const sem = await call(await connect(db, testConfig({ maxPrecision: "semantic" })), "where_am_i");
    expect(sem.structuredContent.precision).toBe("semantic");
    expect(sem.structuredContent.latitude).toBeUndefined();
    expect(sem.structuredContent.longitude).toBeUndefined();
  });

  it("rejects an invalid precision value", async () => {
    const r = await call(await connect(memDb()), "where_am_i", { precision: "semantic" }).catch((e) => e);
    expect(r instanceof Error || r.isError === true).toBe(true);
  });

  it("only reads the configured sharer when LIVE_SHARER_ID is set", async () => {
    const db = memDb();
    db.insertObservations([obs(NOW - MIN, 10.5, 20.5), { ...obs(NOW - 10_000, 10.9, 20.9), person_id: "other" }], NOW);
    const r = await call(await connect(db, testConfig({ sharerId: PERSON })), "where_am_i");
    expect(r.structuredContent.latitude).toBe(10.5);
  });
});

describe("recent_locations", () => {
  it("uses exact precision by default when LIVE_DEFAULT_PRECISION=exact, with maps links on where_am_i", async () => {
    const db = memDb();
    seedTrack(db, 10);
    const cfg = testConfig({ historyPrecision: "exact" });
    const r = (await call(await connect(db, cfg), "recent_locations", { start: new Date(NOW - 60 * MIN).toISOString(), end: "now" })).structuredContent;
    expect(r.precision).toBe("exact");
    expect(r.points.some((p: any) => /\.\d{3,}$/.test(String(p.latitude)))).toBe(true);   // not rounded to 2dp
    const here = (await call(await connect(db, cfg), "where_am_i")).structuredContent;
    expect(here.maps_url).toBe(`https://www.google.com/maps?q=${here.latitude},${here.longitude}`);
    const capped = (await call(await connect(db, testConfig({ historyPrecision: "exact", maxPrecision: "approximate" })), "recent_locations", { start: new Date(NOW - 60 * MIN).toISOString(), end: "now" })).structuredContent;
    expect(capped.precision).toBe("approximate");
  });

  it("returns chronological points in range, approximate by default", async () => {
    const db = memDb();
    seedTrack(db, 10);
    const r = await call(await connect(db), "recent_locations", { start: new Date(NOW - 60 * MIN).toISOString(), end: "now" });
    const s = r.structuredContent;
    expect(s.count).toBe(10);
    expect(s.total_available).toBe(10);
    expect(s.truncated).toBe(false);
    expect(s.precision).toBe("approximate");
    expect(s.points.map((p: any) => p.observed_at)).toEqual([...s.points.map((p: any) => p.observed_at)].sort());
    expect(s.points[0].latitude).toBe(10);
    expect(s.freshness_seconds).toBe(120);
    expect(s.source).toBe("google_location_sharing");
  });

  it("downsamples to max_points (never more) and reports truncation", async () => {
    const db = memDb();
    seedTrack(db, 500, NOW - MIN);
    const c = await connect(db);
    for (const max of [1, 2, 7, 50, 200, 499, 500, 1000]) {
      const s = (await call(c, "recent_locations", { start: NOW - 24 * 60 * MIN, end: NOW, max_points: max })).structuredContent;
      expect(s.points.length).toBeLessThanOrEqual(max);
      expect(s.count).toBe(s.points.length);
      expect(s.total_available).toBe(500);
      expect(s.truncated).toBe(max < 500);
    }
    const s = (await call(c, "recent_locations", { start: NOW - 24 * 60 * MIN, end: NOW, max_points: 50, precision: "exact" })).structuredContent;
    // first and last preserved, order preserved
    expect(s.points[0].observed_at).toBe(new Date(NOW - MIN - 499 * MIN).toISOString());
    expect(s.points.at(-1).observed_at).toBe(new Date(NOW - MIN).toISOString());
  });

  it("default max_points is 200", async () => {
    const db = memDb();
    seedTrack(db, 500, NOW - MIN);
    const s = (await call(await connect(db), "recent_locations", { start: NOW - 24 * 60 * MIN, end: NOW })).structuredContent;
    expect(s.points).toHaveLength(200);
  });

  it("rejects bad ranges and bad timestamps", async () => {
    const c = await connect(memDb());
    expect((await call(c, "recent_locations", { start: "2026-01-20T10:00:00Z", end: "2026-01-20T09:00:00Z" })).isError).toBe(true);
    expect((await call(c, "recent_locations", { start: "2025-01-01T00:00:00Z", end: "2026-01-01T00:00:00Z" })).isError).toBe(true);
    const bad = await call(c, "recent_locations", { start: "not a time", end: "now" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("start");
    const over = await call(c, "recent_locations", { start: "today", end: "now", max_points: 5000 }).catch((e) => e);
    expect(over instanceof Error || over.isError === true).toBe(true);
  });

  it("empty range gives a message, not an error", async () => {
    const r = await call(await connect(memDb()), "recent_locations", { start: NOW - MIN, end: NOW });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ count: 0, total_available: 0, points: [] });
  });
});

describe("where_was_i_recently (nearest by time)", () => {
  function seeded() {
    const db = memDb();
    db.insertObservations(
      [obs(NOW - 140 * MIN, 10.1, 20.1), obs(NOW - 60 * MIN, 10.2, 20.2), obs(NOW - 10 * MIN, 10.3, 20.3)],
      NOW,
    );
    return db;
  }

  it("returns the nearest fix, gap and direction within tolerance", async () => {
    const c = await connect(seeded());
    const r = (await call(c, "where_was_i_recently", { timestamp: NOW - 55 * MIN, precision: "exact" })).structuredContent;
    expect(r).toMatchObject({ kind: "observation", match: "nearest_in_time", gap_seconds: 300, within_tolerance: true, gap_direction: "before" });
    expect(r.latitude).toBe(10.2);
    expect(r.observed_at).toBe(new Date(NOW - 60 * MIN).toISOString());
    const r2 = (await call(c, "where_was_i_recently", { timestamp: NOW - 62 * MIN })).structuredContent;
    expect(r2.gap_seconds).toBe(120);
    expect(r2.gap_direction).toBe("after");
  });

  it("reports match none when outside tolerance", async () => {
    const c = await connect(seeded());
    const r = (await call(c, "where_was_i_recently", { timestamp: NOW - 100 * MIN })).structuredContent;
    expect(r).toMatchObject({ kind: "status", match: "none", within_tolerance: false });
    expect(r.latitude).toBeUndefined();
    const wide = (await call(c, "where_was_i_recently", { timestamp: NOW - 100 * MIN, tolerance_minutes: 30 })).structuredContent;
    expect(wide.match).toBe("none");
    const wider = (await call(c, "where_was_i_recently", { timestamp: NOW - 100 * MIN, tolerance_minutes: 120 })).structuredContent;
    expect(wider.match).toBe("nearest_in_time");
  });

  it("handles no data and bad input", async () => {
    const c = await connect(memDb());
    expect((await call(c, "where_was_i_recently", { timestamp: "now" })).structuredContent).toMatchObject({ match: "none" });
    expect((await call(c, "where_was_i_recently", { timestamp: "garbage" })).isError).toBe(true);
  });
});

describe("movement_since", () => {
  it("computes distance on a known synthetic track", async () => {
    const db = memDb();
    const rows = seedTrack(db, 10);
    const expected = rows.slice(1).reduce((d, r, i) => d + haversineMeters({ lat: rows[i].lat, lng: rows[i].lng }, { lat: r.lat, lng: r.lng }), 0);
    expect(expected).toBeGreaterThan(9 * 111 - 1);
    expect(expected).toBeLessThan(9 * 111.3);
    const r = (await call(await connect(db), "movement_since", { timestamp: NOW - 60 * MIN, precision: "exact" })).structuredContent;
    expect(r).toMatchObject({ kind: "movement_summary", estimate: true, point_count: 10, duration_seconds: 9 * 60, semantics: "raw_point_observation" });
    expect(r.total_distance_meters).toBe(Math.round(expected));
    // straight line == path length on a meridian
    expect(r.straight_line_displacement_meters).toBe(r.total_distance_meters);
    expect(r.average_speed_mps).toBeCloseTo(expected / 540, 1);
    expect(r.bounding_box).toEqual({ min_latitude: 10, min_longitude: 20, max_latitude: 10.009, max_longitude: 20 });
    expect(r.points).toBeUndefined();
    expect(r.note).toMatch(/estimate/i);
  });

  it("displacement differs from path length on an out-and-back track", async () => {
    const db = memDb();
    db.insertObservations([obs(NOW - 30 * MIN, 10.0, 20.0), obs(NOW - 20 * MIN, 10.01, 20.0), obs(NOW - 10 * MIN, 10.0, 20.0)], NOW);
    const r = (await call(await connect(db), "movement_since", { timestamp: NOW - 60 * MIN })).structuredContent;
    expect(r.straight_line_displacement_meters).toBe(0);
    expect(r.total_distance_meters).toBeGreaterThan(2200);
    expect(r.total_distance_meters).toBeLessThan(2230);
  });

  it("honours precision for the bounding box, include_points and max_points", async () => {
    const db = memDb();
    seedTrack(db, 100);
    const c = await connect(db);
    const approx = (await call(c, "movement_since", { timestamp: NOW - 200 * MIN, include_points: true, max_points: 10 })).structuredContent;
    expect(approx.bounding_box.min_latitude).toBe(10);
    expect(approx.bounding_box.max_latitude).toBe(10.1);
    expect(approx.points).toHaveLength(10);
    expect(approx.points_truncated).toBe(true);
    const exact = (await call(c, "movement_since", { timestamp: NOW - 200 * MIN, precision: "exact" })).structuredContent;
    expect(exact.bounding_box.max_latitude).toBe(10.099);
    const sem = (await call(await connect(db, testConfig({ maxPrecision: "semantic" })), "movement_since", { timestamp: NOW - 200 * MIN, include_points: true })).structuredContent;
    expect(sem.bounding_box).toBeUndefined();
    expect(sem.points[0].latitude).toBeUndefined();
    expect(sem.total_distance_meters).toBeGreaterThan(0);
  });

  it("single point, empty window, future/too-old timestamps", async () => {
    const db = memDb();
    db.insertObservations([obs(NOW - 5 * MIN)], NOW);
    const c = await connect(db);
    const one = (await call(c, "movement_since", { timestamp: NOW - 60 * MIN })).structuredContent;
    expect(one).toMatchObject({ point_count: 1, total_distance_meters: 0, duration_seconds: 0, average_speed_mps: null });
    const none = (await call(c, "movement_since", { timestamp: NOW - MIN })).structuredContent;
    expect(none.point_count).toBe(0);
    expect((await call(c, "movement_since", { timestamp: NOW + 3600_000 })).isError).toBe(true);
    expect((await call(c, "movement_since", { timestamp: NOW - 40 * 86_400_000 })).isError).toBe(true);
  });
});

describe("location_status", () => {
  it("reports empty state", async () => {
    const s = (await call(await connect(memDb()), "location_status")).structuredContent;
    expect(s).toMatchObject({
      kind: "status",
      observation_count: 0,
      authenticated: null,
      auth_state: "unknown",
      consecutive_failures: 0,
      retention_days: 7,
      stale_threshold_seconds: 300,
      poll_interval_seconds: 60,
    });
  });

  it("reports poll health, auth state, backoff and observation freshness without coordinates", async () => {
    const db = memDb();
    seedTrack(db, 5);
    db.recordPollAttempt({ started_at_ms: NOW - 45_000, finished_at_ms: NOW - 44_000, ok: false, error_kind: "auth", observation_count: 0, backoff_ms: 900_000 });
    db.setMeta("auth_state", "expired");
    db.setMeta("consecutive_failures", 3);
    db.setMeta("last_error_kind", "auth");
    db.setMeta("current_backoff_ms", 900_000);
    db.setMeta("last_success_ms", NOW - 3600_000);
    const r = await call(await connect(db), "location_status");
    const s = r.structuredContent;
    expect(s).toMatchObject({
      authenticated: false,
      auth_state: "expired",
      consecutive_failures: 3,
      last_error_kind: "auth",
      current_backoff_seconds: 900,
      latest_poll_age_seconds: 45,
      latest_poll_ok: false,
      last_success_age_seconds: 3600,
      latest_observation_age_seconds: 120,
      observation_count: 5,
      stale: false,
    });
    expect(r.content[0].text).not.toMatch(/"latitude"|"longitude"|"lat"|"lng"/);
  });
});

describe("downsample helper (shared)", () => {
  it("never exceeds max and keeps ends", () => {
    const a = Array.from({ length: 1000 }, (_, i) => i);
    for (const m of [1, 2, 3, 10, 999]) {
      const d = downsample(a, m);
      expect(d.length).toBeLessThanOrEqual(m);
    }
    const d = downsample(a, 10);
    expect(d[0]).toBe(0);
    expect(d.at(-1)).toBe(999);
  });
});
