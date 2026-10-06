/**
 * Google Maps Location Sharing adapter.
 *
 * This talks to an UNDOCUMENTED, unofficial endpoint (the one the maps.google.com web client
 * uses) with cookies from a logged-in DEDICATED recipient account. It is inherently brittle:
 * the response is a positional nested array and any layout change surfaces as FormatError /
 * SharingLapsedError rather than a crash. Nothing here ever logs cookies or coordinates.
 */
import { chmodSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Logger } from "@location/shared";
import { CookieJar } from "./cookie-jar.ts";
import {
  AuthError,
  FormatError,
  RateLimitError,
  SharerSelectionError,
  SharingLapsedError,
  TransientError,
  type LiveLocationSource,
  type Observation,
  type SourceDescription,
} from "./source.ts";

export const LOCATION_SHARING_URL = "https://www.google.com/maps/rpc/locationsharing/read";

/**
 * Opaque map-tile `pb` parameter required by the endpoint. Copied verbatim from the public
 * `locationsharinglib` project (the same value the reverse-engineered web client sends). It has
 * no location meaning for us. Override with LIVE_PB if Google ever rejects it.
 */
export const DEFAULT_PB =
  "!1m7!8m6!1m3!1i14!2i8413!3i5385!2i6!3x4095!2m3!1e0!2sm!3i407105169!3m7!2sen!5e1105!12m4!1e68!2m2!1sset!2sRoadmap!4e1!5m4!1e4!8m2!1e0!1e1!6m9!1e12!2i2!26m1!4b1!30m1!1f1.3953487873077393!39b1!44e1!50e0!23i4111425";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const XSSI_PREFIX = ")]}'";

// ------------------------------------------------------------------ cookies.txt

export interface NetscapeCookie {
  domain: string;
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  /** epoch seconds; 0 = session cookie */
  expires: number;
  name: string;
  value: string;
  /** written as a #HttpOnly_ line */
  httpOnly?: boolean;
}

