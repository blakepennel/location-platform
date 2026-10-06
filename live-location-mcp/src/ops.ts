/** Operator actions behind the CLI (kept separate so tests can drive them directly). */
import { existsSync } from "node:fs";
import { isoUtc, type Logger } from "@location/shared";
import { exportCookiesFromProfile, findChrome, refreshProfileSession } from "./browser-session.ts";
import type { PollerHooks } from "./poller.ts";
import { rotateIfDue } from "./rotate.ts";
import type { LiveConfig } from "./config.ts";
import { retentionCutoffMs, type LiveDb } from "./db.ts";
import { GoogleLocationSharingSource } from "./google.ts";
import { SyntheticLiveSource, type LiveLocationSource } from "./source.ts";

export function createSource(config: LiveConfig, logger?: Logger): LiveLocationSource {
  if (config.source === "synthetic") return new SyntheticLiveSource();
  return new GoogleLocationSharingSource({ cookiesFile: config.cookiesFile, sharerId: config.sharerId, pb: config.pb, logger });
}

/** After a human login: export cookies.txt from the profile's cookie database (no browser launch). */
export function exportFromProfile(config: LiveConfig, logger?: Logger) {
  return exportCookiesFromProfile({ profileDir: config.browserProfile, cookiesFile: config.cookiesFile, logger });
}

/** L4 keepalive: let a plain browser refresh the profile's session, then export cookies.txt. */
export function refreshFromBrowser(config: LiveConfig, logger?: Logger) {
  return refreshProfileSession({ profileDir: config.browserProfile, cookiesFile: config.cookiesFile, chromePath: findChrome(), logger });
}

/** L2 + L4 hooks for the poller (none for the synthetic source). */
export function createPollerHooks(config: LiveConfig, db: LiveDb, logger?: Logger): PollerHooks {
  if (config.source !== "google") return {};
  return {
    rotate: config.cookieRotation ? () => rotateIfDue({ db, cookiesFile: config.cookiesFile, minIntervalSec: config.rotateMinIntervalSec, logger }) : undefined,
    browserRefresh: config.browserRefresh
      ? { enabled: () => existsSync(config.browserProfile), run: async () => void (await refreshFromBrowser(config, logger)) }
      : undefined,
  };
}

/** Never let generated data mix with (or be mistaken for) real observations. */
export function assertSyntheticSafe(db: LiveDb, allowMix = process.env.LIVE_ALLOW_SYNTHETIC_MIX === "true"): void {
  if (!allowMix && db.hasNonSyntheticRows()) {
    throw new Error("refusing to write synthetic observations into a database that contains real observations (use a separate LIVE_MCP_DB)");
  }
}

/** Insert `count` synthetic observations ending now (dev/testing). */
export function simulate(db: LiveDb, config: LiveConfig, count: number, now = Date.now()): { inserted: number; newest_observed_at: string } {
  if (!Number.isInteger(count) || count < 1 || count > 100_000) throw new Error("--count must be an integer between 1 and 100000");
  assertSyntheticSafe(db);
  const obs = new SyntheticLiveSource().generate(count, now);
  const r = db.insertObservations(obs, now, config.staleSeconds);
  db.setMeta("auth_state", "ok");
  db.setMeta("last_success_ms", now);
  return { inserted: r.inserted, newest_observed_at: isoUtc(obs[obs.length - 1].source_ts_ms) };
}

export interface PruneResult {
  dry_run: boolean;
  retention_days: number;
  cutoff: string;
  would_delete: number;
  total_before: number;
  deleted?: { observations: number; poll_attempts: number };
  remaining?: number;
}

/**
 * Retention. Dry-run unless `yes` (or config.pruneConfirm). This is the ONLY code path that
 * deletes observations; the daemon never calls it.
 */
export function prune(db: LiveDb, config: LiveConfig, opts: { yes?: boolean; now?: number } = {}): PruneResult {
  const now = opts.now ?? Date.now();
  const cutoff = retentionCutoffMs(now, config.retentionDays);
  const wouldDelete = db.countOlderThan(cutoff);
  const total = db.count();
  const res: PruneResult = {
    dry_run: true,
    retention_days: config.retentionDays,
    cutoff: isoUtc(cutoff),
    would_delete: wouldDelete,
    total_before: total,
  };
  if (!(opts.yes || config.pruneConfirm)) return res;
  const deleted = db.deleteOlderThan(cutoff);
  return { ...res, dry_run: false, deleted, remaining: db.count() };
}
