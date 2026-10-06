/**
 * One poll = fetchLatest → insert new observations (dedup) → record poll_attempt → update meta.
 * Errors never escape `pollOnce`; they turn into a longer delay before the next attempt.
 * NOTHING here deletes data: retention is applied only by the explicit `prune` command.
 */
import type { Logger } from "@location/shared";
import type { LiveConfig } from "./config.ts";
import type { LiveDb } from "./db.ts";
import { RateLimitError, SourceError, type ErrorKind, type LiveLocationSource } from "./source.ts";

export interface PollOutcome {
  ok: boolean;
  errorKind: ErrorKind | null;
  fetched: number;
  inserted: number;
  duplicates: number;
  /** ms to wait before the next poll. */
  nextDelayMs: number;
  consecutiveFailures: number;
}

export interface BackoffOptions {
  pollIntervalMs: number;
  backoffMaxMs: number;
}

/**
 * Delay until the next poll after `failures` consecutive failures (>=1).
 * interval * 2^failures, capped. Auth/config failures need a human, so they go straight to the cap.
 * A server-provided Retry-After is honoured (still capped).
 */
export function computeBackoffMs(cfg: BackoffOptions, failures: number, kind: ErrorKind, retryAfterMs?: number): number {
  if (failures <= 0) return cfg.pollIntervalMs;
  if (kind === "auth" || kind === "config") return cfg.backoffMaxMs;
  const exp = cfg.pollIntervalMs * 2 ** Math.min(failures, 30);
  return Math.min(cfg.backoffMaxMs, Math.max(exp, retryAfterMs ?? 0));
}

/** Optional keepalive hooks (all failures are contained; they never throw out of a poll). */
export interface PollerHooks {
  /** L2: rotate cookies if due (the hook owns due/guard logic). */
  rotate?: () => Promise<{ ok: boolean; errorKind?: ErrorKind; skipped?: string }>;
  /** L4: refresh the cookies file from the persistent browser profile. */
  browserRefresh?: { enabled: () => boolean; run: () => Promise<void> };
}

/** At most one browser refresh attempt per this window. */
export const BROWSER_REFRESH_MIN_INTERVAL_MS = 30 * 60_000;
interface Deferred {
  deferred: unknown;
}

export class Poller {
  private inflight: Promise<PollOutcome> | null = null;
  constructor(
    private readonly db: LiveDb,
    private readonly source: LiveLocationSource,
    private readonly cfg: Pick<LiveConfig, "pollIntervalMs" | "backoffMaxMs" | "staleSeconds">,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
    private readonly hooks: PollerHooks = {},
  ) {}

