/**
 * Programmatic SYNTHETIC fixtures. All coordinates are near lat 10.x / lng 20.x and all place
 * names are fake ("Synthetic Cafe" ...). Never put real places or coordinates in tests.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@location/shared";
import { loadConfig, type Config } from "../../src/config.ts";
import { openIndexDb, type Database } from "../../src/db.ts";
import { IndexManager, importExport } from "../../src/indexer.ts";
import type { ExportData, ExportMeta, RawSegment } from "../../src/source.ts";
import { TimelineSyncFileSource } from "../../src/source.ts";
import { createHash } from "node:crypto";

export const silentLogger = createLogger("test", () => {});

export interface Pt {
  lat: number;
  lng: number;
}
const ll = (p: Pt) => `${p.lat.toFixed(7)}°, ${p.lng.toFixed(7)}°`;

/* ---------------------------------------------------------------- places */
export const HOME = { placeId: "ChIJSyntheticHome000000000", featureId: "0x1010101010101010:0x2020202020202020", name: "Synthetic Home", lat: 10.104567, lng: 20.105678, type: "HOME", code: 1 };
export const OFFICE = { placeId: "ChIJSyntheticOffice0000000", featureId: "0x3030303030303030:0x4040404040404040", name: "Synthetic Office", lat: 10.204567, lng: 20.205678, type: "WORK", code: 2 };
export const CAFE = {
  placeId: "ChIJSyntheticCafe00000000",
  featureId: "0x5050505050505050:0x6060606060606060",
  name: "Synthetic Cafe",
  address: "1 Synthetic Street, Testville",
  category: "cafe",
  lat: 10.304567,
  lng: 20.305678,
  type: "UNKNOWN",
  code: 0,
};
export const HOTEL = { placeId: "ChIJSyntheticHotel0000000", featureId: "0x7070707070707070:0x8080808080808080", name: "Synthetic Lakeside Hotel", lat: 10.904567, lng: 20.905678, type: "UNKNOWN", code: 0 };
export const MUSEUM = { placeId: "ChIJSyntheticMuseum000000", featureId: "0x9090909090909090:0xa0a0a0a0a0a0a0a0", name: "Synthetic Museum", lat: 10.914567, lng: 20.915678, type: "UNKNOWN", code: 0 };
export const LOUNGE = { featureId: "0xb0b0b0b0b0b0b0b0:0xc0c0c0c0c0c0c0c0", name: "Synthetic Airport Lounge", lat: 10.404567, lng: 20.405678, type: "UNKNOWN", code: 0 };

type PlaceDef = { placeId?: string; featureId?: string; name?: string; address?: string; category?: string; lat: number; lng: number; type?: string; code?: number };

/* ---------------------------------------------------------------- segment builders */
export interface VisitOpts {
  id?: string;
  start: string;
  end: string;
  place?: PlaceDef;
  prob?: number;
  candProb?: number;
  confirmed?: boolean;
  /** omit name/address/category enrichment */
  bare?: boolean;
  offsetMin?: number;
}

function offsetOf(iso: string): number | undefined {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  return m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) : undefined;
}

export function visit(o: VisitOpts): RawSegment {
  const p = o.place;
  const tc: Record<string, unknown> = {};
  if (p) {
    tc.placeLocation = { latLng: ll(p) };
    if (p.type !== undefined) {
      tc.semanticType = p.type;
      tc.semanticTypeCode = p.code ?? 0;
    }
    tc.placeTypeCode = 100;
    tc.probability = o.candProb ?? 0.7;
    if (p.placeId) {
      tc.placeId = p.placeId;
      tc.placeUrl = `https://www.google.com/maps/place/?q=place_id:${p.placeId}`;
    }
    if (p.featureId) tc.featureId = p.featureId;
    if (!o.bare) {
      if (p.name) tc.placeName = p.name;
      if (p.address) tc.placeAddress = p.address;
      if (p.category) tc.placeCategory = p.category;
    }
  }
  const seg: RawSegment = {
    startTime: o.start,
    endTime: o.end,
    startTimeTimezoneUtcOffsetMinutes: offsetOf(o.start),
    endTimeTimezoneUtcOffsetMinutes: offsetOf(o.end),
    visit: { probability: o.prob ?? 0.85, ...(o.confirmed ? { isConfirmed: true } : {}), ...(p ? { topCandidate: tc } : {}) },
  };
  if (o.id) {
    seg.segmentId = o.id;
    seg.segmentType = 1;
  }
  return seg;
}

export interface ActivityOpts {
  id?: string;
  start: string;
  end: string;
  from?: Pt;
  to?: Pt;
  meters?: number;
  mode?: string;
  code?: number;
  prob?: number;
}

