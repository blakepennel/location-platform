/**
 * MCP tool surface. Every tool is read-only, zod-typed, bounded (limit/range/points caps), precision-aware,
 * and returns { structuredContent, content:[json text] } via the shared toolResult(). There is deliberately no
 * SQL tool, no file tool and no bulk-dump tool.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  assertTimeZone,
  boundedLimit,
  clampPrecision,
  defaultTimeZone,
  downsample,
  isoInZone,
  parseTimestamp,
  redactString,
  toolError,
  toolResult,
  type Logger,
  type Precision,
} from "@location/shared";
import { DEFAULT_LIMIT, MAX_LIMIT, type Config } from "./config.ts";
import type { Database } from "./db.ts";
import type { IndexManager } from "./indexer.ts";
import { buildStatus } from "./status.ts";
import * as A from "./analysis.ts";
import { activityItem, baseFields, iso, placeSummary, pointItem, tripItem, visitItem } from "./present.ts";
import * as Q from "./queries.ts";

export interface ToolDeps {
  db: Database;
  config: Config;
  logger: Logger;
  /** When present, the index is refreshed (throttled) before each call. */
  index?: IndexManager;
  now?: () => number;
}

export const TOOL_NAMES = [
  "timeline_status",
  "where_was_i",
  "visits",
  "timeline_between",
  "search_places",
  "visit_history",
  "time_at_place",
  "trips",
  "activities",
  "distance_traveled",
  "summarize_day",
  "summarize_week",
  "visits_near",
] as const;

class ToolInputError extends Error {}

const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ input helpers */

function precisionSchemaFor(def: Precision) {
  return z
    .enum(["semantic", "approximate", "exact"])
    .optional()
    .describe(
      `Coordinate detail. "semantic": place names/types only, no coordinates. "approximate": coordinates rounded to 2 decimals (~1 km). "exact": full source precision (7 decimals). Default on this server: "${def}". The server may cap this.`,
    );
}
const tzSchema = z.string().optional().describe("IANA time zone (e.g. Europe/Berlin) used for offset-less times and day boundaries. Default: server time zone.");
const limitSchema = z
  .number()
  .int()
  .optional()
  .describe(`Max items to return (default ${DEFAULT_LIMIT}, clamped to ${MAX_LIMIT}). Results report truncated + total_available.`);
const timeDesc = "ISO 8601 (with or without UTC offset), epoch seconds/ms, or now|today|yesterday";

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new ToolInputError(redactString((e as Error).message).slice(0, 200));
  }
}

function pickTz(tz: string | undefined): string {
  return wrap(() => assertTimeZone(tz ?? defaultTimeZone()));
}

function parseInstant(v: string, tz: string, label: string): number {
  return wrap(() => {
    try {
      return parseTimestamp(v, tz);
    } catch (e) {
      throw new Error(`${label}: ${(e as Error).message}`);
    }
  });
}

function assertDate(v: string, label: string): void {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const ok = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString().slice(0, 10) === v && +m[1] >= 1970;
  if (!ok) throw new ToolInputError(`${label} must be a valid YYYY-MM-DD date`);
}

function rangeOf(
  cfg: Config,
  tz: string,
  start: string | undefined,
  end: string | undefined,
  required: boolean,
): { startMs?: number; endMs?: number } {
  if (required && (start === undefined || end === undefined)) throw new ToolInputError("start and end are required");
  const startMs = start === undefined ? undefined : parseInstant(start, tz, "start");
  const endMs = end === undefined ? undefined : parseInstant(end, tz, "end");
  if (startMs !== undefined && endMs !== undefined) {
    if (!(endMs > startMs)) throw new ToolInputError("end must be after start");
    if (endMs - startMs > cfg.maxRangeDays * DAY_MS) throw new ToolInputError(`time range too large (max ${cfg.maxRangeDays} days)`);
  }
  return { startMs, endMs };
}

/* ------------------------------------------------------------------ server */

