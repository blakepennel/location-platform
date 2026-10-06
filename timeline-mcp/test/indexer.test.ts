import { existsSync } from "node:fs";
import { utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openIndexDb, getMeta, type Database } from "../src/db.ts";
import {
  ImportRejectedError,
  importExport,
  normalizeSegment,
  parseCoord,
  parseSegmentTime,
  tableCounts,
} from "../src/indexer.ts";
import { ExportFormatError, ExportMissingError, TimelineSyncFileSource, parseExportDocument } from "../src/source.ts";
import {
  CAFE,
  HOME,
  OFFICE,
  STANDARD_COUNTS,
  activity,
  exportData,
  fileBackedManager,
  pathSeg,
  standardDataset,
  tmpDir,
  trip,
  visit,
  writeExportFile,
  writeSyncStatus,
} from "./helpers/synthetic.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
const fresh = (): Database => {
  const db = openIndexDb(":memory:");
  cleanups.push(() => db.close());
  return db;
};
const count = (db: Database, sql: string) => (db.prepare(sql).get() as { n: number }).n;

describe("import", () => {
  it("imports the standard synthetic dataset with provenance", () => {
    const db = fresh();
    const r = importExport(db, exportData(standardDataset(), { path: "synthetic://a" }));
    expect(r.status).toBe("imported");
    expect(r.totals).toEqual(STANDARD_COUNTS);
    expect(r.skipped).toBe(0);
    expect(r.added).toBe(STANDARD_COUNTS.visit + STANDARD_COUNTS.activity + STANDARD_COUNTS.timeline_path + STANDARD_COUNTS.trip);
    const imp = db.prepare("SELECT * FROM imports").all() as any[];
    expect(imp).toHaveLength(1);
    expect(imp[0]).toMatchObject({ generator: "timeline-sync", upstream_commit: "0000000synthetic", adapter: "synthetic", source_path: "synthetic://a" });
    expect(count(db, `SELECT COUNT(*) AS n FROM visits WHERE import_id = ${imp[0].id}`)).toBe(STANDARD_COUNTS.visit);
    // place aggregates
    const home = db.prepare("SELECT * FROM places WHERE place_id = ?").get(HOME.placeId) as any;
    expect(home.visit_count).toBe(3); // home-1, home-2, dst-home
    expect(home.name).toBe("Synthetic Home");
    expect(home.semantic_type).toBe("HOME");
    const cafe = db.prepare("SELECT * FROM places WHERE place_id = ?").get(CAFE.placeId) as any;
    expect(cafe).toMatchObject({ visit_count: 2, category: "cafe", address: CAFE.address });
    // place with only coordinates gets a synthetic key
    expect(count(db, "SELECT COUNT(*) AS n FROM places WHERE place_key LIKE 'loc_%'")).toBe(1);
    // feature-id-only place keyed by feature id
    expect(count(db, "SELECT COUNT(*) AS n FROM places WHERE place_key LIKE '0xb0b0%'")).toBe(1);
  });

  it("importing the same export twice is a no-op with identical counts and no duplicates", () => {
    const db = fresh();
    const exp = exportData(standardDataset());
    importExport(db, exp);
    const before = tableCounts(db);
    const second = importExport(db, exp);
    expect(second.status).toBe("unchanged");
    expect(tableCounts(db)).toEqual(before);
    expect(count(db, "SELECT COUNT(*) AS n FROM imports")).toBe(1);

    // even when forced (or when the file is byte-different but semantically identical) nothing is added/updated
    const forced = importExport(db, exp, { force: true });
    expect(forced.status).toBe("imported");
    expect(forced.added + forced.updated + forced.removed).toBe(0);
    expect(forced.unchanged).toBe(before.visit + before.activity + before.timeline_path + before.trip);
    const rewrapped = importExport(db, exportData(standardDataset(), { salt: "different bytes" }));
    expect(rewrapped.added + rewrapped.updated + rewrapped.removed).toBe(0);
    expect(tableCounts(db)).toEqual(before);
    expect(count(db, "SELECT COUNT(*) AS n FROM (SELECT segment_id FROM visits GROUP BY segment_id HAVING COUNT(*) > 1)")).toBe(0);
  });

  it("re-import with a modified segment updates it in place", () => {
    const db = fresh();
    importExport(db, exportData(standardDataset()));
    const first = db.prepare("SELECT * FROM visits WHERE segment_id = 'seg-v-office-1'").get() as any;

    const segs = standardDataset();
    const idx = segs.findIndex((s) => s.segmentId === "seg-v-office-1");
    segs[idx] = visit({ id: "seg-v-office-1", start: "2025-01-02T09:00:00.000+02:00", end: "2025-01-02T16:00:00.000+02:00", place: OFFICE });
    const r = importExport(db, exportData(segs, { salt: "v2" }));
    expect(r.updated).toBe(1);
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
    const after = db.prepare("SELECT * FROM visits WHERE segment_id = 'seg-v-office-1'").get() as any;
    expect(after.end_ms).toBe(Date.parse("2025-01-02T16:00:00+02:00"));
    expect(after.end_ms).toBeLessThan(first.end_ms);
    expect(after.import_id).toBeGreaterThan(first.import_id);
    expect(tableCounts(db)).toEqual(STANDARD_COUNTS);
  });

  it("removes segments that disappeared from a newer full export, and orphaned places", () => {
    const db = fresh();
    importExport(db, exportData(standardDataset()));
    const segs = standardDataset().filter((s) => s.segmentId !== "seg-v-hotel" && s.segmentId !== "seg-a-fly" && s.segmentId !== "seg-t-1");
    const r = importExport(db, exportData(segs, { salt: "v2" }));
    expect(r.removed).toBe(3);
    expect(r.by_kind.visit.removed).toBe(1);
    expect(r.by_kind.activity.removed).toBe(1);
    expect(r.by_kind.trip.removed).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM visits WHERE segment_id = 'seg-v-hotel'")).toBe(0);
    expect(count(db, `SELECT COUNT(*) AS n FROM places WHERE place_id = '${"ChIJSyntheticHotel0000000"}'`)).toBe(0);
    expect(tableCounts(db)).toEqual({ ...STANDARD_COUNTS, visit: STANDARD_COUNTS.visit - 1, activity: STANDARD_COUNTS.activity - 1, trip: 0, place: STANDARD_COUNTS.place - 1 });
  });

  it("changes a visit's place and rebuilds place aggregates", () => {
    const db = fresh();
    importExport(db, exportData(standardDataset()));
    const segs = standardDataset();
    const i = segs.findIndex((s) => s.segmentId === "seg-v-cafe-2");
    segs[i] = visit({ id: "seg-v-cafe-2", start: "2025-01-03T12:10:00.000+02:00", end: "2025-01-03T13:00:00.000+02:00", place: OFFICE });
    importExport(db, exportData(segs, { salt: "v2" }));
    expect((db.prepare("SELECT visit_count AS n FROM places WHERE place_id = ?").get(CAFE.placeId) as any).n).toBe(1);
    expect((db.prepare("SELECT visit_count AS n FROM places WHERE place_id = ?").get(OFFICE.placeId) as any).n).toBe(5);
  });
});

