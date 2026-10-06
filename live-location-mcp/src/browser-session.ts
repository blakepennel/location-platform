/**
 * L4 of the session keepalive: a persistent browser profile for the DEDICATED recipient account.
 *
 *  - `loginInteractive`: a HUMAN signs in. Chromium is started as a plain child process (spawn),
 *    never through puppeteer, so it carries no automation flags / navigator.webdriver. This code
 *    never types or handles a password.
 *  - `exportCookiesFromProfile`: reads the cookies straight from the profile's Chromium cookie
 *    database (no browser launch). Launching an automated browser on the profile made Google sign
 *    the session out, so export never starts a browser. Refuses to overwrite cookies.txt unless the
 *    profile is clearly signed in.
 *  - `refreshProfileSession`: the L4 keepalive. Opens the profile in a PLAIN Chromium (no automation
 *    flags, same as the human login), lets it load Maps and refresh its own session cookies, closes
 *    it gracefully so cookies are flushed, then exports from the database.
 *
 * The profile directory is a FULL session for the recipient account: keep it under secrets/, 0700.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@location/shared";
import { openDatabase, platformHome } from "@location/shared";
import { CookieJar } from "./cookie-jar.ts";
import type { NetscapeCookie } from "./google.ts";

export const LOGIN_URL = "https://accounts.google.com/ServiceLogin?continue=https://www.google.com/maps";
export const MAPS_URL = "https://www.google.com/maps";
export const DEFAULT_LOGIN_TIMEOUT_MS = 15 * 60_000;

export class BrowserSessionError extends Error {
  constructor(
    message: string,
    readonly code: "not_signed_in" | "no_browser" | "launch_failed" | "export_failed" | "login_timeout",
  ) {
    super(message);
    this.name = "BrowserSessionError";
  }
}

export function defaultProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.LIVE_BROWSER_PROFILE || join(platformHome(), "secrets", "live", "browser-profile");
}

export function inContainer(exists: (p: string) => boolean = existsSync): boolean {
  return exists("/.dockerenv");
}

/** CHROME_PATH, else the first common install location that exists. */
export function findChrome(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync, platform = process.platform): string {
  if (env.CHROME_PATH) return env.CHROME_PATH;
  const pf = env.PROGRAMFILES ?? "C:\\Program Files";
  const pf86 = env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
  const local = env.LOCALAPPDATA ?? "";
  const candidates =
    platform === "win32"
      ? [join(pf, "Google/Chrome/Application/chrome.exe"), join(pf86, "Google/Chrome/Application/chrome.exe"), local && join(local, "Google/Chrome/Application/chrome.exe"), join(pf, "Microsoft/Edge/Application/msedge.exe"), join(pf86, "Microsoft/Edge/Application/msedge.exe")]
      : platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
        : ["/usr/local/bin/chromium-wrapper", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const hit = candidates.filter(Boolean).find((p) => exists(p));
  if (!hit) throw new BrowserSessionError("no Chrome/Chromium found; set CHROME_PATH", "no_browser");
  return hit;
}

/** Create the profile dir (0700). */
export function ensureProfileDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best effort */
    }
  }
}

/** Arguments for the human login browser. Deliberately contains NO automation flags. */
/**
 * Chromium leaves Singleton{Lock,Socket,Cookie} in the profile; after a container restart
 * they point at a dead process/host and block the next launch. Remove them only in a
 * container (on a desktop they may belong to a genuinely open browser window).
 */
export function clearStaleProfileLocks(profileDir: string, container = inContainer()): void {
  if (!container) return;
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try { rmSync(join(profileDir, f), { force: true }); } catch { /* ignore */ }
  }
}

export function loginArgs(profileDir: string, container: boolean): string[] {
  return [...profileArgs(profileDir, container), LOGIN_URL];
}

/** Flags shared by every launch on the profile. --password-store=basic pins Chromium's cookie
 *  encryption to its documented default ("v10") so exportCookiesFromProfile can read it. */
