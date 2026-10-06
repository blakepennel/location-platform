/**
 * MCP tools over recent raw point observations. All tools are read-only.
 * These are Location Sharing OBSERVATIONS (a point, a timestamp, an accuracy radius) — never
 * semantic visits. Nothing here names a place the person "visited".
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  applyPrecision,
  boundedLimit,
  clampPrecision,
  defaultTimeZone,
  downsample,
  freshnessSeconds,
  haversineMeters,
  humanDuration,
  isoUtc,
  parseTimestamp,
  pathLengthMeters,
  toolError,
  toolResult,
  type Logger,
  type Precision,
} from "@location/shared";
import type { LiveConfig } from "./config.ts";
import { isStale, type LiveDb, type ObservationRow } from "./db.ts";
import { getStatus } from "./status.ts";

export interface ToolDeps {
  db: LiveDb;
  config: LiveConfig;
  logger?: Logger;
  now?: () => number;
}

export const MAX_POINTS = 1000;
export const MAX_RANGE_DAYS = 31;

const BASE = { source: "google_location_sharing", semantics: "raw_point_observation" } as const;

/** Errors whose message is safe to show to the model/user. */
class ToolInputError extends Error {}

const timestampInput = z.union([z.string().min(1).max(64), z.number()]);
const precisionInput = z.enum(["approximate", "exact"]).describe('"approximate" = 2 decimals (~1 km); "exact" = full precision as reported by Google. where_am_i defaults to exact; history tools default to LIVE_DEFAULT_PRECISION (approximate unless configured).');

function resolvePrecision(requested: Precision | undefined, def: Precision, max: Precision): Precision {
  return clampPrecision(requested ?? def, max);
}

function parseTs(input: string | number, label: string, now: number): number {
  try {
    const t = parseTimestamp(input, defaultTimeZone(), now);
    if (!Number.isFinite(t)) throw new Error("not finite");
    return t;
  } catch (e) {
    throw new ToolInputError(`${label}: ${(e as Error).message}`);
  }
}

/** Google Maps link for the coordinates actually shown (null when coordinates are withheld). */
function mapsUrl(c: { latitude?: number; longitude?: number }): Record<string, string> {
  return c.latitude === undefined ? {} : { maps_url: `https://www.google.com/maps?q=${c.latitude},${c.longitude}` };
}

function pointOf(r: ObservationRow, precision: Precision) {
  return {
    observed_at: r.observed_at_iso,
    ...applyPrecision(r.lat, r.lng, precision),
    ...(r.accuracy_m != null ? { accuracy_meters: r.accuracy_m } : {}),
  };
}

/** Common per-observation envelope fields. */
function envelope(r: ObservationRow, now: number, staleSeconds: number, precision: Precision) {
  const fresh = freshnessSeconds(r.observed_at_iso, now);
  return {
    observed_at: r.observed_at_iso,
    polled_at: r.polled_at_iso,
    freshness_seconds: fresh,
    freshness_human: humanDuration(fresh),
    precision,
    ...(r.accuracy_m != null ? { accuracy_meters: r.accuracy_m } : {}),
    stale: isStale(r.source_ts_ms, now, staleSeconds),
  };
}

function wrap<A>(deps: ToolDeps, name: string, fn: (args: A) => Record<string, unknown>) {
  return async (args: A) => {
    try {
      return toolResult(fn(args));
    } catch (e) {
      if (e instanceof ToolInputError) return toolError(e.message);
      deps.logger?.error("tool.failed", { tool: name, error: e as Error });
      return toolError("internal error while reading live location data");
    }
  };
}

