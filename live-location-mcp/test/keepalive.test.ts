import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GoogleLocationSharingSource } from "../src/google.ts";
import { BROWSER_REFRESH_MIN_INTERVAL_MS, Poller, type PollerHooks } from "../src/poller.ts";
import { rotateIfDue } from "../src/rotate.ts";
import { getStatus, healthPayload } from "../src/status.ts";
import { AuthError, TransientError, type LiveLocationSource, type Observation } from "../src/source.ts";
import { T0, fakeResponse } from "./fixtures.ts";
import { memDb, obs, silentLogger, testConfig } from "./helpers.ts";

// Everything here is injected/fake: no Google, no browser. Cookie values are FAKE.
const cfg = testConfig({ pollIntervalMs: 60_000, backoffMaxMs: 900_000, staleSeconds: 300 });
let NOW = Date.now();

class Scripted implements LiveLocationSource {
  calls = 0;
  constructor(private script: Array<Observation[] | Error>) {}
  async fetchLatest() {
    const s = this.script[Math.min(this.calls++, this.script.length - 1)];
    if (s instanceof Error) throw s;
    return s;
  }
  describe() {
    return { kind: "fake", details: {} };
  }
}
function mk(script: Array<Observation[] | Error>, hooks: PollerHooks) {
  const db = memDb();
  const src = new Scripted(script);
  return { db, src, poller: new Poller(db, src, cfg, silentLogger, () => NOW, hooks) };
}
function refresher(result: "ok" | "fail") {
  const r = { runs: 0, enabled: () => true, async run() {
    r.runs++;
    if (result === "fail") throw Object.assign(new Error("x"), { code: "not_signed_in" });
  } };
  return r;
}

beforeEach(() => {
  NOW = Date.now();
});

describe("Poller keepalive hooks", () => {
  it("runs rotation before the poll", async () => {
    const order: string[] = [];
    const src: LiveLocationSource = {
      async fetchLatest() {
        order.push("poll");
        return [obs(NOW - 1000)];
      },
      describe: () => ({ kind: "fake", details: {} }),
    };
    const p = new Poller(memDb(), src, cfg, silentLogger, () => NOW, { rotate: async () => (order.push("rotate"), { ok: true }) });
    await p.pollOnce();
    expect(order).toEqual(["rotate", "poll"]);
  });

  it("auth failure -> browser refresh once -> re-poll ok -> auth_state ok", async () => {
    const br = refresher("ok");
    const { db, src, poller } = mk([new AuthError("nope"), [obs(NOW - 1000)]], { browserRefresh: br });
    const out = await poller.pollOnce();
    expect(out.ok).toBe(true);
    expect(br.runs).toBe(1);
    expect(src.calls).toBe(2);
    expect(db.getMeta("auth_state")).toBe("ok");
    expect(db.getMetaNumber("browser_refresh_last_ok_ms")).toBe(NOW);
  });

  it("refresh failure -> auth_state expired, no extra poll", async () => {
    const br = refresher("fail");
    const { db, src, poller } = mk([new AuthError("nope")], { browserRefresh: br });
    const out = await poller.pollOnce();
    expect(out).toMatchObject({ ok: false, errorKind: "auth", consecutiveFailures: 1 });
    expect(br.runs).toBe(1);
    expect(src.calls).toBe(1);
    expect(db.getMeta("auth_state")).toBe("expired");
    expect(db.getMeta("browser_refresh_last_error")).toBe("not_signed_in");
  });

  it("refresh succeeds but re-poll still auth => expired, only one refresh", async () => {
    const br = refresher("ok");
    const { db, src, poller } = mk([new AuthError("nope")], { browserRefresh: br });
    const out = await poller.pollOnce();
    expect(out.ok).toBe(false);
    expect(br.runs).toBe(1);
    expect(src.calls).toBe(2);
    expect(db.getMeta("auth_state")).toBe("expired");
  });

  it("browser refresh is rate limited to once per 30 minutes", async () => {
    const br = refresher("fail");
    const { src, poller } = mk([new AuthError("nope")], { browserRefresh: br });
    await poller.pollOnce();
    NOW += 5 * 60_000;
    await poller.pollOnce();
    expect(br.runs).toBe(1);
    expect(src.calls).toBe(2); // second poll: single fetch, no re-poll
    NOW += BROWSER_REFRESH_MIN_INTERVAL_MS;
    await poller.pollOnce();
    expect(br.runs).toBe(2);
  });

  it("non-auth failures never trigger a browser refresh; disabled hook is ignored", async () => {
    const br = refresher("ok");
    const a = mk([new TransientError("t")], { browserRefresh: br });
    await a.poller.pollOnce();
    expect(br.runs).toBe(0);
    const off = { ...refresher("ok"), enabled: () => false };
    const b = mk([new AuthError("x")], { browserRefresh: off });
    const out = await b.poller.pollOnce();
    expect(off.runs).toBe(0);
    expect(out.ok).toBe(false);
  });

  it("rotation auth failure triggers a refresh before polling; a poll auth failure then does not refresh again", async () => {
    const br = refresher("ok");
    const { src, poller, db } = mk([new AuthError("nope")], { rotate: async () => ({ ok: false, errorKind: "auth" }), browserRefresh: br });
    await poller.pollOnce();
    expect(br.runs).toBe(1);
    expect(src.calls).toBe(1);
    expect(db.getMeta("auth_state")).toBe("expired");
  });

  it("a throwing rotation hook never breaks the poll", async () => {
    const { poller } = mk([[obs(NOW - 1000)]], {
      rotate: async () => {
        throw new Error("boom");
      },
    });
    expect((await poller.pollOnce()).ok).toBe(true);
  });
});

