import { describe, expect, it } from "vitest";
import { Poller, computeBackoffMs, runDaemon } from "../src/poller.ts";
import {
  AuthError,
  FormatError,
  RateLimitError,
  SharerSelectionError,
  SharingLapsedError,
  SyntheticLiveSource,
  TransientError,
  type LiveLocationSource,
  type Observation,
} from "../src/source.ts";
import { memDb, obs, silentLogger, testConfig } from "./helpers.ts";

const NOW = Date.UTC(2026, 0, 20, 12, 0, 0);
const cfg = testConfig({ pollIntervalMs: 60_000, backoffMaxMs: 15 * 60_000, staleSeconds: 300 });

class ScriptedSource implements LiveLocationSource {
  calls = 0;
  constructor(private script: Array<Observation[] | Error>) {}
  async fetchLatest(): Promise<Observation[]> {
    const step = this.script[Math.min(this.calls++, this.script.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  }
  describe() {
    return { kind: "fake", details: {} };
  }
}

function mk(script: Array<Observation[] | Error>, now = () => NOW) {
  const db = memDb();
  const src = new ScriptedSource(script);
  return { db, src, poller: new Poller(db, src, cfg, silentLogger, now) };
}

describe("computeBackoffMs", () => {
  const o = { pollIntervalMs: 60_000, backoffMaxMs: 900_000 };
  it("doubles per failure up to the cap", () => {
    expect(computeBackoffMs(o, 0, "transient")).toBe(60_000);
    expect(computeBackoffMs(o, 1, "transient")).toBe(120_000);
    expect(computeBackoffMs(o, 2, "transient")).toBe(240_000);
    expect(computeBackoffMs(o, 3, "rate_limit")).toBe(480_000);
    expect(computeBackoffMs(o, 4, "transient")).toBe(900_000);
    expect(computeBackoffMs(o, 50, "transient")).toBe(900_000);
  });
  it("auth/config go straight to the cap; Retry-After is honoured but capped", () => {
    expect(computeBackoffMs(o, 1, "auth")).toBe(900_000);
    expect(computeBackoffMs(o, 1, "config")).toBe(900_000);
    expect(computeBackoffMs(o, 1, "rate_limit", 300_000)).toBe(300_000);
    expect(computeBackoffMs(o, 1, "rate_limit", 99_999_999)).toBe(900_000);
  });
});

describe("Poller", () => {
  it("success inserts observations, records the attempt and resets backoff", async () => {
    const { db, poller } = mk([new TransientError("x"), [obs(NOW - 5000)]]);
    const bad = await poller.pollOnce();
    expect(bad.ok).toBe(false);
    expect(bad.nextDelayMs).toBe(120_000);
    expect(db.getMetaNumber("consecutive_failures")).toBe(1);

    const good = await poller.pollOnce();
    expect(good).toMatchObject({ ok: true, inserted: 1, fetched: 1, nextDelayMs: 60_000, consecutiveFailures: 0 });
    expect(db.count()).toBe(1);
    expect(db.getMeta("auth_state")).toBe("ok");
    expect(db.getMetaNumber("consecutive_failures")).toBe(0);
    expect(db.getMetaNumber("current_backoff_ms")).toBe(60_000);
    expect(db.getMetaNumber("last_success_ms")).toBe(NOW);
    expect(db.getMeta("last_error_kind")).toBeNull();
    const a = db.latestPollAttempt()!;
    expect(a).toMatchObject({ ok: 1, observation_count: 1, source_ts_ms: NOW - 5000, error_kind: null });
  });

  it("re-polling the same fix does not insert twice", async () => {
    const same = obs(NOW - 1000);
    const { db, poller } = mk([[same]]);
    expect((await poller.pollOnce()).inserted).toBe(1);
    const second = await poller.pollOnce();
    expect(second).toMatchObject({ ok: true, inserted: 0, duplicates: 1 });
    expect(db.count()).toBe(1);
  });

  it("AuthError sets auth_state=expired, backs off to the maximum, and does not throw", async () => {
    const { db, poller } = mk([new AuthError("cookies dead")]);
    const r = await poller.pollOnce();
    expect(r).toMatchObject({ ok: false, errorKind: "auth", nextDelayMs: 15 * 60_000 });
    expect(db.getMeta("auth_state")).toBe("expired");
    expect(db.getMeta("last_error_kind")).toBe("auth");
    expect(db.latestPollAttempt()).toMatchObject({ ok: 0, error_kind: "auth", backoff_ms: 15 * 60_000 });
    // recovery
    const p2 = mk([new AuthError("x"), [obs(NOW)]]);
    await p2.poller.pollOnce();
    await p2.poller.pollOnce();
    expect(p2.db.getMeta("auth_state")).toBe("ok");
  });

  it("RateLimitError / TransientError grow the backoff on repeated failure", async () => {
    const { db, poller } = mk([new RateLimitError("429", { status: 429 }), new TransientError("net"), new FormatError("shape"), new TransientError("net")]);
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) delays.push((await poller.pollOnce()).nextDelayMs);
    expect(delays).toEqual([120_000, 240_000, 480_000, 900_000]);
    expect(db.getMetaNumber("consecutive_failures")).toBe(4);
    expect(db.getMeta("auth_state")).toBeNull(); // not an auth problem
    expect(db.latestPollAttempt()).toMatchObject({ ok: 0, error_kind: "transient" });
  });

  it("records the HTTP status and honours Retry-After", async () => {
    const { db, poller } = mk([new RateLimitError("429", { status: 429, retryAfterMs: 400_000 })]);
    const r = await poller.pollOnce();
    expect(r.nextDelayMs).toBe(400_000);
    expect(db.latestPollAttempt()).toMatchObject({ http_status: 429, error_kind: "rate_limit" });
  });

  it("SharingLapsedError is a successful poll with zero observations", async () => {
    const { db, poller } = mk([new SharingLapsedError("nobody")]);
    const r = await poller.pollOnce();
    expect(r).toMatchObject({ ok: true, fetched: 0, inserted: 0, errorKind: "sharing_lapsed", nextDelayMs: 60_000 });
    expect(db.getMeta("sharing_state")).toBe("lapsed");
    expect(db.getMeta("auth_state")).toBe("ok");
    expect(db.getMetaNumber("consecutive_failures")).toBe(0);
    expect(db.latestPollAttempt()).toMatchObject({ ok: 1, observation_count: 0, error_kind: "sharing_lapsed" });
  });

  it("sharer selection problems back off long and do not crash", async () => {
    const { poller } = mk([new SharerSelectionError("set LIVE_SHARER_ID to one of: a, b", ["a", "b"])]);
    expect(await poller.pollOnce()).toMatchObject({ ok: false, errorKind: "config", nextDelayMs: 15 * 60_000 });
  });

  it("unexpected errors are contained (kind=unexpected) and backoff", async () => {
    const { db, poller } = mk([new TypeError("boom")]);
    const r = await poller.pollOnce();
    expect(r).toMatchObject({ ok: false, errorKind: "unexpected", nextDelayMs: 120_000 });
    expect(db.getMeta("last_error_kind")).toBe("unexpected");
  });

  it("works with the SyntheticLiveSource", async () => {
    const db = memDb();
    const src = new SyntheticLiveSource({ baseMs: NOW - 10 * 60_000 });
    const poller = new Poller(db, src, cfg, silentLogger, () => NOW);
    for (let i = 0; i < 3; i++) expect((await poller.pollOnce()).inserted).toBe(1);
    expect(db.count()).toBe(3);
    const latest = db.latest()!;
    expect(latest.lat).toBeGreaterThan(10);
    expect(latest.lat).toBeLessThan(11);
    expect(latest.lng).toBeGreaterThan(20);
    expect(latest.lng).toBeLessThan(21);
  });

  it("single-flight: concurrent pollOnce calls share one fetch", async () => {
    const { src, poller } = mk([[obs(NOW)]]);
    const [a, b] = await Promise.all([poller.pollOnce(), poller.pollOnce()]);
    expect(a).toBe(b);
    expect(src.calls).toBe(1);
  });

  it("never deletes anything (retention is not applied by polling)", async () => {
    const { db, poller } = mk([[obs(NOW)]]);
    db.insertObservations([obs(NOW - 400 * 86_400_000)], NOW);
    await poller.pollOnce();
    expect(db.count()).toBe(2);
  });
});

describe("runDaemon", () => {
  it("polls, sleeps for nextDelayMs, and stops when aborted", async () => {
    const { src, poller } = mk([[obs(NOW)], new TransientError("x")]);
    const ac = new AbortController();
    const sleeps: number[] = [];
    await runDaemon(poller, ac.signal, silentLogger, async (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 3) ac.abort();
    });
    expect(src.calls).toBe(3);
    expect(sleeps).toEqual([60_000, 120_000, 240_000]);
  });
});