export function activity(o: ActivityOpts): RawSegment {
  const a: Record<string, unknown> = {};
  if (o.from) a.start = { latLng: ll(o.from) };
  if (o.to) a.end = { latLng: ll(o.to) };
  if (o.meters !== undefined) a.distanceMeters = o.meters;
  if (o.mode) a.topCandidate = { type: o.mode, typeCode: o.code ?? 2, probability: o.prob ?? 0.9 };
  const seg: RawSegment = {
    startTime: o.start,
    endTime: o.end,
    startTimeTimezoneUtcOffsetMinutes: offsetOf(o.start),
    endTimeTimezoneUtcOffsetMinutes: offsetOf(o.end),
    activity: a,
  };
  if (o.id) {
    seg.segmentId = o.id;
    seg.segmentType = 2;
  }
  return seg;
}

export function pathSeg(o: { id?: string; start: string; end: string; points: { pt: Pt; min: number }[] }): RawSegment {
  const seg: RawSegment = {
    startTime: o.start,
    endTime: o.end,
    startTimeTimezoneUtcOffsetMinutes: offsetOf(o.start),
    endTimeTimezoneUtcOffsetMinutes: offsetOf(o.end),
    timelinePath: o.points.map((p) => ({ point: ll(p.pt), durationMinutesOffsetFromStartTime: String(p.min) })),
  };
  if (o.id) {
    seg.segmentId = o.id;
    seg.segmentType = 3;
  }
  return seg;
}

export function trip(o: { id?: string; start: string; end: string; name?: string }): RawSegment {
  const seg: RawSegment = {
    startTime: o.start,
    endTime: o.end,
    startTimeTimezoneUtcOffsetMinutes: offsetOf(o.start),
    endTimeTimezoneUtcOffsetMinutes: offsetOf(o.end),
    trip: { name: o.name ?? "trip_synthetic" },
  };
  if (o.id) {
    seg.segmentId = o.id;
    seg.segmentType = 4;
  }
  return seg;
}

export const META: ExportMeta = { generator: "timeline-sync", upstreamCommit: "0000000synthetic", generatedAt: "2025-03-11T00:00:00Z", adapter: "synthetic" };

