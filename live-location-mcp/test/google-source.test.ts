import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PB, GoogleLocationSharingSource } from "../src/google.ts";
import { AuthError, RateLimitError, SharingLapsedError, TransientError } from "../src/source.ts";
import { main } from "../src/cli.ts";
import { HTML_RESPONSE, T0, UNAUTH_RESPONSE, fakeResponse } from "./fixtures.ts";

// NOTE: every fetch here is an injected fake. These tests never contact Google.
let dir = "";
let cookies = "";
const future = Math.floor(Date.now() / 1000) + 86400;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "live-src-"));
  cookies = join(dir, "cookies.txt");
  writeFileSync(
    cookies,
    ["# Netscape HTTP Cookie File", ["#HttpOnly_.google.com", "TRUE", "/", "TRUE", future, "__Secure-1PSID", "fake-psid-value"].join("\t"), [".google.com", "TRUE", "/", "TRUE", future, "NID", "fake-nid"].join("\t")].join("\n"),
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function resp(body: string, status = 200, headers: Record<string, string> = {}): typeof fetch {
  return (async () => new Response(body, { status, headers })) as unknown as typeof fetch;
}
const src = (f: typeof fetch, extra: Record<string, unknown> = {}) => new GoogleLocationSharingSource({ cookiesFile: cookies, fetchImpl: f, ...extra });

describe("GoogleLocationSharingSource (fake transport)", () => {
  it("builds the request: GET, query params, pb constant, all google cookies, no redirects", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(fakeResponse([{ id: "1", lat: 10.5, lng: 20.5, ts: T0 }]), { status: 200 });
    }) as unknown as typeof fetch;
    const obs = await src(f).fetchLatest();
    expect(obs).toHaveLength(1);
    const u = new URL(seen!.url);
    expect(u.origin + u.pathname).toBe("https://www.google.com/maps/rpc/locationsharing/read");
    expect(u.searchParams.get("authuser")).toBe("0");
    expect(u.searchParams.get("hl")).toBe("en");
    expect(u.searchParams.get("gl")).toBe("us");
    expect(u.searchParams.get("pb")).toBe(DEFAULT_PB);
    expect(seen!.init.method).toBe("GET");
    expect(seen!.init.redirect).toBe("manual");
    const cookie = (seen!.init.headers as Record<string, string>).Cookie;
    expect(cookie).toContain("__Secure-1PSID=fake-psid-value");
    expect(cookie).toContain("NID=fake-nid");
  });

  it("pb is overridable", async () => {
    let url = "";
    const f = (async (u: string) => {
      url = u;
      return new Response(fakeResponse([{ id: "1", lat: 10.5, lng: 20.5, ts: T0 }]), { status: 200 });
    }) as unknown as typeof fetch;
    await src(f, { pb: "!1custom" }).fetchLatest();
    expect(new URL(url).searchParams.get("pb")).toBe("!1custom");
  });

  it("maps HTTP outcomes to typed errors", async () => {
    await expect(src(resp("", 429, { "retry-after": "120" })).fetchLatest()).rejects.toMatchObject({ kind: "rate_limit", retryAfterMs: 120_000, status: 429 });
    await expect(src(resp("", 503)).fetchLatest()).rejects.toBeInstanceOf(RateLimitError);
    await expect(src(resp("", 302, { location: "https://accounts.google.com/" })).fetchLatest()).rejects.toBeInstanceOf(AuthError);
    await expect(src(resp("", 401)).fetchLatest()).rejects.toBeInstanceOf(AuthError);
    await expect(src(resp("", 500)).fetchLatest()).rejects.toBeInstanceOf(TransientError);
    await expect(src(resp(HTML_RESPONSE)).fetchLatest()).rejects.toBeInstanceOf(AuthError);
    await expect(src(resp(UNAUTH_RESPONSE)).fetchLatest()).rejects.toBeInstanceOf(AuthError);
    await expect(src(resp(fakeResponse(null))).fetchLatest()).rejects.toBeInstanceOf(SharingLapsedError);
    const boom = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(src(boom).fetchLatest()).rejects.toBeInstanceOf(TransientError);
  });

  it("missing cookie file / missing PSID cookie is an AuthError and no request is made", async () => {
    let called = false;
    const f = (async () => {
      called = true;
      return new Response("");
    }) as unknown as typeof fetch;
    await expect(new GoogleLocationSharingSource({ cookiesFile: join(dir, "nope.txt"), fetchImpl: f }).fetchLatest()).rejects.toBeInstanceOf(AuthError);
    const nopsid = join(dir, "nopsid.txt");
    writeFileSync(nopsid, [".google.com", "TRUE", "/", "TRUE", future, "NID", "x"].join("\t"));
    await expect(new GoogleLocationSharingSource({ cookiesFile: nopsid, fetchImpl: f }).fetchLatest()).rejects.toBeInstanceOf(AuthError);
    expect(called).toBe(false);
  });

  it("error messages and describe() never contain cookie values or coordinates", async () => {
    const s = src(resp(UNAUTH_RESPONSE));
    const e = (await s.fetchLatest().catch((x) => x)) as Error;
    expect(e.message).not.toContain("fake-psid-value");
    expect(JSON.stringify(s.describe())).not.toContain("fake-psid-value");
  });

  it("probe() lists sharer ids and never returns coordinates", async () => {
    const p = await src(resp(fakeResponse([{ id: "a1", lat: 10.5, lng: 20.5, ts: T0 }, { id: "b2", lat: 10.6, lng: 20.6, ts: T0, noLocation: true }]))).probe();
    expect(p).toEqual({ sharerIds: ["a1", "b2"], withLocation: 1 });
  });
});

describe("CLI guards", () => {
  it("`auth` refuses to run under a test environment (never contacts Google)", async () => {
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = () => true;
    try {
      expect(await main(["auth"])).toBe(2);
    } finally {
      process.stderr.write = orig;
    }
  });
});
