/**
 * live-location-mcp's OWN SQLite database (raw point observations + poll bookkeeping).
 * It never opens, attaches or reads any other project's database.
 */
import { isoUtc, openDatabase, transaction, type Database } from "@location/shared";
import { SYNTHETIC_PERSON_PREFIX, type Observation } from "./source.ts";

const OUR_TABLES = new Set(["observations", "poll_attempts", "meta", "sqlite_sequence"]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT NOT NULL,
  source_ts_ms INTEGER NOT NULL,
  observed_at_iso TEXT NOT NULL,
  polled_at_ms INTEGER NOT NULL,
  polled_at_iso TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy_m REAL,
  address TEXT,
  country TEXT,
  battery_level REAL,
  battery_charging INTEGER,
  is_stale INTEGER NOT NULL DEFAULT 0,
  dedup_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_obs_source_ts ON observations(source_ts_ms);
CREATE INDEX IF NOT EXISTS idx_obs_polled_at ON observations(polled_at_ms);
CREATE INDEX IF NOT EXISTS idx_obs_person ON observations(person_id, source_ts_ms);

CREATE TABLE IF NOT EXISTS poll_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  http_status INTEGER,
  error_kind TEXT,
  observation_count INTEGER NOT NULL DEFAULT 0,
  source_ts_ms INTEGER,
  backoff_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_poll_started ON poll_attempts(started_at_ms);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export interface ObservationRow {
  id: number;
  person_id: string;
  source_ts_ms: number;
  observed_at_iso: string;
  polled_at_ms: number;
  polled_at_iso: string;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  address: string | null;
  country: string | null;
  battery_level: number | null;
  battery_charging: number | null;
  is_stale: number;
  dedup_key: string;
}

export interface PollAttemptRow {
  id: number;
  started_at_ms: number;
  finished_at_ms: number;
  ok: number;
  http_status: number | null;
  error_kind: string | null;
  observation_count: number;
  source_ts_ms: number | null;
  backoff_ms: number | null;
}

export interface PollAttemptInput {
  started_at_ms: number;
  finished_at_ms: number;
  ok: boolean;
  http_status?: number | null;
  error_kind?: string | null;
  observation_count: number;
  source_ts_ms?: number | null;
  backoff_ms?: number | null;
}

/** Observation is "stale" when its fix is older than `staleSeconds` relative to `nowMs`. */
export function isStale(sourceTsMs: number, nowMs: number, staleSeconds: number): boolean {
  return nowMs - sourceTsMs > staleSeconds * 1000;
}

/** Rows with source_ts_ms strictly older than this are outside retention. */
export function retentionCutoffMs(nowMs: number, retentionDays: number): number {
  if (!(retentionDays > 0) || !Number.isFinite(retentionDays)) throw new Error("retentionDays must be > 0");
  return nowMs - retentionDays * 86_400_000;
}

export class LiveDb {
  readonly db: Database;
  constructor(path: string) {
    this.db = openDatabase(path);
    this.assertOurs();
    this.db.exec(SCHEMA);
    this.db.exec("PRAGMA user_version=1;");
  }

  /** Refuse to adopt a database that contains tables we did not create (e.g. a Timeline index). */
  private assertOurs(): void {
    const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    const foreign = rows.filter((r) => !OUR_TABLES.has(r.name));
    if (foreign.length) {
      this.db.close();
      throw new Error("refusing to open: database contains tables that do not belong to live-location-mcp");
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- writes

  /**
   * Insert observations; a fix already stored (same person + source timestamp) is ignored.
   * `is_stale` here records whether the fix was already older than `staleSeconds` when we polled it.
   */
  insertObservations(obs: Observation[], polledAtMs: number, staleSeconds = 300): { inserted: number; duplicates: number } {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO observations
       (person_id, source_ts_ms, observed_at_iso, polled_at_ms, polled_at_iso, lat, lng, accuracy_m, address, country,
        battery_level, battery_charging, is_stale, dedup_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    let inserted = 0;
    transaction(this.db, () => {
      for (const o of obs) {
        const r = stmt.run(
          o.person_id,
          o.source_ts_ms,
          isoUtc(o.source_ts_ms),
          polledAtMs,
          isoUtc(polledAtMs),
          o.lat,
          o.lng,
          o.accuracy_m ?? null,
          o.address ?? null,
          o.country ?? null,
          o.battery_level ?? null,
          o.battery_charging == null ? null : o.battery_charging ? 1 : 0,
          isStale(o.source_ts_ms, polledAtMs, staleSeconds) ? 1 : 0,
          `${o.person_id}|${o.source_ts_ms}`,
        );
        inserted += Number(r.changes);
      }
    });
    return { inserted, duplicates: obs.length - inserted };
  }

  recordPollAttempt(a: PollAttemptInput): void {
    this.db
      .prepare(
        `INSERT INTO poll_attempts (started_at_ms, finished_at_ms, ok, http_status, error_kind, observation_count, source_ts_ms, backoff_ms)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(a.started_at_ms, a.finished_at_ms, a.ok ? 1 : 0, a.http_status ?? null, a.error_kind ?? null, a.observation_count, a.source_ts_ms ?? null, a.backoff_ms ?? null);
  }

  setMeta(key: string, value: string | number | null): void {
    this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value == null ? null : String(value));
  }

  // ---------------------------------------------------------------- reads

  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string | null } | undefined;
    return r?.value ?? null;
  }

  getMetaNumber(key: string): number | null {
    const v = this.getMeta(key);
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  count(personId?: string): number {
    const r = (personId
      ? this.db.prepare("SELECT COUNT(*) AS n FROM observations WHERE person_id=?").get(personId)
      : this.db.prepare("SELECT COUNT(*) AS n FROM observations").get()) as { n: number };
    return r.n;
  }

  /** True if any stored observation did not come from the synthetic generator. */
  hasNonSyntheticRows(): boolean {
    const r = this.db.prepare("SELECT 1 AS x FROM observations WHERE person_id NOT LIKE ? LIMIT 1").get(`${SYNTHETIC_PERSON_PREFIX}%`);
    return r !== undefined;
  }

  hasSyntheticRows(): boolean {
    return this.db.prepare("SELECT 1 AS x FROM observations WHERE person_id LIKE ? LIMIT 1").get(`${SYNTHETIC_PERSON_PREFIX}%`) !== undefined;
  }

  latest(personId?: string): ObservationRow | null {
    const r = personId
      ? this.db.prepare("SELECT * FROM observations WHERE person_id=? ORDER BY source_ts_ms DESC, id DESC LIMIT 1").get(personId)
      : this.db.prepare("SELECT * FROM observations ORDER BY source_ts_ms DESC, id DESC LIMIT 1").get();
    return (r as unknown as ObservationRow | undefined) ?? null;
  }

  oldest(personId?: string): ObservationRow | null {
    const r = personId
      ? this.db.prepare("SELECT * FROM observations WHERE person_id=? ORDER BY source_ts_ms ASC, id ASC LIMIT 1").get(personId)
      : this.db.prepare("SELECT * FROM observations ORDER BY source_ts_ms ASC, id ASC LIMIT 1").get();
    return (r as unknown as ObservationRow | undefined) ?? null;
  }

  /** Observations with startMs <= source_ts_ms <= endMs, chronological. */
  range(startMs: number, endMs: number, personId?: string, hardLimit = 100_000): ObservationRow[] {
    const sql = `SELECT * FROM observations WHERE source_ts_ms >= ? AND source_ts_ms <= ? ${personId ? "AND person_id = ?" : ""}
                 ORDER BY source_ts_ms ASC, id ASC LIMIT ?`;
    const params = personId ? [startMs, endMs, personId, hardLimit] : [startMs, endMs, hardLimit];
    return this.db.prepare(sql).all(...params) as unknown as ObservationRow[];
  }

  countRange(startMs: number, endMs: number, personId?: string): number {
    const sql = `SELECT COUNT(*) AS n FROM observations WHERE source_ts_ms >= ? AND source_ts_ms <= ? ${personId ? "AND person_id = ?" : ""}`;
    const r = this.db.prepare(sql).get(...(personId ? [startMs, endMs, personId] : [startMs, endMs])) as { n: number };
    return r.n;
  }

  /** Observation whose source timestamp is closest to `ts` (ties → the earlier one). */
  nearest(ts: number, personId?: string): ObservationRow | null {
    const f = personId ? "AND person_id = ?" : "";
    const p = (x: number) => (personId ? [x, personId] : [x]);
    const before = this.db
      .prepare(`SELECT * FROM observations WHERE source_ts_ms <= ? ${f} ORDER BY source_ts_ms DESC, id DESC LIMIT 1`)
      .get(...p(ts)) as unknown as ObservationRow | undefined;
    const after = this.db
      .prepare(`SELECT * FROM observations WHERE source_ts_ms >= ? ${f} ORDER BY source_ts_ms ASC, id ASC LIMIT 1`)
      .get(...p(ts)) as unknown as ObservationRow | undefined;
    if (!before) return after ?? null;
    if (!after) return before;
    return ts - before.source_ts_ms <= after.source_ts_ms - ts ? before : after;
  }

  latestPollAttempt(): PollAttemptRow | null {
    return (this.db.prepare("SELECT * FROM poll_attempts ORDER BY id DESC LIMIT 1").get() as unknown as PollAttemptRow | undefined) ?? null;
  }

  latestSuccessfulPoll(): PollAttemptRow | null {
    return (this.db.prepare("SELECT * FROM poll_attempts WHERE ok=1 ORDER BY id DESC LIMIT 1").get() as unknown as PollAttemptRow | undefined) ?? null;
  }

  // ---------------------------------------------------------------- retention

  /** How many observations are older than `cutoffMs` (selection only; deletes nothing). */
  countOlderThan(cutoffMs: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM observations WHERE source_ts_ms < ?").get(cutoffMs) as { n: number }).n;
  }

  /** Ids of expired observations (for tests / dry-run introspection). */
  selectOlderThan(cutoffMs: number): number[] {
    return (this.db.prepare("SELECT id FROM observations WHERE source_ts_ms < ? ORDER BY id").all(cutoffMs) as { id: number }[]).map((r) => r.id);
  }

  /** Explicit deletion. Only ever called by the `prune` command (never by the daemon). */
  deleteOlderThan(cutoffMs: number): { observations: number; poll_attempts: number } {
    let o = 0;
    let p = 0;
    transaction(this.db, () => {
      o = Number(this.db.prepare("DELETE FROM observations WHERE source_ts_ms < ?").run(cutoffMs).changes);
      p = Number(this.db.prepare("DELETE FROM poll_attempts WHERE started_at_ms < ?").run(cutoffMs).changes);
    });
    return { observations: o, poll_attempts: p };
  }
}
