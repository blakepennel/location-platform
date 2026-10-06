/**
 * Source abstraction: everything Google-specific lives behind `LiveLocationSource`
 * (see google.ts). The poller, DB and tools only ever see normalized raw observations.
 */

export interface Observation {
  /** Stable id of the person sharing (opaque; never returned by MCP tools). */
  person_id: string;
  /** Timestamp of the fix as reported by the source (epoch ms). */
  source_ts_ms: number;
  lat: number;
  lng: number;
  accuracy_m?: number;
  address?: string;
  country?: string;
  battery_level?: number;
  battery_charging?: boolean;
  display_name?: string;
  nickname?: string;
}

export interface SourceDescription {
  kind: "google_location_sharing" | "synthetic" | string;
  /** Non-secret facts only (never cookie values or coordinates). */
  details: Record<string, unknown>;
}

export interface LiveLocationSource {
  fetchLatest(): Promise<Observation[]>;
  describe(): SourceDescription;
}

/** Stable, non-sensitive category names stored in the DB and shown by location_status. */
export type ErrorKind = "auth" | "rate_limit" | "sharing_lapsed" | "transient" | "format" | "config" | "unexpected";

export abstract class SourceError extends Error {
  abstract readonly kind: ErrorKind;
  /** HTTP status when the failure came from an HTTP response. */
  status?: number;
  constructor(message: string, opts: { status?: number } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = opts.status;
  }
}

/** Cookies missing/expired/rejected: needs a human to re-export cookies. */
export class AuthError extends SourceError {
  readonly kind = "auth" as const;
}
/** HTTP 429/503 style throttling. */
export class RateLimitError extends SourceError {
  readonly kind = "rate_limit" as const;
  retryAfterMs?: number;
  constructor(message: string, opts: { status?: number; retryAfterMs?: number } = {}) {
    super(message, opts);
    this.retryAfterMs = opts.retryAfterMs;
  }
}
/** Authenticated fine, but nobody (or not the configured sharer) is currently sharing. */
export class SharingLapsedError extends SourceError {
  readonly kind = "sharing_lapsed" as const;
}
/** Network trouble, 5xx, timeouts. */
export class TransientError extends SourceError {
  readonly kind: ErrorKind = "transient";
}
/** Response parsed as JSON but did not have the expected layout (Google changed something). */
export class FormatError extends TransientError {
  readonly kind = "format" as const;
}
/** Configuration problem, e.g. several sharers and LIVE_SHARER_ID unset. Message lists ids only. */
export class SharerSelectionError extends SourceError {
  readonly kind = "config" as const;
  readonly available: string[];
  constructor(message: string, available: string[]) {
    super(message);
    this.available = available;
  }
}

// ------------------------------------------------------------------ synthetic source

export const SYNTHETIC_PERSON_PREFIX = "synthetic-";

export interface SyntheticOptions {
  personId?: string;
  startLat?: number;
  startLng?: number;
  /** Epoch ms of the first generated fix. Default: now (at construction), rounded to the second. */
  baseMs?: number;
  stepMs?: number;
  /** Per-step displacement in degrees. */
  dLat?: number;
  dLng?: number;
}

/**
 * Deterministic generator producing a slowly moving track near (10.x, 20.x).
 * Every `fetchLatest()` call yields the *next* fix in the track, like a phone moving.
 */
export class SyntheticLiveSource implements LiveLocationSource {
  private i = 0;
  private readonly o: Required<SyntheticOptions>;
  constructor(opts: SyntheticOptions = {}) {
    this.o = {
      personId: opts.personId ?? `${SYNTHETIC_PERSON_PREFIX}person-1`,
      startLat: opts.startLat ?? 10.1,
      startLng: opts.startLng ?? 20.1,
      baseMs: opts.baseMs ?? Math.floor(Date.now() / 1000) * 1000,
      stepMs: opts.stepMs ?? 60_000,
      dLat: opts.dLat ?? 0.0004,
      dLng: opts.dLng ?? 0.0003,
    };
  }

  /** Fix number `i` of the track (pure function of i and options). */
  at(i: number): Observation {
    const o = this.o;
    const wobble = Math.sin(i * 1.7) * 0.00002;
    return {
      person_id: o.personId,
      source_ts_ms: o.baseMs + i * o.stepMs,
      lat: round7(o.startLat + i * o.dLat + wobble),
      lng: round7(o.startLng + i * o.dLng - wobble),
      accuracy_m: 10 + (i % 5) * 5,
      country: "ZZ",
      battery_level: Math.max(5, 90 - (i % 80)),
      battery_charging: i % 20 >= 15,
      display_name: "Synthetic Sharer",
    };
  }

  /** `count` chronological fixes ending at `endMs` (used by `simulate`). */
  generate(count: number, endMs: number): Observation[] {
    const base = endMs - (count - 1) * this.o.stepMs;
    const gen = new SyntheticLiveSource({ ...this.o, baseMs: base });
    return Array.from({ length: count }, (_, i) => gen.at(i));
  }

  async fetchLatest(): Promise<Observation[]> {
    return [this.at(this.i++)];
  }

  describe(): SourceDescription {
    return { kind: "synthetic", details: { step_seconds: this.o.stepMs / 1000 } };
  }
}

function round7(n: number): number {
  return Math.round(n * 1e7) / 1e7;
}
