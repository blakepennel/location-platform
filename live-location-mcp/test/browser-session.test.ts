import { EventEmitter } from "node:events";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@location/shared";
import {
  BrowserSessionError,
  decryptChromiumValue,
  exportCookiesFromProfile,
  findChrome,
  loginArgs,
  loginInteractive,
  refreshProfileSession,
} from "../src/browser-session.ts";

// No real browser and no network: the Chromium cookie DB is synthetic and spawn is a fake. All values FAKE.
let dir = "";
let profile = "";
let cookiesFile = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bs-"));
  profile = join(dir, "profile");
  mkdirSync(join(profile, "Default"), { recursive: true });
  cookiesFile = join(dir, "cookies.txt");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Encrypt like Chromium on Linux with --password-store=basic ("v10"). */
const KEY = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
function v10(value: string, host: string, dbVersion: number): Buffer {
  const plain = dbVersion >= 24 ? Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)]) : Buffer.from(value);
  const c = createCipheriv("aes-128-cbc", KEY, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), c.update(plain), c.final()]);
}

interface FakeCookie { host: string; name: string; value: string; httpOnly?: boolean; enc?: Buffer }
/** Minimal Chromium-shaped Cookies database. */
function writeCookieDb(cookies: FakeCookie[], dbVersion = 24) {
  const db = openDatabase(join(profile, "Default", "Cookies"));
  db.exec(`CREATE TABLE meta(key TEXT, value TEXT);
           CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
                                expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER);`);
  db.prepare("INSERT INTO meta VALUES ('version', ?)").run(String(dbVersion));
  // 2033-05-18 in Chromium time (microseconds since 1601)
  const exp = (2_000_000_000 + 11644473600) * 1e6;
  for (const c of cookies) {
    db.prepare("INSERT INTO cookies VALUES (?, ?, '', ?, '/', ?, 1, ?)").run(
      c.host, c.name, c.enc ?? v10(c.value, c.host, dbVersion), exp, c.httpOnly ? 1 : 0);
  }
  db.close();
}

const SIGNED_IN: FakeCookie[] = [
  { host: ".google.com", name: "__Secure-1PSID", value: "FAKE_PSID_VALUE", httpOnly: true },
  { host: ".google.com", name: "SID", value: "FAKE_SID_VALUE" },
  { host: "accounts.google.com", name: "__Host-GAPS", value: "FAKE_GAPS" },
  { host: ".example.com", name: "tracker", value: "FAKE_OTHER_SITE" },
];

describe("decryptChromiumValue", () => {
  it("decrypts v10 values, stripping the host hash on schema >= 24", () => {
    expect(decryptChromiumValue(v10("FAKE_A", ".google.com", 24), 24)).toBe("FAKE_A");
    expect(decryptChromiumValue(v10("FAKE_B", ".google.com", 18), 18)).toBe("FAKE_B");
  });
  it("rejects keyring-encrypted (v11) values", () => {
    expect(() => decryptChromiumValue(Buffer.from("v11xxxxxxxxxxxxxxxx"), 24)).toThrow(BrowserSessionError);
  });
});

describe("exportCookiesFromProfile (reads the profile DB, launches nothing)", () => {
  it("writes only google.com cookies, decrypted, in Netscape format", async () => {
    writeCookieDb(SIGNED_IN);
    const r = await exportCookiesFromProfile({ profileDir: profile, cookiesFile });
    expect(r.cookieCount).toBe(3);
    const txt = readFileSync(cookiesFile, "utf8");
    expect(txt).toContain("FAKE_PSID_VALUE");
    expect(txt).toContain("#HttpOnly_.google.com");
    expect(txt).toContain("2000000000");
    expect(txt).not.toContain("FAKE_OTHER_SITE");
  });
  it("refuses when not signed in and leaves the existing cookies file untouched", async () => {
    writeCookieDb(SIGNED_IN.filter((c) => c.name !== "__Secure-1PSID"));
    writeFileSync(cookiesFile, "# existing\n");
    await expect(exportCookiesFromProfile({ profileDir: profile, cookiesFile })).rejects.toMatchObject({ code: "not_signed_in" });
    expect(readFileSync(cookiesFile, "utf8")).toBe("# existing\n");
  });
  it("reports a missing profile or database as not signed in", async () => {
    await expect(exportCookiesFromProfile({ profileDir: join(dir, "nope"), cookiesFile })).rejects.toMatchObject({ code: "not_signed_in" });
    await expect(exportCookiesFromProfile({ profileDir: profile, cookiesFile })).rejects.toMatchObject({ code: "not_signed_in" });
  });
  it("fails clearly on keyring-encrypted cookies", async () => {
    writeCookieDb([{ host: ".google.com", name: "__Secure-1PSID", value: "", enc: Buffer.from("v11FAKEFAKEFAKEFAKE") }]);
    await expect(exportCookiesFromProfile({ profileDir: profile, cookiesFile })).rejects.toMatchObject({ code: "export_failed" });
    expect(existsSync(cookiesFile)).toBe(false);
  });
});