describe("rotation wired through the poller + status", () => {
  let dir = "";
  let file = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ka-"));
    file = join(dir, "cookies.txt");
    const fut = Math.floor(Date.now() / 1000) + 86400;
    writeFileSync(file, ["# Netscape HTTP Cookie File", ["#HttpOnly_.google.com", "TRUE", "/", "TRUE", fut, "__Secure-1PSID", "FAKE_PSID_VALUE"].join("\t")].join("\n") + "\n");
    const t = new Date(Date.now() - 3_600_000);
    utimesSync(file, t, t);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("rotation runs when due, and status/health expose cookie_rotation without values", async () => {
    const db = memDb();
    let rotations = 0;
    const f = (async () => {
      rotations++;
      const h = new Headers();
      h.append("set-cookie", "__Secure-1PSIDTS=FAKE_PSIDTS_NEW; Domain=.google.com; Path=/; Secure");
      return new Response(")]}'\n[[\"identity.hfcr\",600]]", { status: 200, headers: h });
    }) as unknown as typeof fetch;
    const src = new Scripted([[obs(Date.now() - 1000)]]);
    const poller = new Poller(db, src, cfg, silentLogger, Date.now, {
      rotate: () => rotateIfDue({ db, cookiesFile: file, minIntervalSec: 540, fetchImpl: f }),
    });
    await poller.pollOnce();
    await poller.pollOnce();
    expect(rotations).toBe(1);
    const s = getStatus(db, cfg);
    expect(s.cookie_rotation.last_ok_at).toMatch(/^\d{4}-/);
    expect(s.cookie_rotation.last_error_kind).toBeNull();
    const json = JSON.stringify({ s, h: healthPayload(db, cfg) });
    expect(json).not.toMatch(/FAKE_/);
    expect(healthPayload(db, cfg).cookie_rotation).toBeTruthy();
  });

  it("GoogleLocationSharingSource feeds Set-Cookie from location reads into the cookies file", async () => {
    const f = (async () => {
      const h = new Headers();
      h.append("set-cookie", "SIDCC=FAKE_SIDCC_FROM_READ; Domain=.google.com; Path=/; Secure");
      return new Response(fakeResponse([{ id: "1", lat: 10.5, lng: 20.5, ts: T0 }]), { status: 200, headers: h });
    }) as unknown as typeof fetch;
    const src = new GoogleLocationSharingSource({ cookiesFile: file, fetchImpl: f });
    expect(await src.fetchLatest()).toHaveLength(1);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("FAKE_SIDCC_FROM_READ");
    expect(text).toContain("FAKE_PSID_VALUE");
  });
});
