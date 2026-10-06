import { loadConfig, type LiveConfig } from "../src/config.ts";
import { LiveDb } from "../src/db.ts";
import type { Observation } from "../src/source.ts";

export function testConfig(overrides: Partial<LiveConfig> = {}): LiveConfig {
  return loadConfig({ LIVE_SOURCE: "synthetic" } as NodeJS.ProcessEnv, { dbPath: ":memory:", ...overrides });
}

export function memDb(): LiveDb {
  return new LiveDb(":memory:");
}

export const PERSON = "synthetic-person-1";

/** Synthetic observation near (10.x, 20.x). */
export function obs(tsMs: number, lat = 10.1, lng = 20.1, extra: Partial<Observation> = {}): Observation {
  return { person_id: PERSON, source_ts_ms: tsMs, lat, lng, accuracy_m: 10, ...extra };
}

export const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  location() {},
};