describe("malformed data", () => {
  it("rejects non-JSON and wrong top-level shapes without touching the index", async () => {
    expect(() => parseExportDocument("this is not json")).toThrow(ExportFormatError);
    expect(() => parseExportDocument("[]")).toThrow(ExportFormatError);
    expect(() => parseExportDocument('{"segments": []}')).toThrow(ExportFormatError);
    expect(() => parseExportDocument('{"semanticSegments": {}}')).toThrow(ExportFormatError);
    expect(() => importExport(fresh(), { segments: "nope" as any, sourcePath: "x", sha256: "s" })).toThrow(ExportFormatError);

    const t = tmpDir();
    cleanups.push(t.cleanup);
    const src = new TimelineSyncFileSource({ dataDir: t.dir });
    await expect(src.readExport()).rejects.toThrow(ExportMissingError);
    writeExportFile(t.dir, "not json at all");
    await expect(src.readExport()).rejects.toThrow(ExportFormatError);
    writeExportFile(t.dir, JSON.stringify({ hello: "world" }));
    await expect(src.readExport()).rejects.toThrow(/semanticSegments/);
  });

  it("skips and counts malformed segments while importing the good ones", () => {
    const db = fresh();
    const good = [
      visit({ id: "g1", start: "2025-01-02T09:00:00.000+02:00", end: "2025-01-02T10:00:00.000+02:00", place: OFFICE }),
      activity({ id: "g2", start: "2025-01-02T10:00:00.000+02:00", end: "2025-01-02T10:10:00.000+02:00", from: OFFICE, to: HOME, meters: 10, mode: "walking" }),
    ];
    const bad: unknown[] = [
      { startTime: "yesterday-ish", endTime: "2025-01-02T10:00:00+02:00", visit: {} }, // bad time
      { startTime: "2025-02-30T10:00:00+02:00", endTime: "2025-03-01T10:00:00+02:00", visit: {} }, // impossible date
      { startTime: "2025-01-02T11:00:00+02:00", endTime: "2025-01-02T10:00:00+02:00", visit: {} }, // end < start
      { startTime: "2025-01-02T11:00:00+02:00", endTime: "2025-01-02T12:00:00+02:00", something: {} }, // no kind
      { startTime: "2025-01-02T11:00:00+02:00", endTime: "2025-01-02T12:00:00+02:00", visit: { topCandidate: { placeId: "p", placeLocation: { latLng: "not coordinates" } } } },
      { startTime: "2025-01-02T11:00:00+02:00", endTime: "2025-01-02T12:00:00+02:00", visit: "a string" }, // bad shape
      { startTime: "2025-01-02T11:00:00+02:00", endTime: "2025-01-02T12:00:00+02:00", timelinePath: [{ point: "91.0°, 20.0°" }] }, // out-of-range lat
      null,
      "junk",
      42,
    ];
    const r = importExport(db, exportData([...good.slice(0, 1), ...bad, ...good.slice(1)]));
    expect(r.status).toBe("imported");
    expect(r.valid).toBe(2);
    expect(r.skipped).toBe(bad.length);
    expect(r.errors).toMatchObject({ bad_time: 2, end_before_start: 1, missing_kind: 1, bad_coords: 2, bad_shape: 1, not_an_object: 3 });
    expect(tableCounts(db)).toMatchObject({ visit: 1, activity: 1 });
    const meta = db.prepare("SELECT skipped, errors_json FROM imports").get() as any;
    expect(meta.skipped).toBe(bad.length);
    expect(JSON.parse(meta.errors_json).reasons.bad_time).toBe(2);
  });

  it("refuses to wipe a populated index with an export that has no valid segments", () => {
    const db = fresh();
    importExport(db, exportData(standardDataset()));
    expect(() => importExport(db, exportData([], { salt: "empty" }))).toThrow(ImportRejectedError);
    expect(() => importExport(db, exportData([{ junk: true }], { salt: "junk" }))).toThrow(ImportRejectedError);
    expect(tableCounts(db)).toEqual(STANDARD_COUNTS);
    // explicit override is allowed
    importExport(db, exportData([], { salt: "empty" }), { allowEmpty: true });
    expect(tableCounts(db).visit).toBe(0);
  });

  it("rolls the whole import back if something fails mid-transaction", () => {
    const db = fresh();
    importExport(db, exportData(standardDataset()));
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON activities BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    const segs = [...standardDataset(), activity({ id: "new-one", start: "2025-02-01T10:00:00Z", end: "2025-02-01T10:10:00Z", mode: "walking" })];
    segs[0] = visit({ id: "seg-v-home-1", start: "2025-01-02T00:00:00.000+02:00", end: "2025-01-02T01:00:00.000+02:00", place: HOME });
    expect(() => importExport(db, exportData(segs, { salt: "boom" }))).toThrow(/boom/);
    expect(tableCounts(db)).toEqual(STANDARD_COUNTS);
    expect((db.prepare("SELECT end_ms FROM visits WHERE segment_id = 'seg-v-home-1'").get() as any).end_ms).toBe(Date.parse("2025-01-02T08:30:00+02:00"));
  });
});

