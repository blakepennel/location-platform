import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "@location/shared";
import { LiveDb, isStale, retentionCutoffMs } from "../src/db.ts";
import { assertLiveDbPath, loadConfig } from "../src/config.ts";
import { prune, simulate } from "../src/ops.ts";
import { PERSON, memDb, obs, testConfig } from "./helpers.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 20, 12, 0, 0);

describe("observations", () => {
  it("inserts observations with iso timestamps and optional fields", () => {
    const db = memDb();
    const r = db.insertObservations([obs(NOW - 1000, 10.1, 20.2, { address: "x", country: "ZZ", battery_level: 50, battery_charging: true })], NOW);
    expect(r).toEqual({ inserted: 1, duplicates: 0 });
    const row = db.latest()!;
    expect(row.observed_at_iso).toBe(new Date(NOW - 1000).toISOString());
    expect(row.polled_at_iso).toBe(new Date(NOW).toISOString());
    expect(row.lat).toBe(10.1);
    expect(row.lng).toBe(20.2);
    expect(row.battery_charging).toBe(1);
    expect(row.dedup_key).toBe(`${PERSON}|${NOW - 1000}`);
  });

  it("does not double-insert the same person + source timestamp (re-polling the same fix)", () => {
    const db = memDb();
    expect(db.insertObservations([obs(NOW)], NOW).inserted).toBe(1);
    const again = db.insertObservations([obs(NOW)], NOW + 60_000);
    expect(again).toEqual({ inserted: 0, duplicates: 1 });
    expect(db.count()).toBe(1);
    // the first poll's polled_at is preserved
    expect(db.latest()!.polled_at_ms).toBe(NOW);
  });

  it("treats a different person at the same timestamp as distinct", () => {
    const db = memDb();
    db.insertObservations([obs(NOW), { ...obs(NOW), person_id: "other" }], NOW);
    expect(db.count()).toBe(2);
    expect(db.count("other")).toBe(1);
  });

  it("dedups within a single batch too", () => {
    const db = memDb();
    expect(db.insertObservations([obs(NOW), obs(NOW)], NOW)).toEqual({ inserted: 1, duplicates: 1 });
  });

  it("stale computation: older than the threshold at read time", () => {
    expect(isStale(NOW - 299_000, NOW, 300)).toBe(false);
    expect(isStale(NOW - 300_000, NOW, 300)).toBe(false);
    expect(isStale(NOW - 301_000, NOW, 300)).toBe(true);
    const db = memDb();
    // fix that was already 10 minutes old when polled → recorded as stale-at-poll
    db.insertObservations([obs(NOW - 600_000)], NOW, 300);
    expect(db.latest()!.is_stale).toBe(1);
    db.insertObservations([obs(NOW - 1_000)], NOW, 300);
    expect(db.latest()!.is_stale).toBe(0);
  });

  it("refuses to adopt a database that has foreign tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "live-db-"));
    try {
      const p = join(dir, "other.sqlite");
      const other = openDatabase(p);
      other.exec("CREATE TABLE segments (id INTEGER)");
      other.close();
      expect(() => new LiveDb(p)).toThrow(/do not belong/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists to a file and reopens with data intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "live-db-"));
    try {
      const p = join(dir, "live.sqlite");
      const a = new LiveDb(p);
      a.insertObservations([obs(NOW)], NOW);
      a.close();
      const b = new LiveDb(p);
      expect(b.count()).toBe(1);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses Timeline-looking database paths", () => {
    expect(() => assertLiveDbPath("/home/u/.location-platform/timeline/timeline.sqlite")).toThrow(/Timeline/);
    expect(() => assertLiveDbPath("/home/u/data/timeline-index.db")).toThrow(/Timeline/);
    expect(() => loadConfig({ LIVE_MCP_DB: "/x/timeline/live.sqlite" } as NodeJS.ProcessEnv)).toThrow(/Timeline/);
    expect(assertLiveDbPath(":memory:")).toBe(":memory:");
    expect(loadConfig({} as NodeJS.ProcessEnv).dbPath).toMatch(/live-location/);
  });
});

describe("queries", () => {
  it("nearest picks the closest fix by time (ties -> earlier), across the boundaries", () => {
    const db = memDb();
    db.insertObservations([obs(1_000_000), obs(1_100_000), obs(1_500_000)], NOW);
    expect(db.nearest(1_040_000)!.source_ts_ms).toBe(1_000_000);
    expect(db.nearest(1_060_000)!.source_ts_ms).toBe(1_100_000);
    expect(db.nearest(1_050_000)!.source_ts_ms).toBe(1_000_000); // tie -> earlier
    expect(db.nearest(1_100_000)!.source_ts_ms).toBe(1_100_000); // exact
    expect(db.nearest(0)!.source_ts_ms).toBe(1_000_000); // before all
    expect(db.nearest(9_999_999)!.source_ts_ms).toBe(1_500_000); // after all
    expect(memDb().nearest(5)).toBeNull();
  });

  it("range is inclusive, chronological and person-filterable", () => {
    const db = memDb();
    db.insertObservations([obs(300), obs(100), obs(200), { ...obs(250), person_id: "z" }], NOW);
    expect(db.range(100, 300).map((r) => r.source_ts_ms)).toEqual([100, 200, 250, 300]);
    expect(db.range(100, 300, PERSON).map((r) => r.source_ts_ms)).toEqual([100, 200, 300]);
    expect(db.countRange(150, 260)).toBe(2);
  });
});