  /** Single-flight: concurrent callers share one in-progress poll. */
  pollOnce(): Promise<PollOutcome> {
    if (!this.inflight) {
      this.inflight = this.doPoll().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async doPoll(): Promise<PollOutcome> {
    let refreshed = false;
    if (this.hooks.rotate) {
      try {
        const r = await this.hooks.rotate();
        if (!r.ok && r.errorKind === "auth") refreshed = (await this.tryBrowserRefresh()) || refreshed;
      } catch {
        this.log.warn("cookie_rotation.hook_failed");
      }
    }
    const first = await this.runPoll(!refreshed && this.canBrowserRefresh());
    if (!("deferred" in first)) return first;
    // Auth failure: one browser refresh (rate limited); on success exactly one re-poll,
    // otherwise record the original failure without contacting Google again.
    const did = await this.tryBrowserRefresh();
    const second = (await this.runPoll(false, did ? undefined : { err: first.deferred })) as PollOutcome;
    if (did) this.log.info("poll.after_browser_refresh", { ok: second.ok });
    return second;
  }

  private canBrowserRefresh(): boolean {
    const h = this.hooks.browserRefresh;
    if (!h || !h.enabled()) return false;
    const last = this.db.getMetaNumber("browser_refresh_last_attempt_ms");
    return last == null || this.now() - last >= BROWSER_REFRESH_MIN_INTERVAL_MS;
  }

  /** Returns true if a refresh was attempted AND succeeded. */
  private async tryBrowserRefresh(): Promise<boolean> {
    if (!this.canBrowserRefresh()) return false;
    const h = this.hooks.browserRefresh!;
    const now = this.now();
    this.db.setMeta("browser_refresh_last_attempt_ms", now);
    try {
      await h.run();
      this.db.setMeta("browser_refresh_last_ok_ms", now);
      this.db.setMeta("browser_refresh_last_error", null);
      this.log.info("browser_refresh.ok");
      return true;
    } catch (e) {
      const code = (e as { code?: string }).code ?? "failed";
      this.db.setMeta("browser_refresh_last_error", code);
      this.log.warn("browser_refresh.failed", { code });
      return false;
    }
  }

  private async runPoll(deferAuth: boolean, replay?: { err: unknown }): Promise<PollOutcome | Deferred> {
    const started = this.now();
    const prevFailures = this.db.getMetaNumber("consecutive_failures") ?? 0;
    try {
      if (replay) throw replay.err;
      const obs = await this.source.fetchLatest();
      const { inserted, duplicates } = this.db.insertObservations(obs, started, this.cfg.staleSeconds);
      const newest = obs.length ? Math.max(...obs.map((o) => o.source_ts_ms)) : null;
      const delay = this.cfg.pollIntervalMs;
      this.db.recordPollAttempt({
        started_at_ms: started,
        finished_at_ms: this.now(),
        ok: true,
        observation_count: obs.length,
        source_ts_ms: newest,
        backoff_ms: delay,
      });
      this.db.setMeta("auth_state", "ok");
      this.db.setMeta("sharing_state", "active");
      this.db.setMeta("last_success_ms", started);
      this.db.setMeta("consecutive_failures", 0);
      this.db.setMeta("last_error_kind", null);
      this.db.setMeta("current_backoff_ms", delay);
      this.log.info("poll.ok", { fetched: obs.length, inserted, duplicates });
      return { ok: true, errorKind: null, fetched: obs.length, inserted, duplicates, nextDelayMs: delay, consecutiveFailures: 0 };
    } catch (e) {
      const err = e instanceof SourceError ? e : null;
      const kind: ErrorKind = err?.kind ?? "unexpected";
      if (kind === "sharing_lapsed") {
        // Authenticated fine; nobody is sharing right now. Not a failure, just no data.
        const delay = this.cfg.pollIntervalMs;
        this.db.recordPollAttempt({
          started_at_ms: started,
          finished_at_ms: this.now(),
          ok: true,
          error_kind: "sharing_lapsed",
          observation_count: 0,
          backoff_ms: delay,
        });
        this.db.setMeta("auth_state", "ok");
        this.db.setMeta("sharing_state", "lapsed");
        this.db.setMeta("last_success_ms", started);
        this.db.setMeta("consecutive_failures", 0);
        this.db.setMeta("last_error_kind", "sharing_lapsed");
        this.db.setMeta("current_backoff_ms", delay);
        this.log.warn("poll.sharing_lapsed");
        return { ok: true, errorKind: "sharing_lapsed", fetched: 0, inserted: 0, duplicates: 0, nextDelayMs: delay, consecutiveFailures: 0 };
      }
      if (kind === "auth" && deferAuth) return { deferred: e };
      const failures = prevFailures + 1;
      const retryAfter = e instanceof RateLimitError ? e.retryAfterMs : undefined;
      const delay = computeBackoffMs(this.cfg, failures, kind, retryAfter);
      this.db.recordPollAttempt({
        started_at_ms: started,
        finished_at_ms: this.now(),
        ok: false,
        http_status: err?.status ?? null,
        error_kind: kind,
        observation_count: 0,
        backoff_ms: delay,
      });
      this.db.setMeta("consecutive_failures", failures);
      this.db.setMeta("last_error_kind", kind);
      this.db.setMeta("current_backoff_ms", delay);
      if (kind === "auth") this.db.setMeta("auth_state", "expired");
      // Log the error class and a safe, source-authored message only (messages never contain
      // cookies or coordinates by construction; the logger also redacts).
      this.log.warn("poll.failed", { kind, status: err?.status, message: err?.message ?? "unexpected error", failures, next_delay_ms: delay });
      return { ok: false, errorKind: kind, fetched: 0, inserted: 0, duplicates: 0, nextDelayMs: delay, consecutiveFailures: failures };
    }
  }
}

/**
 * Daemon loop. Sleeps with unref'd timers (never blocks shutdown) while one ref'd keep-alive
 * keeps the process running until `signal` aborts. Does NOT prune.
 */
export async function runDaemon(poller: Poller, signal: AbortSignal, log: Logger, sleep = abortableSleep): Promise<void> {
  const keepAlive = setInterval(() => {}, 3_600_000);
  try {
    while (!signal.aborted) {
      const out = await poller.pollOnce();
      await sleep(out.nextDelayMs, signal);
    }
  } finally {
    clearInterval(keepAlive);
    log.info("daemon.stopped");
  }
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    t.unref();
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