describe("time zones", () => {
  it("parses timestamps keeping their own offset (+02:00, -05:00, Z, fractional, offset field fallback)", () => {
    expect(parseSegmentTime("2025-01-02T14:01:06.171+02:00")).toEqual({ ms: Date.parse("2025-01-02T12:01:06.171Z"), offsetMin: 120 });
    expect(parseSegmentTime("2025-01-10T09:00:00.000-05:00")).toEqual({ ms: Date.parse("2025-01-10T14:00:00.000Z"), offsetMin: -300 });
    expect(parseSegmentTime("2025-01-10T09:00:00Z")).toEqual({ ms: Date.parse("2025-01-10T09:00:00Z"), offsetMin: 0 });
    expect(parseSegmentTime("2025-01-02T14:01:06.123456+05:30")?.offsetMin).toBe(330);
    expect(parseSegmentTime("2025-01-02T14:00:00", 60)).toEqual({ ms: Date.parse("2025-01-02T13:00:00Z"), offsetMin: 60 });
    expect(parseSegmentTime("2025-13-02T14:00:00Z")).toBeNull();
    expect(parseSegmentTime(12345 as any)).toBeNull();
  });

  it("stores instants and offsets correctly for positive and negative offsets", () => {
    const db = fresh();
    importExport(db, exportData(standardDataset()));
    const east = db.prepare("SELECT * FROM visits WHERE segment_id = 'seg-v-office-1'").get() as any;
    expect(east.start_ms).toBe(Date.parse("2025-01-02T07:00:00Z"));
    expect(east.start_offset_min).toBe(120);
    expect(east.start_iso).toBe("2025-01-02T09:00:00+02:00");
    const west = db.prepare("SELECT * FROM visits WHERE segment_id = 'seg-v-lounge'").get() as any;
    expect(west.start_ms).toBe(Date.parse("2025-01-10T14:00:00Z"));
    expect(west.start_offset_min).toBe(-300);
    expect(west.start_iso).toBe("2025-01-10T09:00:00-05:00");
    // a visit spanning a DST change keeps different start/end offsets
    const dst = db.prepare("SELECT * FROM visits WHERE segment_id = 'seg-v-dst-home'").get() as any;
    expect([dst.start_offset_min, dst.end_offset_min]).toEqual([-300, -240]);
    expect(dst.end_ms - dst.start_ms).toBe(8 * 3600_000);
  });

  it("tolerates the mojibake degree sign and object coordinates", () => {
    expect(parseCoord("12.3456789Â°, -98.7654321Â°")).toEqual({ lat: 12.3456789, lng: -98.7654321 });
    expect(parseCoord("-10.5°, 20.25°")).toEqual({ lat: -10.5, lng: 20.25 });
    expect(parseCoord({ latitude: 10.5, longitude: 20.5 })).toEqual({ lat: 10.5, lng: 20.5 });
    expect(parseCoord("nope")).toBeNull();
  });
});

