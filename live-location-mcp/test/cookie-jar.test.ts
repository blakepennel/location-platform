import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "@location/shared";
import { CookieJar, parseSetCookie } from "../src/cookie-jar.ts";

// All cookie values below are FAKE.
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const FUT = Math.floor(NOW / 1000) + 86400;
let dir = "";
let file = "";
const tab = (...f: (string | number)[]) => f.join("\t");
const noSecure = () => true;
const ORIGINAL = [
  "# Netscape HTTP Cookie File",
  "# a user comment that must survive",
  tab("#HttpOnly_.google.com", "TRUE", "/", "TRUE", FUT, "__Secure-1PSID", "FAKE_PSID_VALUE"),
  tab("#HttpOnly_.google.com", "TRUE", "/", "TRUE", FUT, "__Secure-1PSIDTS", "FAKE_PSIDTS_OLD"),
  tab(".google.com", "TRUE", "/", "TRUE", FUT, "NID", "FAKE_NID"),
  "this line is not a cookie",
  "",
].join("\n");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jar-"));
  file = join(dir, "cookies.txt");
  writeFileSync(file, ORIGINAL);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const load = (o = {}) => CookieJar.load(file, { now: () => NOW, secure: noSecure, ...o }, true);
const URL_ = "https://accounts.google.com/RotateCookies";

describe("parseSetCookie", () => {
  it("domain cookie vs host-only, path default, Max-Age wins over Expires", () => {
    const d = parseSetCookie("A=1; Domain=.google.com; Path=/x; Secure; HttpOnly; Max-Age=100; Expires=Wed, 01 Jan 2020 00:00:00 GMT", URL_, NOW)!;
    expect(d.cookie).toMatchObject({ domain: ".google.com", includeSubdomains: true, path: "/x", secure: true, httpOnly: true, expires: NOW / 1000 + 100 });
    expect(d.remove).toBe(false);
    const h = parseSetCookie("B=2", "https://accounts.google.com/a/b/c", NOW)!;
    expect(h.cookie).toMatchObject({ domain: "accounts.google.com", includeSubdomains: false, path: "/a/b", expires: 0 });
  });
  it("rejects a Domain the host may not set; deletion via Max-Age<=0 or past Expires", () => {
    expect(parseSetCookie("A=1; Domain=evil.com", URL_, NOW)).toBeNull();
    expect(parseSetCookie("A=; Max-Age=0", URL_, NOW)!.remove).toBe(true);
    expect(parseSetCookie("A=; Expires=Thu, 01 Jan 1970 00:00:00 GMT", URL_, NOW)!.remove).toBe(true);
  });
});

describe("CookieJar", () => {
  it("updates value, adds new cookie, deletes, and round-trips preserving other lines", () => {
    const jar = load();
    const changed = jar.applySetCookie(
      [
        "__Secure-1PSIDTS=FAKE_PSIDTS_NEW; Domain=.google.com; Path=/; Secure; HttpOnly; Expires=" + new Date((FUT + 100) * 1000).toUTCString(),
        "SIDCC=FAKE_SIDCC; Domain=.google.com; Path=/; Secure",
        "NID=; Domain=.google.com; Path=/; Max-Age=0",
      ],
      URL_,
    );
    expect(changed).toBe(true);
    expect(jar.save()).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# a user comment that must survive");
    expect(text).toContain("this line is not a cookie");
    expect(text).toContain("FAKE_PSIDTS_NEW");
    expect(text).not.toContain("FAKE_PSIDTS_OLD");
    expect(text).toContain("FAKE_PSID_VALUE"); // untouched line kept verbatim
    expect(text).toContain("FAKE_SIDCC");
    expect(text).not.toContain("FAKE_NID");
    expect(text).toContain("#HttpOnly_.google.com\tTRUE\t/\tTRUE");
    const again = CookieJar.load(file, { now: () => NOW });
    expect(again.cookies.find((c) => c.name === "__Secure-1PSIDTS")?.value).toBe("FAKE_PSIDTS_NEW");
    expect(again.cookies.find((c) => c.name === "SIDCC")?.includeSubdomains).toBe(true);
  });

  it("host-only cookies are only sent to that host; path is honoured", () => {
    const jar = load();
    jar.applySetCookie(["HOSTONLY=FAKE_H; Path=/", "PATHED=FAKE_P; Domain=google.com; Path=/maps"], URL_);
    const acct = jar.headerFor("https://accounts.google.com/x");
    expect(acct).toContain("HOSTONLY=FAKE_H");
    expect(acct).not.toContain("PATHED");
    const www = jar.headerFor("https://www.google.com/maps/rpc");
    expect(www).not.toContain("HOSTONLY");
    expect(www).toContain("PATHED=FAKE_P");
    expect(jar.headerFor("https://www.google.com/other")).not.toContain("PATHED");
  });

  it("does not write when nothing changed; identical Set-Cookie is a no-op", () => {
    const jar = load();
    expect(jar.applySetCookie(["NID=FAKE_NID; Domain=.google.com; Path=/; Secure; Expires=" + new Date(FUT * 1000).toUTCString()], URL_)).toBe(false);
    const before = statSync(file).mtimeMs;
    expect(jar.save()).toBe(false);
    expect(statSync(file).mtimeMs).toBe(before);
    expect(existsSync(file + ".bak")).toBe(false);
  });

  it("writes atomically (no temp left) and keeps a one-generation .bak of the previous file", () => {
    const jar = load();
    jar.applySetCookie(["X=FAKE_X; Domain=google.com; Path=/"], URL_);
    jar.save();
    expect(readFileSync(file + ".bak", "utf8")).toBe(ORIGINAL);
    expect(existsSync(`${file}.tmp-${process.pid}`)).toBe(false);
    const jar2 = load();
    jar2.applySetCookie(["Y=FAKE_Y; Domain=google.com; Path=/"], URL_);
    jar2.save();
    expect(readFileSync(file + ".bak", "utf8")).toContain("FAKE_X"); // previous generation only
    expect(readFileSync(file + ".bak", "utf8")).not.toContain("FAKE_Y");
  });

  it("calls secureCookiesFile on the result", () => {
    const secured: string[] = [];
    const jar = load({ secure: (p: string) => (secured.push(p), true) });
    jar.applySetCookie(["X=FAKE_X; Domain=google.com; Path=/"], URL_);
    jar.save();
    expect(secured).toContain(file);
  });

  it("never logs cookie values", () => {
    const lines: string[] = [];
    const jar = load({ logger: createLogger("t", (l) => lines.push(l)) });
    jar.applySetCookie(["__Secure-1PSIDTS=FAKE_LOGGED_VALUE; Domain=google.com; Path=/; Secure"], URL_);
    jar.save();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toMatch(/FAKE_/);
  });
});
