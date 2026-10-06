/**
 * Runtime configuration for live-location-mcp (env-driven, validated once).
 * Nothing in here reads or refers to any other project's database.
 */
import { join, basename, resolve, sep } from "node:path";
import { expandHome, platformHome, type Precision } from "@location/shared";

/** Location Sharing must never be polled faster than this, whatever the env says. */
export const MIN_POLL_INTERVAL_MS = 30_000;

export interface LiveConfig {
  dbPath: string;
  source: "google" | "synthetic";
  cookiesFile: string;
  sharerId?: string;
  /** Opaque Google map-tile parameter; overridable via LIVE_PB. */
  pb?: string;
  pollIntervalMs: number;
  backoffMaxMs: number;
  staleSeconds: number;
  retentionDays: number;
  maxPrecision: Precision;
  /** Default precision for history tools (recent_locations, where_was_i_recently, movement_since). */
  historyPrecision: Precision;
  port: number;
  publicUrl: string;
  pruneConfirm: boolean;
  /** L2: periodic RotateCookies */
  cookieRotation: boolean;
  rotateMinIntervalSec: number;
  /** L4: on auth failure, refresh cookies from the persistent browser profile */
  browserRefresh: boolean;
  browserProfile: string;
}

export function assertLiveDbPath(p: string): string {
  if (p === ":memory:") return p;
  const abs = resolve(p);
  const segs = abs.split(sep);
  const base = basename(abs);
  // Defence in depth for the hard separation rule: never accept a path that looks like the
  // historical Timeline index.
  if (/timeline/i.test(base) || segs.slice(-3, -1).some((s) => /^timeline/i.test(s))) {
    throw new Error("LIVE_MCP_DB must not point at a Timeline database; live observations use their own SQLite file");
  }
  return abs;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<LiveConfig> = {}): LiveConfig {
  const num = (name: string, def: number) => {
    const v = env[name];
    if (v === undefined || v === "") return def;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number`);
    return n;
  };
  const bool = (name: string, def: boolean) => {
    const v = (env[name] ?? "").trim().toLowerCase();
    if (v === "") return def;
    return ["1", "true", "yes", "on"].includes(v);
  };
  const home = platformHome();
  const dbRaw = env.LIVE_MCP_DB ? expandHome(env.LIVE_MCP_DB) : join(home, "live-location", "live.sqlite");
  const maxPrecision = (env.LIVE_MAX_PRECISION || "exact") as Precision;
  if (!["semantic", "approximate", "exact"].includes(maxPrecision)) throw new Error("LIVE_MAX_PRECISION must be semantic|approximate|exact");
  const historyPrecision = (env.LIVE_DEFAULT_PRECISION || "approximate") as Precision;
  if (!["approximate", "exact"].includes(historyPrecision)) throw new Error("LIVE_DEFAULT_PRECISION must be approximate|exact");
  const source = env.LIVE_SOURCE || "google";
  if (source !== "google" && source !== "synthetic") throw new Error("LIVE_SOURCE must be google|synthetic");

  const pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, num("LIVE_POLL_INTERVAL", 60_000));
  const backoffMaxMs = Math.max(pollIntervalMs, num("LIVE_BACKOFF_MAX", 15 * 60_000));
  const retentionDays = num("LIVE_RETENTION_DAYS", 7);
  if (!(retentionDays >= 1)) throw new Error("LIVE_RETENTION_DAYS must be >= 1");
  const staleSeconds = num("LIVE_STALE_SECONDS", 300);
  if (!(staleSeconds >= 1)) throw new Error("LIVE_STALE_SECONDS must be >= 1");

  const cfg: LiveConfig = {
    dbPath: assertLiveDbPath(dbRaw),
    source,
    cookiesFile: resolve(expandHome(env.LIVE_COOKIES_FILE || join(home, "secrets", "live", "cookies.txt"))),
    sharerId: env.LIVE_SHARER_ID || undefined,
    pb: env.LIVE_PB || undefined,
    pollIntervalMs,
    backoffMaxMs,
    staleSeconds,
    retentionDays,
    maxPrecision,
    historyPrecision,
    port: num("LIVE_MCP_PORT", 8702),
    publicUrl: env.LIVE_MCP_PUBLIC_URL || "http://localhost:8702",
    pruneConfirm: ["1", "true", "yes", "on"].includes((env.LIVE_PRUNE_CONFIRM ?? "").toLowerCase()),
    cookieRotation: bool("LIVE_COOKIE_ROTATION", true),
    rotateMinIntervalSec: Math.max(60, num("LIVE_ROTATE_MIN_INTERVAL_SEC", 540)),
    browserRefresh: bool("LIVE_BROWSER_REFRESH", true),
    browserProfile: resolve(expandHome(env.LIVE_BROWSER_PROFILE || join(home, "secrets", "live", "browser-profile"))),
    ...overrides,
  };
  if (overrides.dbPath) cfg.dbPath = assertLiveDbPath(overrides.dbPath);
  return cfg;
}