describe("segment ids", () => {
  const noIds = () => [
    visit({ start: "2025-01-02T09:00:00.000+02:00", end: "2025-01-02T10:00:00.000+02:00", place: OFFICE }),
    activity({ start: "2025-01-02T10:00:00.000+02:00", end: "2025-01-02T10:20:00.000+02:00", from: OFFICE, to: CAFE, meters: 100, mode: "walking" }),
    pathSeg({ start: "2025-01-02T10:00:00.000+02:00", end: "2025-01-02T11:00:00.000+02:00", points: [{ pt: { lat: 10.7, lng: 20.7 }, min: 3 }] }),
    trip({ start: "2025-01-02T00:00:00.000+02:00", end: "2025-01-04T00:00:00.000+02:00", name: "trip_x" }),
  ];

  it("derives deterministic ids when segmentId is missing, so re-import is idempotent", () => {
    const db = fresh();
    importExport(db, exportData(noIds()));
    const ids1 = (db.prepare("SELECT segment_id FROM visits UNION ALL SELECT segment_id FROM activities UNION ALL SELECT segment_id FROM timeline_paths UNION ALL SELECT segment_id FROM trips ORDER BY 1").all() as any[]).map((r) => r.segment_id);
    expect(new Set(ids1).size).toBe(4);
    expect(ids1.every((i) => /^d-[0-9a-f]{32}$/.test(i))).toBe(true);

    const reordered = noIds().reverse();
    const r = importExport(db, exportData(reordered, { salt: "reordered" }));
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
    expect(r.updated).toBe(0);
    const ids2 = (db.prepare("SELECT segment_id FROM visits UNION ALL SELECT segment_id FROM activities UNION ALL SELECT segment_id FROM timeline_paths UNION ALL SELECT segment_id FROM trips ORDER BY 1").all() as any[]).map((r) => r.segment_id);
    expect(ids2).toEqual(ids1);
  });

  it("derived ids depend on kind, times and place, and survive re-formatting the timestamp", () => {
    const a = normalizeSegment(visit({ start: "2025-01-02T09:00:00.000+02:00", end: "2025-01-02T10:00:00.000+02:00", place: OFFICE }));
    const sameInstant = normalizeSegment(visit({ start: "2025-01-02T07:00:00Z", end: "2025-01-02T08:00:00Z", place: OFFICE }));
    const otherPlace = normalizeSegment(visit({ start: "2025-01-02T09:00:00.000+02:00", end: "2025-01-02T10:00:00.000+02:00", place: CAFE }));
    const otherTime = normalizeSegment(visit({ start: "2025-01-02T09:00:01.000+02:00", end: "2025-01-02T10:00:00.000+02:00", place: OFFICE }));
    if (!a.ok || !sameInstant.ok || !otherPlace.ok || !otherTime.ok) throw new Error("expected ok");
    expect(sameInstant.seg.segmentId).toBe(a.seg.segmentId);
    expect(otherPlace.seg.segmentId).not.toBe(a.seg.segmentId);
    expect(otherTime.seg.segmentId).not.toBe(a.seg.segmentId);
  });
});