export function profileArgs(profileDir: string, container: boolean): string[] {
  return [`--user-data-dir=${profileDir}`, "--password-store=basic", "--no-first-run", "--no-default-browser-check", ...(container ? ["--no-sandbox"] : [])];
}

export interface LoginOptions {
  profileDir: string;
  chromePath: string;
  timeoutMs?: number;
  container?: boolean;
  spawnImpl?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  logger?: Logger;
}

/** Launch the browser for a human to sign in; resolves when the window is closed (or on timeout). */
export function loginInteractive(o: LoginOptions): Promise<{ timedOut: boolean; exitCode: number | null }> {
  ensureProfileDir(o.profileDir);
  clearStaleProfileLocks(o.profileDir, o.container ?? inContainer());
  const spawnFn = o.spawnImpl ?? nodeSpawn;
  const child = spawnFn(o.chromePath, loginArgs(o.profileDir, o.container ?? inContainer()), { stdio: "ignore", windowsHide: false });
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (r: { timedOut: boolean; exitCode: number | null }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ timedOut: true, exitCode: null });
    }, o.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
    child.once("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new BrowserSessionError(`could not start browser: ${(e as Error).message}`, "launch_failed"));
    });
    child.once("exit", (code) => finish({ timedOut: false, exitCode: code }));
  });
}

// ---- export (read the profile's cookie database; no browser launch) -----------------------------

export interface ExportOptions {
  profileDir: string;
  cookiesFile: string;
  logger?: Logger;
}

export function isGoogleDomain(domain: string): boolean {
  const d = domain.replace(/^\./, "").toLowerCase();
  return d === "google.com" || d.endsWith(".google.com");
}

/**
 * Decrypt a Chromium-on-Linux cookie value encrypted with the "basic" password store ("v10"):
 * AES-128-CBC, key = PBKDF2-SHA1("peanuts", "saltysalt", 1 iteration, 16 bytes), IV = 16 spaces.
 * Since cookie DB schema version 24 the plaintext starts with SHA-256(host_key) (32 bytes).
 * Same scheme as browser_cookie3 / pycookiecheat. "v11" (desktop keyring) is not supported.
 */
const V10_KEY = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
export function decryptChromiumValue(enc: Uint8Array, dbVersion: number): string {
  const buf = Buffer.from(enc);
  const prefix = buf.subarray(0, 3).toString("latin1");
  if (prefix !== "v10") throw new BrowserSessionError(`unsupported cookie encryption "${prefix}" (expected v10 / --password-store=basic)`, "export_failed");
  const d = createDecipheriv("aes-128-cbc", V10_KEY, Buffer.alloc(16, 0x20));
  let plain = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
  if (dbVersion >= 24) plain = plain.subarray(32);
  return plain.toString("utf8");
}

/** Chromium stores expiry as microseconds since 1601-01-01; 0 = session cookie. */
function chromiumExpiryToUnix(expiresUtc: number | bigint): number {
  const v = Number(expiresUtc);
  return v > 0 ? Math.max(0, Math.floor(v / 1e6 - 11644473600)) : 0;
}

interface CookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array;
  path: string;
  expires_utc: number | bigint;
  is_secure: number | bigint;
  is_httponly: number | bigint;
}

