/** Streamable HTTP host for timeline-mcp: OAuth-protected /mcp, non-sensitive /healthz. */
import { authConfigFromEnv, type AccessTokenVerifier, type ResourceServerAuthConfig } from "@location/mcp-auth";
import { createMcpHttpApp, freshnessSeconds, mcpResourceUrl, type Logger } from "@location/shared";
import { REQUIRED_SCOPE, type Config } from "./config.ts";
import { getMetaJson, type Database } from "./db.ts";
import { tableCounts, type IndexManager } from "./indexer.ts";
import { coverage } from "./queries.ts";
import type { SyncStatus } from "./source.ts";
import { buildServer } from "./tools.ts";

/**
 * /healthz payload. Deliberately minimal and unauthenticated-safe: status, whether an index exists,
 * record counts, and two ages in seconds. Never coordinates, place names, paths or error text.
 */
export function healthPayload(db: Database, now = Date.now()): Record<string, unknown> {
  const counts = tableCounts(db);
  const total = counts.visit + counts.activity + counts.timeline_path + counts.trip;
  const cov = coverage(db);
  const sync = getMetaJson<SyncStatus>(db, "sync_status");
  return {
    status: total > 0 ? "ok" : "no_data",
    index_present: total > 0,
    counts: { visits: counts.visit, activities: counts.activity, timeline_paths: counts.timeline_path, trips: counts.trip },
    newest_record_age_seconds: cov.newest_ms === null ? null : freshnessSeconds(new Date(cov.newest_ms).toISOString(), now),
    last_sync_age_seconds: freshnessSeconds(sync?.last_success_at ?? null, now),
  };
}

export interface TimelineHttpOptions {
  db: Database;
  config: Config;
  logger: Logger;
  index?: IndexManager;
  /** Test hooks. In production auth comes from MCP_AUTH_* env (authConfigFromEnv). */
  auth?: Omit<ResourceServerAuthConfig, "resource">;
  verifier?: AccessTokenVerifier;
  now?: () => number;
  rateLimitPerMinute?: number;
}

export function createTimelineHttpApp(o: TimelineHttpOptions) {
  const resource = mcpResourceUrl(o.config.publicUrl);
  const auth = o.auth ?? authConfigFromEnv({ resource, requiredScopes: [REQUIRED_SCOPE] });
  return createMcpHttpApp({
    name: "timeline-mcp",
    publicUrl: o.config.publicUrl,
    auth,
    verifier: o.verifier,
    buildServer: () => buildServer({ db: o.db, config: o.config, logger: o.logger, index: o.index, now: o.now }),
    health: () => healthPayload(o.db, o.now?.() ?? Date.now()),
    logger: o.logger,
    rateLimitPerMinute: o.rateLimitPerMinute,
  });
}
