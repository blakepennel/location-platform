/**
 * Operational status derived from the live DB. Never includes coordinates, addresses or ids.
 */
import { freshnessSeconds, humanDuration, isoUtc } from "@location/shared";
import type { LiveConfig } from "./config.ts";
import { isStale, type LiveDb } from "./db.ts";

const age = (ms: number | null, now: number): number | null => (ms == null ? null : Math.max(0, Math.round((now - ms) / 1000)));

export interface LiveStatus {
  latest_poll_at: string | null;
  latest_poll_age_seconds: number | null;
  latest_poll_ok: boolean | null;
  last_success_at: string | null;
  last_success_age_seconds: number | null;
  latest_observation_at: string | null;
  latest_observation_polled_at: string | null;
  latest_observation_age_seconds: number | null;
  latest_observation_age_human: string | null;
  stale: boolean | null;
  auth_state: "ok" | "expired" | "unknown";
  authenticated: boolean | null;
  sharing_state: "active" | "lapsed" | "unknown";
  consecutive_failures: number;
  last_error_kind: string | null;
  current_backoff_seconds: number | null;
  poll_interval_seconds: number;
  observation_count: number;
  oldest_observation_at: string | null;
  retention_days: number;
  stale_threshold_seconds: number;
  max_precision: string;
  /** L2/L4 keepalive; no cookie values */
  cookie_rotation: { enabled: boolean; last_ok_at: string | null; last_error_kind: string | null; last_browser_refresh_at: string | null };
}

export function getStatus(db: LiveDb, cfg: LiveConfig, now = Date.now(), personId?: string): LiveStatus {
  const poll = db.latestPollAttempt();
  const success = db.getMetaNumber("last_success_ms");
  const latest = db.latest(personId);
  const oldest = db.oldest(personId);
  const authRaw = db.getMeta("auth_state");
  const auth_state = authRaw === "ok" || authRaw === "expired" ? authRaw : "unknown";
  const sharingRaw = db.getMeta("sharing_state");
  const backoff = db.getMetaNumber("current_backoff_ms");
  const rotOk = db.getMetaNumber("cookie_rotation_last_ok_ms");
  const browserOk = db.getMetaNumber("browser_refresh_last_ok_ms");
  const obsAge = latest ? freshnessSeconds(latest.observed_at_iso, now) : null;
  return {
    latest_poll_at: poll ? isoUtc(poll.started_at_ms) : null,
    latest_poll_age_seconds: age(poll?.started_at_ms ?? null, now),
    latest_poll_ok: poll ? poll.ok === 1 : null,
    last_success_at: success != null ? isoUtc(success) : null,
    last_success_age_seconds: age(success, now),
    latest_observation_at: latest?.observed_at_iso ?? null,
    latest_observation_polled_at: latest?.polled_at_iso ?? null,
    latest_observation_age_seconds: obsAge,
    latest_observation_age_human: humanDuration(obsAge),
    stale: latest ? isStale(latest.source_ts_ms, now, cfg.staleSeconds) : null,
    auth_state,
    authenticated: auth_state === "unknown" ? null : auth_state === "ok",
    sharing_state: sharingRaw === "active" || sharingRaw === "lapsed" ? sharingRaw : "unknown",
    consecutive_failures: db.getMetaNumber("consecutive_failures") ?? 0,
    last_error_kind: db.getMeta("last_error_kind"),
    current_backoff_seconds: backoff == null ? null : Math.round(backoff / 1000),
    poll_interval_seconds: Math.round(cfg.pollIntervalMs / 1000),
    observation_count: db.count(personId),
    oldest_observation_at: oldest?.observed_at_iso ?? null,
    retention_days: cfg.retentionDays,
    stale_threshold_seconds: cfg.staleSeconds,
    max_precision: cfg.maxPrecision,
    cookie_rotation: {
      enabled: cfg.cookieRotation,
      last_ok_at: rotOk != null ? isoUtc(rotOk) : null,
      last_error_kind: db.getMeta("cookie_rotation_last_error_kind"),
      last_browser_refresh_at: browserOk != null ? isoUtc(browserOk) : null,
    },
  };
}

/** /healthz payload: no coordinates, no addresses, no ids. */
export function healthPayload(db: LiveDb, cfg: LiveConfig, now = Date.now()): Record<string, unknown> {
  const s = getStatus(db, cfg, now);
  const degraded = s.auth_state === "expired" || s.consecutive_failures > 0;
  return {
    status: s.observation_count === 0 && s.latest_poll_at == null ? "no_data" : degraded ? "degraded" : "ok",
    last_poll_age_seconds: s.latest_poll_age_seconds,
    last_success_age_seconds: s.last_success_age_seconds,
    consecutive_failures: s.consecutive_failures,
    authenticated: s.authenticated,
    observation_count: s.observation_count,
    cookie_rotation: s.cookie_rotation,
    newest_observation_age_seconds: s.latest_observation_age_seconds,
  };
}