/** Parse a Netscape cookies.txt. `#HttpOnly_` lines are cookies; other `#` lines are comments. */
export function parseNetscapeCookies(text: string): NetscapeCookie[] {
  const out: NetscapeCookie[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    let httpOnly = false;
    if (line.startsWith("#HttpOnly_")) {
      httpOnly = true;
      line = line.slice("#HttpOnly_".length);
    }
    else if (line.startsWith("#")) continue;
    const f = line.split("\t");
    if (f.length < 7) continue;
    const [domain, sub, path, secure, exp, name, ...rest] = f;
    const value = rest.join("\t");
    if (!name || /[\s;=,"\\\x00-\x1f\x7f]/.test(name)) continue;
    if (/[;\x00-\x1f\x7f]/.test(value)) continue; // would corrupt / be rejected in a Cookie header
    out.push({
      domain: domain.toLowerCase(),
      includeSubdomains: sub.toUpperCase() === "TRUE",
      path: path || "/",
      secure: secure.toUpperCase() === "TRUE",
      expires: Number(exp) || 0,
      name,
      value,
      ...(httpOnly ? { httpOnly } : {}),
    });
  }
  return out;
}

function domainMatches(cookieDomain: string, host: string): boolean {
  const d = cookieDomain.replace(/^\./, "");
  return host === d || host.endsWith("." + d);
}

/** Cookies a browser would send to `url` (domain/path/expiry matched). */
export function cookiesForUrl(cookies: NetscapeCookie[], url: string, nowMs = Date.now()): NetscapeCookie[] {
  const u = new URL(url);
  return cookies.filter(
    (c) =>
      domainMatches(c.domain, u.hostname) &&
      u.pathname.startsWith(c.path === "/" ? "/" : c.path) &&
      (c.expires === 0 || c.expires * 1000 > nowMs),
  );
}

export function hasRequiredCookies(cookies: NetscapeCookie[]): boolean {
  return cookies.some((c) => c.name === "__Secure-1PSID" || c.name === "__Secure-3PSID");
}

export function buildCookieHeader(cookies: NetscapeCookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Returns a human warning if the cookies file is readable by other users (POSIX only). */
/**
 * Restrict the cookies file to the current user: chmod 600 on POSIX; on Windows, reset the
 * ACL and grant only the current user (icacls via execFile, so no shell path mangling).
 */
export function secureCookiesFile(path: string): boolean {
  try {
    if (process.platform !== "win32") {
      chmodSync(path, 0o600);
      return true;
    }
    const user = process.env.USERNAME;
    if (!user) return false;
    execFileSync("icacls", [path, "/reset"], { stdio: "ignore", windowsHide: true });
    execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function cookiesFilePermissionWarning(path: string): string | null {
  if (process.platform === "win32") return null;
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) return `cookies file permissions are ${mode.toString(8)}; run: chmod 600 <cookies file>`;
  } catch {
    /* ignore */
  }
  return null;
}

// ------------------------------------------------------------------ response parsing

export interface ParsedSharer {
  person_id: string;
  observation: Observation | null;
}

const isArr = (x: unknown): x is unknown[] => Array.isArray(x);

function num(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
const str = (x: unknown): string | undefined => (typeof x === "string" && x !== "" ? x : undefined);

/**
 * Decode the XSSI-prefixed response into the raw nested array, or throw.
 * HTML (login page / consent interstitial), truncated or otherwise non-JSON bodies are AuthError:
 * in practice that is what dead cookies look like.
 */
export function decodeEnvelope(text: string): unknown[] {
  if (typeof text !== "string" || text.length === 0) throw new AuthError("empty response (cookies likely rejected)");
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<")) throw new AuthError("received an HTML page instead of location data (cookies expired?)");
  const nl = text.indexOf("\n");
  if (!trimmed.startsWith(XSSI_PREFIX) || nl < 0) throw new AuthError("response missing expected XSSI prefix (cookies rejected?)");
  let output: unknown;
  try {
    output = JSON.parse(text.slice(nl + 1));
  } catch {
    throw new AuthError("response body was not valid JSON (cookies rejected?)");
  }
  if (!isArr(output)) throw new FormatError("unexpected top-level response shape");
  if (output[6] === "GgA=") throw new AuthError("Google reports the session is not authenticated (re-export cookies)");
  return output;
}

/** Extract every sharing person (with their observation when a location block exists). */
export function parseSharers(text: string): ParsedSharer[] {
  const output = decodeEnvelope(text);
  const people = output[0];
  if (people == null || (isArr(people) && people.length === 0)) {
    throw new SharingLapsedError("nobody is currently sharing location with this account");
  }
  if (!isArr(people)) throw new FormatError("unexpected sharers block shape");

  const out: ParsedSharer[] = [];
  for (const p of people) {
    if (!isArr(p)) continue;
    const meta = isArr(p[6]) ? p[6] : null;
    const id = meta ? (typeof meta[0] === "string" ? meta[0] : meta[0] != null ? String(meta[0]) : undefined) : undefined;
    if (!id) continue;
    out.push({ person_id: id, observation: extractObservation(p, id, meta ?? []) });
  }
  if (out.length === 0) throw new FormatError("sharers block contained no recognizable person entries");
  return out;
}

function extractObservation(p: unknown[], id: string, meta: unknown[]): Observation | null {
  const loc = p[1];
  if (!isArr(loc)) return null;
  const ll = loc[1];
  if (!isArr(ll)) return null;
  // NOTE: Google orders longitude BEFORE latitude.
  const lng = num(ll[1]);
  const lat = num(ll[2]);
  let ts = num(loc[2]);
  if (lng == null || lat == null || ts == null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (ts > 0 && ts < 1e12) ts *= 1000; // tolerate seconds
  if (ts <= 0) return null;
  const obs: Observation = { person_id: id, source_ts_ms: Math.round(ts), lat, lng };
  const acc = num(loc[3]);
  if (acc != null && acc >= 0) obs.accuracy_m = acc;
  const addr = str(loc[4]);
  if (addr) obs.address = addr;
  const cc = str(loc[6]);
  if (cc) obs.country = cc;
  try {
    const b = p[13];
    if (isArr(b)) {
      if (typeof b[0] === "boolean") obs.battery_charging = b[0];
      const lvl = num(b[1]);
      if (lvl != null) obs.battery_level = lvl;
    }
  } catch {
    /* battery is optional */
  }
  const fullName = isArr(p[0]) ? str(p[0][3]) : undefined;
  const dn = fullName ?? str(meta[2]);
  if (dn) obs.display_name = dn;
  const nick = str(meta[3]);
  if (nick) obs.nickname = nick;
  return obs;
}

/**
 * Pure: raw response text → observations for the selected sharer.
 * - `sharerId` given: that person (SharerSelectionError listing ids if absent).
 * - unset + exactly one sharer: that person.
 * - unset + several: SharerSelectionError listing ids (never coordinates).
 */
export function parseLocationSharingResponse(
  text: string,
  sharerId?: string,
): { observations: Observation[]; sharerIds: string[] } {
  const sharers = parseSharers(text);
  const ids = sharers.map((s) => s.person_id);
  let chosen: ParsedSharer | undefined;
  if (sharerId) {
    chosen = sharers.find((s) => s.person_id === sharerId);
    if (!chosen) {
      throw new SharerSelectionError(`configured LIVE_SHARER_ID not among current sharers; available ids: ${ids.join(", ")}`, ids);
    }
  } else if (sharers.length === 1) {
    chosen = sharers[0];
  } else {
    throw new SharerSelectionError(`${sharers.length} people are sharing; set LIVE_SHARER_ID to one of: ${ids.join(", ")}`, ids);
  }
  if (!chosen.observation) throw new SharingLapsedError("sharer present but no location block available");
  return { observations: [chosen.observation], sharerIds: ids };
}

// ------------------------------------------------------------------ real source

export interface GoogleSourceOptions {
  cookiesFile: string;
  sharerId?: string;
  pb?: string;
  timeoutMs?: number;
  /** injectable for tests of the HTTP status mapping (tests never reach Google) */
  fetchImpl?: typeof fetch;
  url?: string;
  /** for cookie write-back diagnostics (counts only, never values) */
  logger?: Logger;
}

function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s) * 1000;
  const d = Date.parse(h);
  return Number.isNaN(d) ? undefined : Math.max(0, d - Date.now());
}

export class GoogleLocationSharingSource implements LiveLocationSource {
  private readonly o: GoogleSourceOptions;
  constructor(opts: GoogleSourceOptions) {
    this.o = opts;
  }

  private buildUrl(): string {
    const u = new URL(this.o.url ?? LOCATION_SHARING_URL);
    u.searchParams.set("authuser", "0");
    u.searchParams.set("hl", "en");
    u.searchParams.set("gl", "us");
    u.searchParams.set("pb", this.o.pb || DEFAULT_PB);
    return u.toString();
  }

  private loadJar(): CookieJar {
    try {
      return CookieJar.load(this.o.cookiesFile, { logger: this.o.logger }, true);
    } catch {
      throw new AuthError("cookies file not found or unreadable; export cookies.txt for the recipient account (see README)");
    }
  }

  /** Feed a response's Set-Cookie headers into the jar and persist if they changed anything. */
  private absorb(jar: CookieJar, res: Response, url: string): void {
    try {
      if (jar.applyResponse(res, url)) jar.save();
    } catch {
      this.o.logger?.warn("cookiejar.write_failed");
    }
  }

  private cookieHeader(jar: CookieJar, url: string): string {
    const usable = jar.cookiesFor(url);
    if (!hasRequiredCookies(usable)) {
      throw new AuthError("cookies file has no unexpired __Secure-1PSID/__Secure-3PSID cookie for google.com; re-export");
    }
    return buildCookieHeader(usable);
  }

  /** GET the raw response text, mapping HTTP/network failures to typed errors. */
  async fetchText(): Promise<string> {
    const url = this.buildUrl();
    const jar = this.loadJar();
    const cookie = this.cookieHeader(jar, url);
    const f = this.o.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f(url, {
        method: "GET",
        redirect: "manual",
        headers: { Cookie: cookie, "User-Agent": BROWSER_UA, Accept: "*/*", "Accept-Language": "en-US,en;q=0.9" },
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000),
      });
    } catch (e) {
      const what = (e as Error)?.name === "TimeoutError" ? "timeout" : "network error";
      throw new TransientError(`request failed (${what})`);
    }
    this.absorb(jar, res, url);
    const status = res.status;
    if (status === 429 || status === 503) {
      throw new RateLimitError(`throttled by Google (HTTP ${status})`, {
        status,
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      });
    }
    if (status >= 300 && status < 400) throw new AuthError(`redirected (HTTP ${status}); session not accepted`, { status });
    if (status === 401 || status === 403) throw new AuthError(`rejected (HTTP ${status})`, { status });
    if (status >= 500) throw new TransientError(`server error (HTTP ${status})`, { status });
    if (status !== 200) throw new TransientError(`unexpected HTTP ${status}`, { status });
    try {
      return await res.text();
    } catch {
      throw new TransientError("failed reading response body");
    }
  }

  async fetchLatest(): Promise<Observation[]> {
    return parseLocationSharingResponse(await this.fetchText(), this.o.sharerId).observations;
  }

  /** For `live-location auth`: authenticate and list sharer ids. Never returns coordinates. */
  async probe(): Promise<{ sharerIds: string[]; withLocation: number }> {
    const sharers = parseSharers(await this.fetchText());
    return { sharerIds: sharers.map((s) => s.person_id), withLocation: sharers.filter((s) => s.observation).length };
  }

  describe(): SourceDescription {
    return {
      kind: "google_location_sharing",
      details: { cookies_file: this.o.cookiesFile, sharer_id_configured: Boolean(this.o.sharerId), pb_overridden: Boolean(this.o.pb) },
    };
  }
}