describe("file source + auto reindex", () => {
  it("reads current/Timeline.json and state/sync-status.json", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const f = writeExportFile(t.dir, standardDataset());
    writeSyncStatus(t.dir, { schema_version: 1, source: "google_timeline", adapter: "synthetic", last_attempt_at: "2025-03-11T00:00:00Z", consecutive_failures: 0, auth: { state: "ok" } });
    const src = new TimelineSyncFileSource({ dataDir: t.dir });
    const exp = await src.readExport();
    expect(exp.sourcePath).toBe(f);
    expect(exp.segments).toHaveLength(standardDataset().length);
    expect(exp.exportMeta?.generator).toBe("timeline-sync");
    expect(exp.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await src.readSyncStatus())?.auth?.state).toBe("ok");
    expect(await src.fingerprint()).toMatch(/^\d+:\d+$/);
    expect(await new TimelineSyncFileSource({ dataDir: join(t.dir, "nope") }).readSyncStatus()).toBeNull();
  });

  it("reindexes on start, throttles checks to 60 s, and picks up a changed file", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const file = writeExportFile(t.dir, standardDataset());
    let now = Date.parse("2025-03-11T12:00:00Z");
    const { db, index } = fileBackedManager(t.dir, () => now);

    const first = await index.ensureFresh({ force: true });
    expect(first.status).toBe("imported");
    expect(tableCounts(db).visit).toBe(STANDARD_COUNTS.visit);

    // within 60 s: skipped, even though the file changed
    const extra = [...standardDataset(), visit({ id: "seg-new", start: "2025-03-11T09:00:00Z", end: "2025-03-11T10:00:00Z", place: CAFE })];
    writeExportFile(t.dir, extra);
    now += 30_000;
    expect((await index.ensureFresh()).status).toBe("skipped");
    expect(tableCounts(db).visit).toBe(STANDARD_COUNTS.visit);

    // after 60 s: the changed mtime/size is noticed
    now += 31_000;
    const second = await index.ensureFresh();
    expect(second.status).toBe("imported");
    expect(second.result?.added).toBe(1);
    expect(tableCounts(db).visit).toBe(STANDARD_COUNTS.visit + 1);

    // unchanged file: fingerprint matches -> nothing parsed
    now += 61_000;
    expect((await index.ensureFresh()).status).toBe("unchanged");

    // touching the file without changing content: fingerprint differs, sha does not -> no-op import
    const later = new Date(now + 5000);
    utimesSync(file, later, later);
    now += 61_000;
    const touched = await index.ensureFresh();
    expect(touched.status).toBe("unchanged");
    expect(getMeta(db, "last_import_sha256")).toBeTruthy();
  });

  it("keeps the old index and records a sanitized error when the new export is corrupt", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    writeExportFile(t.dir, standardDataset());
    let now = Date.parse("2025-03-11T12:00:00Z");
    const { db, index } = fileBackedManager(t.dir, () => now);
    await index.ensureFresh({ force: true });
    writeExportFile(t.dir, "{ this is truncated");
    now += 61_000;
    const r = await index.ensureFresh();
    expect(r.status).toBe("failed");
    expect(tableCounts(db)).toEqual(STANDARD_COUNTS);
    expect(JSON.parse(getMeta(db, "last_import_error")!).message).toMatch(/not valid JSON/);
    // the bad file is not re-parsed every minute
    now += 61_000;
    expect((await index.ensureFresh()).status).toBe("unchanged");
    // a good file heals it
    writeExportFile(t.dir, [...standardDataset(), visit({ id: "seg-heal", start: "2025-03-12T09:00:00Z", end: "2025-03-12T10:00:00Z", place: CAFE })]);
    now += 61_000;
    expect((await index.ensureFresh()).status).toBe("imported");
    expect(getMeta(db, "last_import_error")).toBeNull();
  });

  it("caches sync-status into the index metadata", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    writeExportFile(t.dir, standardDataset());
    writeSyncStatus(t.dir, { schema_version: 1, source: "google_timeline", adapter: "synthetic", last_attempt_at: "2025-03-11T00:00:00Z", last_success_at: "2025-03-11T00:00:00Z", consecutive_failures: 0, auth: { state: "ok" } });
    const { db, index } = fileBackedManager(t.dir);
    await index.ensureFresh({ force: true });
    expect(JSON.parse(getMeta(db, "sync_status")!).last_success_at).toBe("2025-03-11T00:00:00Z");
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "Timeline.synthetic.json");
describe.skipIf(!existsSync(fixture))("shared synthetic fixture", () => {
  it("indexes test/fixtures/Timeline.synthetic.json", async () => {
    const db = fresh();
    const src = new TimelineSyncFileSource({ dataDir: here, file: fixture });
    const exp = await src.readExport();
    const r = importExport(db, exp);
    expect(r.status).toBe("imported");
    expect(r.valid).toBeGreaterThan(0);
    expect(r.valid + r.skipped).toBe(exp.segments.length);
    // idempotent
    expect(importExport(db, exp).status).toBe("unchanged");
  });
});
