import { join } from "node:path";
import { envInt, expandHome, platformHome, type Precision } from "@location/shared";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;
export const MAX_RANGE_DAYS = 400;
export const REINDEX_CHECK_MS = 60_000;
export const REQUIRED_SCOPE = "timeline:read";

export interface Config {
  /** SQLite index (own database; never the source export). */
  dbPath: string;
  /** timeline-sync data directory ($TIMELINE_DATA_DIR). */
  dataDir: string;
  /** Server-side cap on coordinate precision. */
  maxPrecision: Precision;
  /** Precision used when a tool call does not ask for one (clamped to maxPrecision). */
  defaultPrecision: Precision;
  port: number;
  publicUrl: string;
  maxRangeDays: number;
  reindexCheckMs: number;
}

const PRECISIONS: Precision[] = ["semantic", "approximate", "exact"];

export function parsePrecision(v: string | undefined, def: Precision): Precision {
  if (v === undefined || v === "") return def;
  const p = v.toLowerCase() as Precision;
  if (!PRECISIONS.includes(p)) throw new Error(`invalid precision "${v}" (expected semantic|approximate|exact)`);
  return p;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const port = envInt("TIMELINE_MCP_PORT", 8701);
  return {
    dbPath: expandHome(process.env.TIMELINE_MCP_DB || join(platformHome(), "timeline-mcp", "timeline-index.sqlite")),
    dataDir: expandHome(process.env.TIMELINE_DATA_DIR || join(platformHome(), "timeline")),
    maxPrecision: parsePrecision(process.env.TIMELINE_MAX_PRECISION, "exact"),
    defaultPrecision: parsePrecision(process.env.TIMELINE_DEFAULT_PRECISION, "semantic"),
    port,
    publicUrl: process.env.TIMELINE_MCP_PUBLIC_URL || `http://localhost:${port}`,
    maxRangeDays: MAX_RANGE_DAYS,
    reindexCheckMs: REINDEX_CHECK_MS,
    ...overrides,
  };
}