export function buildServer(deps: ToolDeps): McpServer {
  const { db, config } = deps;
  const nowFn = deps.now ?? Date.now;
  const person = config.sharerId;
  const ann = { readOnlyHint: true, openWorldHint: false } as const;
  const server = new McpServer({ name: "live-location-mcp", version: "0.1.0" });

  server.registerTool(
    "where_am_i",
    {
      title: "Latest live location observation",
      description:
        "Most recent Google Location Sharing point observation (raw point + timestamp + accuracy), polled by a local daemon. " +
        "Always check freshness_seconds/stale: this is the last fix Google reported, not necessarily 'now'. " +
        "Not a semantic place; no visit inference.",
      inputSchema: { precision: precisionInput.optional().describe("exact (default) or approximate (~1 km); capped by server config") },
      annotations: ann,
    },
    wrap(deps, "where_am_i", ({ precision }: { precision?: Precision }) => {
      const now = nowFn();
      const p = resolvePrecision(precision, "exact", config.maxPrecision);
      const r = db.latest(person);
      if (!r) {
        return {
          ...BASE,
          kind: "status",
          message: "No live observations recorded yet. Is the poller (live-location daemon) running and authenticated?",
          precision: p,
        };
      }
      return {
        ...BASE,
        kind: "observation",
        ...envelope(r, now, config.staleSeconds, p),
        ...applyPrecision(r.lat, r.lng, p),
        ...mapsUrl(applyPrecision(r.lat, r.lng, p)),
        polled_age_seconds: freshnessSeconds(r.polled_at_iso, now),
        ...(r.battery_level != null ? { battery_level: r.battery_level } : {}),
        ...(r.battery_charging != null ? { battery_charging: r.battery_charging === 1 } : {}),
        note: "Raw point observation from Location Sharing; may lag real time (see freshness_seconds).",
      };
    }),
  );

  server.registerTool(
    "recent_locations",
    {
      title: "Recent live location observations in a time range",
      description:
        "Chronological raw point observations between start and end (ISO-8601, epoch, 'now', 'today', 'yesterday'), " +
        `downsampled to max_points. Only the last ~${config.retentionDays} days are retained. Default precision: approximate.`,
      inputSchema: {
        start: timestampInput,
        end: timestampInput,
        max_points: z.number().int().min(1).max(MAX_POINTS).optional().describe("default 200, max 1000"),
        precision: precisionInput.optional(),
      },
      annotations: ann,
    },
    wrap(
      deps,
      "recent_locations",
      (a: { start: string | number; end: string | number; max_points?: number; precision?: Precision }) => {
        const now = nowFn();
        const p = resolvePrecision(a.precision, config.historyPrecision ?? "approximate", config.maxPrecision);
        const start = parseTs(a.start, "start", now);
        const end = parseTs(a.end, "end", now);
        if (end < start) throw new ToolInputError("end must not be before start");
        if (end - start > MAX_RANGE_DAYS * 86_400_000) throw new ToolInputError(`range too large (max ${MAX_RANGE_DAYS} days)`);
        const maxPoints = boundedLimit(a.max_points, 200, MAX_POINTS);
        const total = db.countRange(start, end, person);
        const rows = db.range(start, end, person);
        const picked = downsample(rows, maxPoints);
        const newest = rows.at(-1);
        return {
          ...BASE,
          kind: "observation",
          precision: p,
          start_time: isoUtc(start),
          end_time: isoUtc(end),
          count: picked.length,
          total_available: total,
          truncated: picked.length < total,
          ...(newest
            ? {
                observed_at: newest.observed_at_iso,
                polled_at: newest.polled_at_iso,
                freshness_seconds: freshnessSeconds(newest.observed_at_iso, now),
                stale: isStale(newest.source_ts_ms, now, config.staleSeconds),
              }
            : { message: "No observations in this range (retention is limited; the poller may not have been running)." }),
          points: picked.map((r) => pointOf(r, p)),
        };
      },
    ),
  );

  server.registerTool(
    "where_was_i_recently",
    {
      title: "Nearest live observation to a recent time",
      description:
        "The recorded observation closest in time to the given timestamp, with the time gap. match is 'none' if nothing is within tolerance_minutes. " +
        "This is a raw point, not a place visit. Default precision: approximate.",
      inputSchema: {
        timestamp: timestampInput,
        tolerance_minutes: z.number().min(0).max(1440).optional().describe("default 30"),
        precision: precisionInput.optional(),
      },
      annotations: ann,
    },
    wrap(deps, "where_was_i_recently", (a: { timestamp: string | number; tolerance_minutes?: number; precision?: Precision }) => {
      const now = nowFn();
      const p = resolvePrecision(a.precision, config.historyPrecision ?? "approximate", config.maxPrecision);
      const ts = parseTs(a.timestamp, "timestamp", now);
      const tolMin = a.tolerance_minutes ?? 30;
      const r = db.nearest(ts, person);
      if (!r) {
        return { ...BASE, kind: "status", match: "none", precision: p, requested_time: isoUtc(ts), message: "No observations recorded." };
      }
      const gapMs = Math.abs(r.source_ts_ms - ts);
      const within = gapMs <= tolMin * 60_000;
      const base = {
        ...BASE,
        requested_time: isoUtc(ts),
        tolerance_minutes: tolMin,
        gap_seconds: Math.round(gapMs / 1000),
        within_tolerance: within,
      };
      if (!within) {
        return {
          ...base,
          kind: "status",
          match: "none",
          precision: p,
          message: "Nearest observation is outside the tolerance window.",
          nearest_observed_at: r.observed_at_iso,
        };
      }
      return {
        ...base,
        kind: "observation",
        match: "nearest_in_time",
        gap_direction: r.source_ts_ms <= ts ? "before" : "after",
        ...envelope(r, now, config.staleSeconds, p),
        ...applyPrecision(r.lat, r.lng, p),
        ...mapsUrl(applyPrecision(r.lat, r.lng, p)),
      };
    }),
  );

  server.registerTool(
    "movement_since",
    {
      title: "Movement summary from live observations since a time",
      description:
        "Compact summary of the observation track from timestamp until now: distance (haversine over observations; an ESTIMATE that GPS jitter inflates), " +
        "straight-line displacement, bounding box, duration, average speed. Derived from raw points, not Google semantics. Default precision: approximate.",
      inputSchema: {
        timestamp: timestampInput,
        max_points: z.number().int().min(1).max(MAX_POINTS).optional().describe("default 200; only used with include_points"),
        include_points: z.boolean().optional().describe("include the (downsampled) points; default false"),
        precision: precisionInput.optional(),
      },
      annotations: ann,
    },
    wrap(
      deps,
      "movement_since",
      (a: { timestamp: string | number; max_points?: number; include_points?: boolean; precision?: Precision }) => {
        const now = nowFn();
        const p = resolvePrecision(a.precision, config.historyPrecision ?? "approximate", config.maxPrecision);
        const since = parseTs(a.timestamp, "timestamp", now);
        if (since > now + 60_000) throw new ToolInputError("timestamp must not be in the future");
        if (now - since > MAX_RANGE_DAYS * 86_400_000) throw new ToolInputError(`timestamp too far back (max ${MAX_RANGE_DAYS} days)`);
        const rows = db.range(since, now, person);
        const base = {
          ...BASE,
          kind: "movement_summary",
          precision: p,
          start_time: isoUtc(since),
          end_time: isoUtc(now),
          estimate: true,
          note: "Distances are estimates computed from raw point observations (haversine); GPS jitter and sparse polling affect them. Not Google-semantic activity.",
        };
        if (rows.length === 0) {
          return { ...base, point_count: 0, message: "No observations in this window." };
        }
        const pts = rows.map((r) => ({ lat: r.lat, lng: r.lng }));
        const first = rows[0];
        const last = rows[rows.length - 1];
        const distance = pathLengthMeters(pts);
        const displacement = haversineMeters(pts[0], pts[pts.length - 1]);
        const durationSec = Math.round((last.source_ts_ms - first.source_ts_ms) / 1000);
        const lats = pts.map((x) => x.lat);
        const lngs = pts.map((x) => x.lng);
        const bboxMin = applyPrecision(Math.min(...lats), Math.min(...lngs), p);
        const bboxMax = applyPrecision(Math.max(...lats), Math.max(...lngs), p);
        const maxPoints = boundedLimit(a.max_points, 200, MAX_POINTS);
        return {
          ...base,
          point_count: rows.length,
          first_observed_at: first.observed_at_iso,
          last_observed_at: last.observed_at_iso,
          observed_at: last.observed_at_iso,
          polled_at: last.polled_at_iso,
          freshness_seconds: freshnessSeconds(last.observed_at_iso, now),
          stale: isStale(last.source_ts_ms, now, config.staleSeconds),
          duration_seconds: durationSec,
          total_distance_meters: Math.round(distance),
          straight_line_displacement_meters: Math.round(displacement),
          average_speed_mps: durationSec > 0 ? Math.round((distance / durationSec) * 100) / 100 : null,
          ...(bboxMin.latitude != null
            ? {
                bounding_box: {
                  min_latitude: bboxMin.latitude,
                  min_longitude: bboxMin.longitude,
                  max_latitude: bboxMax.latitude,
                  max_longitude: bboxMax.longitude,
                },
              }
            : {}),
          ...(a.include_points
            ? (() => {
                const picked = downsample(rows, maxPoints);
                return { points: picked.map((r) => pointOf(r, p)), points_truncated: picked.length < rows.length };
              })()
            : {}),
        };
      },
    ),
  );

  server.registerTool(
    "location_status",
    {
      title: "Live location poller and data health",
      description:
        "Health of the live location pipeline: last poll, newest observation age, authentication state, failure/backoff state, observation count, retention. No coordinates.",
      inputSchema: {},
      annotations: ann,
    },
    wrap(deps, "location_status", () => {
      const now = nowFn();
      const s = getStatus(db, config, now, person);
      return {
        ...BASE,
        kind: "status",
        observed_at: s.latest_observation_at,
        polled_at: s.latest_observation_polled_at,
        freshness_seconds: s.latest_observation_age_seconds,
        ...s,
      };
    }),
  );

  return server;
}