export function exportData(segments: unknown[], opts: { meta?: ExportMeta; path?: string; salt?: string } = {}): ExportData {
  const text = JSON.stringify({ semanticSegments: segments, exportMeta: opts.meta ?? META, salt: opts.salt ?? "" });
  return {
    segments: segments as RawSegment[],
    exportMeta: opts.meta ?? META,
    sourcePath: opts.path ?? "synthetic://export",
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

/* ---------------------------------------------------------------- standard dataset */

/**
 * Days (all offsets are the segment's own):
 *   2025-01-02 +02:00   home / walk / office (+path) / car / cafe / walk (no distance) / home, plus a small path in a gap
 *   2025-01-03 +02:00   office / cafe / car
 *   2025-01-05..08      trip with hotel, museum, flight, drive
 *   2025-01-10 -05:00   airport lounge (featureId only) + a location-only visit (no ids)
 *   2025-03-09/10       America/New_York spring-forward day (23 h)
 */
export function standardDataset(): RawSegment[] {
  const p = (i: number): Pt => ({ lat: 10.2 + i * 0.001, lng: 20.2 + i * 0.001 });
  return [
    visit({ id: "seg-v-home-1", start: "2025-01-02T00:00:00.000+02:00", end: "2025-01-02T08:30:00.000+02:00", place: HOME, prob: 0.9, confirmed: true }),
    activity({ id: "seg-a-walk-1", start: "2025-01-02T08:30:00.000+02:00", end: "2025-01-02T08:50:00.000+02:00", from: HOME, to: OFFICE, meters: 1200, mode: "walking", code: 2 }),
    visit({ id: "seg-v-office-1", start: "2025-01-02T09:00:00.000+02:00", end: "2025-01-02T17:00:00.000+02:00", place: OFFICE }),
    pathSeg({
      id: "seg-p-1",
      start: "2025-01-02T09:00:00.000+02:00",
      end: "2025-01-02T11:00:00.000+02:00",
      points: Array.from({ length: 10 }, (_, i) => ({ pt: p(i), min: 5 + i * 10 })),
    }),
    activity({ id: "seg-a-car-1", start: "2025-01-02T17:00:00.000+02:00", end: "2025-01-02T17:30:00.000+02:00", from: OFFICE, to: CAFE, meters: 5000, mode: "in passenger vehicle", code: 29 }),
    visit({ id: "seg-v-cafe-1", start: "2025-01-02T17:40:00.000+02:00", end: "2025-01-02T18:40:00.000+02:00", place: CAFE }),
    activity({ id: "seg-a-walk-2", start: "2025-01-02T18:40:00.000+02:00", end: "2025-01-02T19:00:00.000+02:00", from: CAFE, to: HOME, mode: "walking", code: 2 }),
    pathSeg({
      id: "seg-p-2",
      start: "2025-01-02T19:00:00.000+02:00",
      end: "2025-01-02T19:10:00.000+02:00",
      points: [
        { pt: { lat: 10.5, lng: 20.5 }, min: 4 },
        { pt: { lat: 10.502, lng: 20.502 }, min: 6 },
      ],
    }),
    visit({ id: "seg-v-home-2", start: "2025-01-02T19:10:00.000+02:00", end: "2025-01-02T23:59:00.000+02:00", place: HOME }),

    visit({ id: "seg-v-office-2", start: "2025-01-03T09:00:00.000+02:00", end: "2025-01-03T12:00:00.000+02:00", place: OFFICE }),
    visit({ id: "seg-v-cafe-2", start: "2025-01-03T12:10:00.000+02:00", end: "2025-01-03T13:00:00.000+02:00", place: CAFE }),
    activity({ id: "seg-a-car-2", start: "2025-01-03T13:00:00.000+02:00", end: "2025-01-03T13:20:00.000+02:00", from: CAFE, to: HOME, meters: 3000, mode: "in passenger vehicle", code: 29 }),

    trip({ id: "seg-t-1", start: "2025-01-05T08:00:00.000+02:00", end: "2025-01-08T20:00:00.000+02:00", name: "trip_synthetic_1" }),
    activity({ id: "seg-a-fly", start: "2025-01-05T08:30:00.000+02:00", end: "2025-01-05T10:00:00.000+02:00", from: HOME, to: HOTEL, meters: 300000, mode: "flying", code: 5 }),
    visit({ id: "seg-v-hotel", start: "2025-01-05T18:00:00.000+02:00", end: "2025-01-06T09:00:00.000+02:00", place: HOTEL }),
    activity({ id: "seg-a-drive", start: "2025-01-06T09:10:00.000+02:00", end: "2025-01-06T09:40:00.000+02:00", from: HOTEL, to: MUSEUM, meters: 2000, mode: "in passenger vehicle", code: 29 }),
    visit({ id: "seg-v-museum", start: "2025-01-06T10:00:00.000+02:00", end: "2025-01-06T13:00:00.000+02:00", place: MUSEUM }),

    visit({ id: "seg-v-lounge", start: "2025-01-10T09:00:00.000-05:00", end: "2025-01-10T12:30:00.000-05:00", place: LOUNGE }),
    visit({ id: "seg-v-loc-only", start: "2025-01-10T13:00:00.000-05:00", end: "2025-01-10T14:00:00.000-05:00", place: { lat: 10.55, lng: 20.55 } }),

    visit({ id: "seg-v-dst-home", start: "2025-03-09T00:00:00.000-05:00", end: "2025-03-09T09:00:00.000-04:00", place: HOME }),
    visit({ id: "seg-v-dst-office", start: "2025-03-09T10:00:00.000-04:00", end: "2025-03-09T18:00:00.000-04:00", place: OFFICE }),
    visit({ id: "seg-v-dst-next", start: "2025-03-10T09:00:00.000-04:00", end: "2025-03-10T17:00:00.000-04:00", place: OFFICE }),
  ];
}

/** Counts in standardDataset(). */
export const STANDARD_COUNTS = { visit: 13, activity: 6, timeline_path: 2, trip: 1, place: 7 };

/* ---------------------------------------------------------------- environment helpers */

export function tmpDir(prefix = "timeline-mcp-test-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeExportFile(dataDir: string, segments: unknown, meta: ExportMeta | null = META): string {
  const cur = join(dataDir, "current");
  mkdirSync(cur, { recursive: true });
  const f = join(cur, "Timeline.json");
  const doc = Array.isArray(segments) ? { semanticSegments: segments, ...(meta ? { exportMeta: meta } : {}) } : segments;
  writeFileSync(f, typeof doc === "string" ? doc : JSON.stringify(doc));
  return f;
}

export function writeSyncStatus(dataDir: string, status: Record<string, unknown>): void {
  const st = join(dataDir, "state");
  mkdirSync(st, { recursive: true });
  writeFileSync(join(st, "sync-status.json"), JSON.stringify(status));
}

export interface TestIndex {
  db: Database;
  config: Config;
  dir: string;
  cleanup: () => void;
}

/** In-memory DB imported from the given segments. */
export function memoryIndex(segments: unknown[] = standardDataset(), cfg: Partial<Config> = {}): TestIndex {
  const db = openIndexDb(":memory:");
  importExport(db, exportData(segments));
  const t = tmpDir();
  return { db, config: loadConfig({ dbPath: ":memory:", dataDir: t.dir, ...cfg }), dir: t.dir, cleanup: () => { db.close(); t.cleanup(); } };
}

export function fileBackedManager(dataDir: string, now: () => number = Date.now) {
  const db = openIndexDb(":memory:");
  const source = new TimelineSyncFileSource({ dataDir });
  const index = new IndexManager({ db, source, logger: silentLogger, checkIntervalMs: 60_000, now });
  return { db, source, index };
}

/** Recursively collect all object keys. */
export function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      allKeys(x, out);
    }
  }
  return out;
}

export const COORD_KEYS = /^(lat|lng|lon|latitude|longitude|start_location|end_location|coordinates|points|placeLocation|latLng)$/;