export function buildServer(deps: ToolDeps): McpServer {
  const { db, config, logger } = deps;
  const now = () => (deps.now ? deps.now() : Date.now());
  const defaultPrecision = clampPrecision(config.defaultPrecision ?? "semantic", config.maxPrecision);
  const precisionSchema = precisionSchemaFor(defaultPrecision);

  const server = new McpServer(
    { name: "timeline-mcp", version: "0.1.0" },
    {
      instructions:
        "Historical Google Maps Timeline (semantic reconstruction: visits, activities, trips). NOT real-time: data lags the phone by hours to a day. " +
        `All tools are read-only. Default precision on this server is ${defaultPrecision} (semantic = names/types only; approximate = ~1 km; exact = full precision). ` +
        "To find visits by location (a neighborhood, landmark or coordinate), use visits_near. " +
        "Start with timeline_status to see coverage and freshness.",
    },
  );

  function resolvePrecision(requested: Precision | undefined): { precision: Precision; extra: Record<string, unknown> } {
    const want = requested ?? defaultPrecision;
    const precision = clampPrecision(want, config.maxPrecision);
    return precision === want ? { precision, extra: {} } : { precision, extra: { precision_clamped: true, requested_precision: want } };
  }

  function base(precision: Precision, extra: Record<string, unknown> = {}) {
    return baseFields(precision, Q.coverage(db).newest_ms, now(), extra);
  }

  function register<S extends z.ZodRawShape>(
    name: (typeof TOOL_NAMES)[number],
    title: string,
    description: string,
    inputSchema: S,
    fn: (args: z.objectOutputType<S, z.ZodTypeAny>) => Record<string, unknown> | Promise<Record<string, unknown>>,
    opts: { forceRefresh?: boolean } = {},
  ) {
    server.registerTool(
      name,
      { title, description, inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      (async (args: z.objectOutputType<S, z.ZodTypeAny>) => {
        try {
          if (deps.index) await deps.index.ensureFresh({ force: opts.forceRefresh });
          return toolResult(await fn(args));
        } catch (e) {
          if (e instanceof ToolInputError) return toolError(e.message);
          logger.error("tool.failed", { tool: name, error: e as Error });
          return toolError("internal error while reading the timeline index");
        }
      }) as any,
    );
  }

  const listMeta = (returned: number, total: number) => ({ truncated: total > returned, total_available: total });
  const lim = (n: number | undefined) => boundedLimit(n, DEFAULT_LIMIT, MAX_LIMIT);

  /* ---- 1. timeline_status ---- */
  register(
    "timeline_status",
    "Timeline index status",
    "Coverage, freshness, record counts and sync health of the Google Timeline index. Timeline is NOT real-time: the phone backs up hours to a day late.",
    {},
    () => ({ ...base("semantic"), ...buildStatus(db, now()) }),
    { forceRefresh: true },
  );

  /* ---- 2. where_was_i ---- */
  register(
    "where_was_i",
    "Where was I at a time",
    "Where the user was at an instant, per Google Timeline: the visit containing it, else the containing activity, else the nearest visit/activity within the tolerance (match=nearest, with gap_seconds), else an estimate from GPS path points (match=estimate), else match=none.",
    {
      timestamp: z.string().describe(timeDesc),
      tolerance_minutes: z.number().optional().describe("How far from the instant to look for a nearby record (default 30, max 1440)."),
      timezone: tzSchema,
      precision: precisionSchema,
    },
    (a) => {
      const tz = pickTz(a.timezone);
      const t = parseInstant(a.timestamp, tz, "timestamp");
      const tol = Math.min(Math.max(a.tolerance_minutes ?? 30, 0), 1440);
      const { precision, extra } = resolvePrecision(a.precision);
      return { ...base(precision, extra), ...A.whereWasI(db, { t, toleranceMs: tol * 60_000, precision, tz }) };
    },
  );

  /* ---- 3. visits ---- */
  register(
    "visits",
    "Visits in a time range",
    "Place visits overlapping [start, end), chronological. Optional filters: place (name/place_key/placeId substring) and semantic_type (e.g. HOME, WORK).",
    {
      start: z.string().describe(timeDesc),
      end: z.string().describe(timeDesc),
      place: z.string().optional().describe("Place name, place_key or placeId to filter on."),
      semantic_type: z.string().optional().describe("Google semantic type, e.g. HOME, WORK, INFERRED_HOME."),
      limit: limitSchema,
      timezone: tzSchema,
      precision: precisionSchema,
    },
    (a) => {
      const tz = pickTz(a.timezone);
      const { startMs, endMs } = rangeOf(config, tz, a.start, a.end, true);
      const { precision, extra } = resolvePrecision(a.precision);
      let placeKeys: string[] | undefined;
      if (a.place) {
        const res = Q.resolvePlaces(db, a.place);
        placeKeys = res.places.map((p) => p.place_key);
      }
      const r = Q.queryVisits(db, { startMs, endMs, placeKeys, semanticType: a.semantic_type, limit: lim(a.limit) });
      return {
        ...base(precision, extra),
        range: { start: isoInZone(startMs!, tz), end: isoInZone(endMs!, tz) },
        items: r.rows.map((v) => visitItem(v, precision)),
        returned: r.rows.length,
        ...listMeta(r.rows.length, r.total),
      };
    },
  );

  /* ---- 4. timeline_between ---- */
  register(
    "timeline_between",
    "Compact timeline between two times",
    "Compact chronological list of visits and activities (plus trip markers) overlapping [start, end). GPS path points are omitted unless include_points=true, and then downsampled to max_points (<=500).",
    {
      start: z.string().describe(timeDesc),
      end: z.string().describe(timeDesc),
      include_points: z.boolean().optional().describe("Include downsampled GPS path points (needs approximate/exact precision). Default false."),
      max_points: z.number().int().optional().describe("Max path points when include_points is true (default 200, max 500)."),
      limit: limitSchema,
      timezone: tzSchema,
      precision: precisionSchema,
    },
    (a) => {
      const tz = pickTz(a.timezone);
      const { startMs, endMs } = rangeOf(config, tz, a.start, a.end, true);
      const { precision, extra } = resolvePrecision(a.precision);
      const limit = lim(a.limit);
      const v = Q.queryVisits(db, { startMs, endMs, limit });
      const ac = Q.queryActivities(db, { startMs: startMs!, endMs: endMs!, limit });
      const tr = Q.queryTrips(db, { startMs, endMs, limit });
      const all = [
        ...v.rows.map((r) => ({ ms: r.start_ms, o: 0, item: visitItem(r, precision, true) })),
        ...ac.rows.map((r) => ({ ms: r.start_ms, o: 1, item: activityItem(r, precision, true) })),
        ...tr.rows.map((r) => ({ ms: r.start_ms, o: 2, item: { ...tripItem(r), marker: true } })),
      ].sort((x, y) => x.ms - y.ms || x.o - y.o);
      const total = v.total + ac.total + tr.total;
      const items = all.slice(0, limit).map((x) => x.item);
      const out: Record<string, unknown> = {
        ...base(precision, extra),
        range: { start: isoInZone(startMs!, tz), end: isoInZone(endMs!, tz) },
        items,
        returned: items.length,
        ...listMeta(items.length, total),
      };
      if (a.include_points) {
        if (precision === "semantic") {
          out.points_omitted = "precision is semantic; request approximate or exact to include path points";
        } else {
          const maxPts = Math.min(Math.max(Math.floor(a.max_points ?? 200), 2), 500);
          const rows = Q.pathsNear(db, startMs!, endMs!, 400);
          const pts: { p: Q.PathPoint; off: number }[] = [];
          for (const r of rows) for (const p of Q.decodePoints(r)) if (p.ms !== null && p.ms >= startMs! && p.ms < endMs!) pts.push({ p, off: r.start_offset_min });
          pts.sort((x, y) => x.p.ms! - y.p.ms!);
          const kept = downsample(pts, maxPts);
          out.points = kept.map((x) => pointItem(x.p, x.off, precision));
          out.points_total = pts.length;
          out.points_returned = kept.length;
          out.points_downsampled = kept.length < pts.length;
        }
      }
      return out;
    },
  );

  /* ---- 5. search_places ---- */
  register(
    "search_places",
    "Search known places",
    "Find places seen in the timeline by name, category, placeId or (at approximate/exact precision) address substring. Returns visit counts, total time and first/last seen, most-time first.",
    {
      query: z.string().optional().describe("Substring of place name, placeId or category (address too when precision is not semantic)."),
      semantic_type: z.string().optional().describe("Filter by Google semantic type (HOME, WORK, ...)."),
      limit: limitSchema,
      timezone: tzSchema,
      precision: precisionSchema,
    },
    (a) => {
      const tz = pickTz(a.timezone);
      const { precision, extra } = resolvePrecision(a.precision);
      const r = Q.searchPlaces(db, {
        query: a.query?.trim() || undefined,
        semanticType: a.semantic_type,
        limit: lim(a.limit),
        matchAddress: precision !== "semantic",
      });
      const fmt = (ms: number) => isoInZone(ms, tz);
      return {
        ...base(precision, extra),
        items: r.rows.map((p) => ({ kind: "place", ...placeSummary(p, precision, fmt) })),
        returned: r.rows.length,
        ...listMeta(r.rows.length, r.total),
      };
    },
  );

  /* ---- shared place resolution ---- */
  function resolveOrThrow(ref: string, precision: Precision, tz: string) {
    const res = Q.resolvePlaces(db, ref);
    if (!res.places.length) throw new ToolInputError(`no place matches "${ref.slice(0, 60)}"`);
    const fmt = (ms: number) => isoInZone(ms, tz);
    return {
      keys: res.places.map((p) => p.place_key),
      info: {
        match_type: res.matchType,
        matched_places: res.places.slice(0, 10).map((p) => placeSummary(p, precision, fmt)),
        matched_count: res.places.length,
        matched_truncated: res.truncated || res.places.length > 10,
      },
    };
  }

  /* ---- 6. visit_history ---- */
  register(
    "visit_history",
    "Visit history for a place",
    "Every visit to a place (identified by place_key, placeId, or name), optionally within a time range. Newest first by default.",
    {
      place: z.string().describe("place_key, placeId, or place name (exact, else substring)."),
      start: z.string().optional().describe(timeDesc),
      end: z.string().optional().describe(timeDesc),
      order: z.enum(["asc", "desc"]).optional().describe("desc (default) = newest first."),
      limit: limitSchema,
      timezone: tzSchema,
      precision: precisionSchema,
    },
    (a) => {
      const tz = pickTz(a.timezone);
      const { startMs, endMs } = rangeOf(config, tz, a.start, a.end, false);
      const { precision, extra } = resolvePrecision(a.precision);
      const pl = resolveOrThrow(a.place, precision, tz);
      const r = Q.queryVisits(db, { startMs, endMs, placeKeys: pl.keys, limit: lim(a.limit), order: a.order ?? "desc" });
      return {
        ...base(precision, extra),
        place_match: pl.info,
        items: r.rows.map((v) => visitItem(v, precision)),
        returned: r.rows.length,
        ...listMeta(r.rows.length, r.total),
      };
    },
  );

  /* ---- 7. time_at_place ---- */
  register(
    "time_at_place",
    "Total time at a place",
    "Total time spent at a place (overlapping visits merged, clipped to the optional range), visit count and a bounded per-day breakdown in the given time zone.",
    {
      place: z.string().describe("place_key, placeId, or place name (exact, else substring; all matches are combined)."),
      start: z.string().optional().describe(timeDesc),
      end: z.string().optional().describe(timeDesc),
      timezone: tzSchema,
      precision: precisionSchema,
    },
    (a) => {
      const tz = pickTz(a.timezone);
      const { startMs, endMs } = rangeOf(config, tz, a.start, a.end, false);
      const { precision, extra } = resolvePrecision(a.precision);
      const pl = resolveOrThrow(a.place, precision, tz);
      const r = A.timeAtPlaces(db, { keys: pl.keys, startMs, endMs, tz });
      return {
        ...base(precision, extra),
        place_match: pl.info,
        range: {
          start: startMs === undefined ? null : isoInZone(startMs, tz),
          end: endMs === undefined ? null : isoInZone(endMs, tz),
        },
        timezone: tz,
        ...r,
      };
    },
  );

  /* ---- 8. trips ---- */
  register(
    "trips",
    "Trips",
    "Trip segments (multi-day journeys as classified by Google) overlapping the optional range, with contained visit/activity counts, source-provided distance by mode and top places.",
    {
      start: z.string().optional().describe(timeDesc),
      end: z.string().optional().describe(timeDesc),
      limit: limitSchema,
      timezone: tzSchema,
      precision: precisionSchema,
    },
    (a) => {
      const tz = pickTz(a.timezone);
      const { startMs, endMs } = rangeOf(config, tz, a.start, a.end, false);
      const { precision, extra } = resolvePrecision(a.precision);
      const r = Q.queryTrips(db, { startMs, endMs, limit: lim(a.limit) });
      const items = r.rows.map((t) => ({ ...tripItem(t), ...A.tripStats(db, t, precision) }));
      return { ...base(precision, extra), items, returned: items.length, ...listMeta(items.length, r.total) };
    },
  );

  /* ---- 9. activities ---- */
  register(
    "activities",
    "Movement activities in a time range",
    "Movement activities (walking, in passenger vehicle, flying, ...) overlapping [start, end), chronological, with Google's distance when provided. Optional mode substring filter.",
    {
      start: z.string().describe(timeDesc),
      end: z.string().describe(timeDesc),
      mode: z.string().optional().describe('Mode substring, e.g. "walking" or "vehicle".'),
      limit: limitSchema,
      timezone: tzSchema,
      precision: precisionSchema,
    },
    (a) => {
      const tz = pickTz(a.timezone);
      const { startMs, endMs } = rangeOf(config, tz, a.start, a.end, true);
      const { precision, extra } = resolvePrecision(a.precision);
      const r = Q.queryActivities(db, { startMs: startMs!, endMs: endMs!, mode: a.mode, limit: lim(a.limit) });
      return {
        ...base(precision, extra),
        range: { start: isoInZone(startMs!, tz), end: isoInZone(endMs!, tz) },
        items: r.rows.map((x) => activityItem(x, precision)),
        returned: r.rows.length,
        ...listMeta(r.rows.length, r.total),
      };
    },
  );

  /* ---- 10. distance_traveled ---- */
  register(
    "distance_traveled",
    "Distance traveled",
    "Sum of Google's own distanceMeters for activities starting in [start, end), grouped by mode, day or not at all. Where Google gave no distance but both end points exist, a straight-line haversine estimate is reported SEPARATELY as estimated_meters (method=haversine_estimate); the two are never merged.",
    {
      start: z.string().describe(timeDesc),
      end: z.string().describe(timeDesc),
      group_by: z.enum(["mode", "day", "none"]).optional().describe("Default mode."),
      timezone: tzSchema,
    },
    (a) => {
      const tz = pickTz(a.timezone);
      const { startMs, endMs } = rangeOf(config, tz, a.start, a.end, true);
      const groupBy = a.group_by ?? "mode";
      const r = A.distanceTraveled(db, { startMs: startMs!, endMs: endMs!, groupBy, tz });
      return {
        ...base("semantic"),
        range: { start: isoInZone(startMs!, tz), end: isoInZone(endMs!, tz) },
        timezone: tz,
        group_by: groupBy,
        ...r,
        notes: [
          "source_meters is Google's distanceMeters; estimated_meters (haversine_estimate) covers only activities lacking it and is a straight-line lower bound.",
          "Activities are attributed to the range/day in which they start.",
        ],
      };
    },
  );

  /* ---- 11. summarize_day ---- */
  register(
    "summarize_day",
    "Summarize a day",
    "LLM-friendly structured summary of one calendar day: ordered timeline, places with durations, movement by mode, first/last known place, unknown-time gaps and data-coverage flags. Day boundaries follow the time zone (23/25-hour DST days handled).",
    {
      date: z.string().describe("Calendar date YYYY-MM-DD."),
      timezone: tzSchema,
      precision: precisionSchema,
    },
    (a) => {
      assertDate(a.date, "date");
      const tz = pickTz(a.timezone);
      const { precision, extra } = resolvePrecision(a.precision);
      return { ...base(precision, extra), ...A.summarizeDay(db, { date: a.date, tz, precision }) };
    },
  );

  /* ---- 12. summarize_week ---- */
  register(
    "summarize_week",
    "Summarize a week",
    "Seven-day rollup starting at week_start (YYYY-MM-DD): per-day totals, top places and movement totals. The week is always exactly 7 calendar days in the given time zone.",
    {
      week_start: z.string().describe("First day of the 7-day window, YYYY-MM-DD."),
      timezone: tzSchema,
      precision: precisionSchema,
    },
    (a) => {
      assertDate(a.week_start, "week_start");
      const tz = pickTz(a.timezone);
      const { precision, extra } = resolvePrecision(a.precision);
      return { ...base(precision, extra), ...A.summarizeWeek(db, { weekStart: a.week_start, tz, precision }) };
    },
  );

  /* ---- 13. visits_near ---- */
  register(
    "visits_near",
    "Visits near a location",
    "Visits to any place within radius_meters of a latitude/longitude (e.g. a neighborhood, landmark or address you looked up), optionally within a time range. " +
      "Returns the matching places (nearest first, with distance) and their visits (chronological). Use this for questions like 'when was I in <area>?'.",
    {
      latitude: z.number().min(-90).max(90).describe("Latitude in decimal degrees."),
      longitude: z.number().min(-180).max(180).describe("Longitude in decimal degrees."),
      radius_meters: z.number().optional().describe("Search radius in meters (default 300, min 10, max 50000)."),
      start: z.string().optional().describe(timeDesc),
      end: z.string().optional().describe(timeDesc),
      limit: limitSchema,
      timezone: tzSchema,
      precision: precisionSchema,
    },
    (a) => {
      const tz = pickTz(a.timezone);
      const { startMs, endMs } = rangeOf(config, tz, a.start, a.end, false);
      const { precision, extra } = resolvePrecision(a.precision);
      const radius = Math.min(Math.max(a.radius_meters ?? 300, 10), 50_000);
      const near = Q.placesNear(db, a.latitude, a.longitude, radius);
      const fmt = (ms: number) => isoInZone(ms, tz);
      const dist = new Map(near.map((n) => [n.place.place_key, n.distance_m]));
      const r = Q.queryVisits(db, { startMs, endMs, placeKeys: near.map((n) => n.place.place_key), limit: lim(a.limit) });
      return {
        ...base(precision, extra),
        center: { latitude: a.latitude, longitude: a.longitude },
        radius_meters: radius,
        range: {
          start: startMs === undefined ? null : isoInZone(startMs, tz),
          end: endMs === undefined ? null : isoInZone(endMs, tz),
        },
        places: near.slice(0, 50).map((n) => ({ ...placeSummary(n.place, precision, fmt), distance_meters: Math.round(n.distance_m) })),
        places_found: near.length,
        items: r.rows.map((v) => ({ ...visitItem(v, precision), distance_meters: Math.round(dist.get(v.place_key ?? "") ?? 0) })),
        returned: r.rows.length,
        ...listMeta(r.rows.length, r.total),
      };
    },
  );

  return server;
}