describe("refreshProfileSession (L4 keepalive)", () => {
  it("runs a plain Chromium (no automation flags) on Maps, then exports from the DB", async () => {
    writeCookieDb(SIGNED_IN);
    let seen: string[] = [];
    const spawnImpl = ((_cmd: string, args: string[]) => {
      seen = args;
      const child = new EventEmitter() as EventEmitter & { kill: (s?: string) => boolean };
      child.kill = () => (setImmediate(() => child.emit("exit", 0)), true);
      return child;
    }) as never;
    const r = await refreshProfileSession({ profileDir: profile, cookiesFile, chromePath: "/fake/chrome", spawnImpl, dwellMs: 10, container: true });
    expect(r.cookieCount).toBe(3);
    expect(seen).toContain("--headless=new");
    expect(seen).toContain("--password-store=basic");
    expect(seen).toContain("--no-sandbox");
    expect(seen.join(" ")).not.toMatch(/--enable-automation|--remote-debugging|--disable-blink-features/);
    expect(seen.at(-1)).toBe("https://www.google.com/maps");
  });
});

describe("loginInteractive", () => {
  it("uses spawn (not puppeteer), a plain user-data-dir, and never passes automation flags", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = () => {};
    const p = loginInteractive({
      profileDir: join(dir, "newprofile"),
      chromePath: "/fake/chrome",
      container: true,
      spawnImpl: ((cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return child;
      }) as never,
    });
    child.emit("exit", 0);
    await expect(p).resolves.toEqual({ timedOut: false, exitCode: 0 });
    expect(existsSync(join(dir, "newprofile"))).toBe(true);
    const a = calls[0].args;
    expect(calls[0].cmd).toBe("/fake/chrome");
    expect(a).toContain(`--user-data-dir=${join(dir, "newprofile")}`);
    expect(a).toContain("--no-first-run");
    expect(a).toContain("--no-default-browser-check");
    expect(a).toContain("--no-sandbox");
    expect(a[a.length - 1]).toBe("https://accounts.google.com/ServiceLogin?continue=https://www.google.com/maps");
    expect(a.join(" ")).not.toMatch(/remote-debugging|enable-automation|headless|AutomationControlled|webdriver/i);
  });
  it("omits --no-sandbox outside containers and times out (killing the child)", async () => {
    expect(loginArgs("/p", false)).not.toContain("--no-sandbox");
    let killed = false;
    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = () => {
      killed = true;
    };
    const r = await loginInteractive({ profileDir: profile, chromePath: "x", timeoutMs: 5, container: false, spawnImpl: (() => child) as never });
    expect(r.timedOut).toBe(true);
    expect(killed).toBe(true);
  });
});

describe("findChrome", () => {
  it("prefers CHROME_PATH, else first existing candidate, else errors", () => {
    expect(findChrome({ CHROME_PATH: "/usr/local/bin/chromium-wrapper" } as never, () => false)).toBe("/usr/local/bin/chromium-wrapper");
    expect(findChrome({} as never, (p) => p === "/usr/bin/chromium", "linux")).toBe("/usr/bin/chromium");
    expect(() => findChrome({} as never, () => false, "linux")).toThrow(/CHROME_PATH/);
  });
});
