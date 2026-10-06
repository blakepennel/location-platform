import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROTATE_BODY, ROTATE_URL, parseRotateInterval, rotateCookies, rotateIfDue } from "../src/rotate.ts";
import { memDb } from "./helpers.ts";

// Fake cookies + injected fetch: never contacts Google.
const FUT = Math.floor(Date.now() / 1000) + 86400;
let dir = "";
let file = "";
const tab = (...f: (string | number)[]) => f.join("\t");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rot-"));
  file = join(dir, "cookies.txt");
  writeFileSync(
    file,
    ["# Netscape HTTP Cookie File", tab("#HttpOnly_.google.com", "TRUE", "/", "TRUE", FUT, "__Secure-1PSID", "FAKE_PSID_VALUE"), tab("#HttpOnly_.google.com", "TRUE", "/", "TRUE", FUT, "__Secure-1PSIDTS", "FAKE_PSIDTS_OLD")].join("\n") + "\n",
  );
  old();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
/** make the cookies file look untouched for an hour (outside the 60 s guard) */
function old() {
  const t = new Date(Date.now() - 3_600_000);
  utimesSync(file, t, t);
}

function fakeFetch(status: number, body: string, setCookies: string[] = []) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const h = new Headers();
    for (const c of setCookies) h.append("set-cookie", c);
    return new Response(body, { status, headers: h });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const OK_BODY = ")]}'\n[[\"identity.hfcr\",600],[\"di\",7]]";
const NEW_TS = "__Secure-1PSIDTS=FAKE_PSIDTS_NEW; Domain=.google.com; Path=/; Secure; HttpOnly";

describe("rotateCookies", () => {
  it("POSTs the RotateCookies request, parses interval 600, applies new FAKE 1PSIDTS", async () => {
    const { f, calls } = fakeFetch(200, OK_BODY, [NEW_TS]);
    const r = await rotateCookies({ cookiesFile: file, fetchImpl: f });
    expect(r).toMatchObject({ ok: true, intervalSec: 600, cookiesChanged: true, status: 200 });
    expect(calls[0].url).toBe(ROTATE_URL);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.body).toBe(ROTATE_BODY);
    const h = calls[0].init.headers as Record<string, string>;
    expect(h["Content-Type"]).toBe("application/json");
    expect(h.Origin).toBe("https://accounts.google.com");
    expect(h["User-Agent"]).toMatch(/Mozilla/);
    expect(h.Cookie).toContain("__Secure-1PSIDTS=FAKE_PSIDTS_OLD");
    expect(readFileSync(file, "utf8")).toContain("FAKE_PSIDTS_NEW");
  });
  it("defaults the interval when the body lacks it", async () => {
    expect(parseRotateInterval(")]}'\n[]")).toBe(600);
    expect(parseRotateInterval("garbage")).toBe(600);
    expect(parseRotateInterval(")]}'\n[[\"identity.hfcr\",300]]")).toBe(300);
    const r = await rotateCookies({ cookiesFile: file, fetchImpl: fakeFetch(200, "").f });
    expect(r).toMatchObject({ ok: true, intervalSec: 600 });
  });
  it("401/403 => auth failure result (no throw); 500 => transient; network error => transient", async () => {
    expect(await rotateCookies({ cookiesFile: file, fetchImpl: fakeFetch(401, "").f })).toMatchObject({ ok: false, errorKind: "auth", status: 401 });
    expect(await rotateCookies({ cookiesFile: file, fetchImpl: fakeFetch(403, "").f })).toMatchObject({ ok: false, errorKind: "auth" });
    expect(await rotateCookies({ cookiesFile: file, fetchImpl: fakeFetch(500, "").f })).toMatchObject({ ok: false, errorKind: "transient" });
    const boom = (async () => {
      throw new Error("net");
    }) as unknown as typeof fetch;
    expect(await rotateCookies({ cookiesFile: file, fetchImpl: boom })).toMatchObject({ ok: false, errorKind: "transient" });
  });
  it("missing cookies file => auth failure", async () => {
    expect(await rotateCookies({ cookiesFile: join(dir, "nope.txt"), fetchImpl: fakeFetch(200, "").f })).toMatchObject({ ok: false, errorKind: "auth" });
  });
});

describe("rotateIfDue", () => {
  const base = () => ({ db: memDb(), cookiesFile: file, minIntervalSec: 540 });
  it("rotates when due and records meta; skips when not due", async () => {
    const { f, calls } = fakeFetch(200, OK_BODY, [NEW_TS]);
    const o = { ...base(), fetchImpl: f };
    const r1 = await rotateIfDue(o);
    expect(r1.ok).toBe(true);
    expect(r1.skipped).toBeUndefined();
    expect(o.db.getMetaNumber("cookie_rotation_last_ok_ms")).toBeGreaterThan(0);
    expect(o.db.getMeta("cookie_rotation_last_error_kind")).toBeNull();
    old();
    const r2 = await rotateIfDue(o);
    expect(r2.skipped).toBe("not_due");
    expect(calls).toHaveLength(1);
  });
  it("becomes due again after the interval", async () => {
    const { f, calls } = fakeFetch(200, OK_BODY);
    let now = Date.now();
    const o = { ...base(), fetchImpl: f, now: () => now };
    await rotateIfDue(o);
    now += 541_000;
    await rotateIfDue(o);
    expect(calls).toHaveLength(2);
  });
  it("60 s mtime guard skips when the cookies file was just modified", async () => {
    const { f, calls } = fakeFetch(200, OK_BODY);
    utimesSync(file, new Date(), new Date());
    const r = await rotateIfDue({ ...base(), fetchImpl: f });
    expect(r.skipped).toBe("guard");
    expect(calls).toHaveLength(0);
  });
  it("records an auth failure kind in meta", async () => {
    const o = { ...base(), fetchImpl: fakeFetch(401, "").f };
    const r = await rotateIfDue(o);
    expect(r).toMatchObject({ ok: false, errorKind: "auth" });
    expect(o.db.getMeta("cookie_rotation_last_error_kind")).toBe("auth");
    expect(o.db.getMetaNumber("cookie_rotation_last_ok_ms")).toBeNull();
  });
});