describe("retention", () => {
  function seeded() {
    const db = memDb();
    // ages in days: 10, 8, 7.5, 6.9, 3, 0
    const ages = [10, 8, 7.5, 6.9, 3, 0];
    db.insertObservations(ages.map((d) => obs(NOW - d * DAY)), NOW);
    return db;
  }

  it("cutoff arithmetic", () => {
    expect(retentionCutoffMs(NOW, 7)).toBe(NOW - 7 * DAY);
    expect(() => retentionCutoffMs(NOW, 0)).toThrow();
    expect(() => retentionCutoffMs(NOW, -1)).toThrow();
    expect(() => retentionCutoffMs(NOW, Number.NaN)).toThrow();
  });

  it("selects exactly the rows older than N days (strictly)", () => {
    const db = seeded();
    const cutoff = retentionCutoffMs(NOW, 7);
    expect(db.countOlderThan(cutoff)).toBe(3);
    const ids = db.selectOlderThan(cutoff);
    expect(ids).toHaveLength(3);
    const ages = db.range(0, NOW * 2).map((r) => (NOW - r.source_ts_ms) / DAY);
    // rows are chronological: 10, 8, 7.5 are the expired ones
    expect(ages.slice(0, 3)).toEqual([10, 8, 7.5]);
    // a row exactly at the cutoff is kept
    db.insertObservations([obs(cutoff)], NOW);
    expect(db.countOlderThan(cutoff)).toBe(3);
    expect(db.countOlderThan(retentionCutoffMs(NOW, 1))).toBe(6);
  });

  it("prune dry-run deletes nothing and reports the count", () => {
    const db = seeded();
    const cfg = testConfig({ retentionDays: 7 });
    const r = prune(db, cfg, { now: NOW });
    expect(r).toMatchObject({ dry_run: true, would_delete: 3, total_before: 6 });
    expect(r.deleted).toBeUndefined();
    expect(db.count()).toBe(6);
  });

  it("prune --yes deletes only expired rows", () => {
    const db = seeded();
    db.recordPollAttempt({ started_at_ms: NOW - 9 * DAY, finished_at_ms: NOW - 9 * DAY, ok: true, observation_count: 1 });
    db.recordPollAttempt({ started_at_ms: NOW - 1 * DAY, finished_at_ms: NOW - 1 * DAY, ok: true, observation_count: 1 });
    const r = prune(db, testConfig({ retentionDays: 7 }), { yes: true, now: NOW });
    expect(r).toMatchObject({ dry_run: false, would_delete: 3, remaining: 3 });
    expect(r.deleted).toEqual({ observations: 3, poll_attempts: 1 });
    const left = db.range(0, NOW * 2).map((x) => Math.round((NOW - x.source_ts_ms) / DAY));
    expect(left).toEqual([7, 3, 0]); // 6.9 rounds to 7
    expect(db.latestPollAttempt()).not.toBeNull();
  });

  it("LIVE_PRUNE_CONFIRM=true acts like --yes", () => {
    const db = seeded();
    const cfg = loadConfig({ LIVE_PRUNE_CONFIRM: "true" } as NodeJS.ProcessEnv, { dbPath: ":memory:" });
    expect(prune(db, cfg, { now: NOW }).dry_run).toBe(false);
    expect(db.count()).toBe(3);
  });

  it("a tighter retention window deletes more, never the newest", () => {
    const db = seeded();
    prune(db, testConfig({ retentionDays: 1 }), { yes: true, now: NOW });
    expect(db.count()).toBe(1);
    expect(db.latest()!.source_ts_ms).toBe(NOW);
  });

  it("config rejects retention < 1 day", () => {
    expect(() => loadConfig({ LIVE_RETENTION_DAYS: "0" } as NodeJS.ProcessEnv)).toThrow();
  });
});

describe("simulate", () => {
  it("inserts N synthetic observations ending now and refuses to mix into a real database", () => {
    const db = memDb();
    const cfg = testConfig();
    const r = simulate(db, cfg, 20, NOW);
    expect(r.inserted).toBe(20);
    expect(db.count()).toBe(20);
    expect(db.latest()!.source_ts_ms).toBe(NOW);
    const real = memDb();
    real.insertObservations([{ ...obs(NOW), person_id: "1234567890" }], NOW);
    expect(() => simulate(real, cfg, 5, NOW)).toThrow(/real observations/);
    expect(() => simulate(memDb(), cfg, 0)).toThrow();
  });
});