/** Read the google.com cookies from a Chromium profile (copies the DB first: the browser may hold it open). */
export function readProfileCookies(profileDir: string): NetscapeCookie[] {
  const src = join(profileDir, "Default", "Cookies");
  if (!existsSync(src)) throw new BrowserSessionError("browser profile has no cookie database; run `live-location login` first", "not_signed_in");
  const tmp = mkdtempSync(join(tmpdir(), "lp-cookies-"));
  try {
    copyFileSync(src, join(tmp, "Cookies"));
    if (existsSync(src + "-journal")) copyFileSync(src + "-journal", join(tmp, "Cookies-journal"));
    const db = openDatabase(join(tmp, "Cookies"));
    try {
      const ver = Number((db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined)?.value ?? 0);
      // expires_utc (microseconds since 1601) exceeds Number.MAX_SAFE_INTEGER: read integers as BigInt
      const stmt = db.prepare("SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly FROM cookies");
      stmt.setReadBigInts(true);
      const rows = stmt.all() as unknown as CookieRow[];
      return rows
        .filter((r) => isGoogleDomain(r.host_key))
        .map((r) => ({
          domain: r.host_key.toLowerCase(),
          includeSubdomains: r.host_key.startsWith("."),
          path: r.path || "/",
          secure: Number(r.is_secure) === 1,
          expires: chromiumExpiryToUnix(r.expires_utc),
          name: r.name,
          value: r.value || (r.encrypted_value?.length ? decryptChromiumValue(r.encrypted_value, ver) : ""),
          ...(Number(r.is_httponly) === 1 ? { httpOnly: true } : {}),
        }));
    } finally {
      db.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function exportCookiesFromProfile(o: ExportOptions): Promise<{ cookieCount: number; wrote: boolean }> {
  if (!existsSync(o.profileDir)) throw new BrowserSessionError("browser profile does not exist; run `live-location login` first", "not_signed_in");
  let google: NetscapeCookie[];
  try {
    google = readProfileCookies(o.profileDir);
  } catch (e) {
    if (e instanceof BrowserSessionError) throw e;
    throw new BrowserSessionError(`cookie export failed: ${(e as Error).message}`, "export_failed");
  }
  if (!google.some((c) => c.name === "__Secure-1PSID" && c.value)) {
    throw new BrowserSessionError("browser profile is not signed in to Google (run `live-location login`); cookies file left untouched", "not_signed_in");
  }
  const jar = CookieJar.load(o.cookiesFile, { logger: o.logger });
  jar.replaceAll(google);
  const wrote = jar.save();
  o.logger?.info("browser_export.ok", { cookie_count: google.length, wrote });
  return { cookieCount: google.length, wrote };
}

// ---- L4 keepalive: let a plain browser refresh its own session -------------------------------

export interface RefreshOptions extends ExportOptions {
  chromePath: string;
  /** How long the browser stays on Maps (Chromium flushes cookies to disk about every 30 s). */
  dwellMs?: number;
  container?: boolean;
  spawnImpl?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
}

/** Normal desktop UA for the installed Chromium (headless mode otherwise announces "HeadlessChrome"). */
function normalUserAgent(chromePath: string): string | null {
  try {
    const v = /(\d+\.\d+\.\d+\.\d+)/.exec(execFileSync(chromePath, ["--version"], { encoding: "utf8", timeout: 10_000 }))?.[1];
    return v ? `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36` : null;
  } catch {
    return null;
  }
}

export async function refreshProfileSession(o: RefreshOptions): Promise<{ cookieCount: number; wrote: boolean }> {
  if (!existsSync(o.profileDir)) throw new BrowserSessionError("browser profile does not exist; run `live-location login` first", "not_signed_in");
  const container = o.container ?? inContainer();
  clearStaleProfileLocks(o.profileDir, container);
  const ua = o.spawnImpl ? null : normalUserAgent(o.chromePath);
  const args = [...profileArgs(o.profileDir, container), "--headless=new", ...(ua ? [`--user-agent=${ua}`] : []), MAPS_URL];
  const child = (o.spawnImpl ?? nodeSpawn)(o.chromePath, args, { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    let exited = false;
    child.once("error", (e) =>
      reject(new BrowserSessionError(`could not start browser (is the login window still open?): ${(e as Error).message}`, "launch_failed")),
    );
    child.once("exit", () => {
      exited = true;
      resolve();
    });
    setTimeout(() => {
      if (exited) return;
      child.kill("SIGTERM"); // graceful shutdown: Chromium flushes its cookie store
      setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 15_000);
    }, o.dwellMs ?? 45_000);
  });
  return exportCookiesFromProfile(o);
}
