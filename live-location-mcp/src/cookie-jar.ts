/**
 * L1 of the session keepalive: a write-back cookie jar over the Netscape cookies.txt.
 *
 * Google rotates short-lived cookies (__Secure-1PSIDTS / 3PSIDTS, SIDCC, ...) via Set-Cookie on
 * ordinary responses. A jar that only reads the file lets the session die; this one applies
 * Set-Cookie headers and writes the file back atomically (tmp + rename), keeping a one-generation
 * `.bak`, preserving comments/unknown lines, and only writing when something changed.
 * Cookie VALUES are never logged (only counts).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "@location/shared";
import { buildCookieHeader, cookiesForUrl, parseNetscapeCookies, secureCookiesFile, type NetscapeCookie } from "./google.ts";

const HEADER_LINE = "# Netscape HTTP Cookie File";

const keyOf = (c: Pick<NetscapeCookie, "domain" | "path" | "name">) => `${c.domain}\t${c.path}\t${c.name}`;

export function formatNetscapeCookie(c: NetscapeCookie): string {
  return [
    (c.httpOnly ? "#HttpOnly_" : "") + c.domain,
    c.includeSubdomains ? "TRUE" : "FALSE",
    c.path,
    c.secure ? "TRUE" : "FALSE",
    String(Math.trunc(c.expires) || 0),
    c.name,
    c.value,
  ].join("\t");
}

function domainMatchesHost(domain: string, host: string): boolean {
  const d = domain.replace(/^\./, "");
  return host === d || host.endsWith("." + d);
}

function defaultPath(pathname: string): string {
  if (!pathname.startsWith("/")) return "/";
  const i = pathname.lastIndexOf("/");
  return i <= 0 ? "/" : pathname.slice(0, i);
}

/** Parse one Set-Cookie header against the URL that produced it. Null = ignore it. */
export function parseSetCookie(header: string, requestUrl: string, nowMs: number): { cookie: NetscapeCookie; remove: boolean } | null {
  const u = new URL(requestUrl);
  const parts = header.split(";");
  const nv = parts.shift() ?? "";
  const eq = nv.indexOf("=");
  if (eq <= 0) return null;
  const name = nv.slice(0, eq).trim();
  const value = nv.slice(eq + 1).trim();
  if (!name || /[\s;=,"\\\x00-\x1f\x7f]/.test(name) || /[;\x00-\x1f\x7f]/.test(value)) return null;

  let domainAttr: string | undefined;
  let pathAttr: string | undefined;
  let secure = false;
  let httpOnly = false;
  let expires: number | undefined; // epoch seconds
  let maxAge: number | undefined;
  for (const raw of parts) {
    const i = raw.indexOf("=");
    const k = (i < 0 ? raw : raw.slice(0, i)).trim().toLowerCase();
    const v = i < 0 ? "" : raw.slice(i + 1).trim();
    if (k === "domain" && v) domainAttr = v.replace(/^\./, "").toLowerCase();
    else if (k === "path" && v.startsWith("/")) pathAttr = v;
    else if (k === "secure") secure = true;
    else if (k === "httponly") httpOnly = true;
    else if (k === "max-age" && /^-?\d+$/.test(v)) maxAge = Number(v);
    else if (k === "expires") {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) expires = Math.floor(t / 1000);
    }
  }
  let domain: string;
  let includeSubdomains: boolean;
  if (domainAttr) {
    if (!domainMatchesHost(domainAttr, u.hostname)) return null; // a host may only set cookies for itself/parents
    domain = "." + domainAttr;
    includeSubdomains = true;
  } else {
    domain = u.hostname.toLowerCase();
    includeSubdomains = false;
  }
  const path = pathAttr ?? defaultPath(u.pathname);
  let exp = 0;
  let remove = false;
  if (maxAge !== undefined) {
    if (maxAge <= 0) remove = true;
    else exp = Math.floor(nowMs / 1000) + maxAge;
  } else if (expires !== undefined) {
    if (expires * 1000 <= nowMs) remove = true;
    else exp = expires;
  }
  return { cookie: { domain, includeSubdomains, path, secure, expires: exp, name, value, ...(httpOnly ? { httpOnly } : {}) }, remove };
}

export interface CookieJarOptions {
  now?: () => number;
  logger?: Logger;
  /** test seam; defaults to secureCookiesFile */
  secure?: (path: string) => boolean;
}

export class CookieJar {
  private map = new Map<string, NetscapeCookie>();
  private original = "";
  private dirty = false;
  private readonly now: () => number;

  constructor(
    readonly path: string,
    private readonly opts: CookieJarOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** Load from disk. A missing file yields an empty jar unless `required` (then it throws). */
  static load(path: string, opts: CookieJarOptions = {}, required = false): CookieJar {
    const jar = new CookieJar(path, opts);
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      if (required) throw e;
    }
    jar.original = text;
    for (const c of parseNetscapeCookies(text)) jar.map.set(keyOf(c), c);
    return jar;
  }

  get cookies(): NetscapeCookie[] {
    return [...this.map.values()];
  }
  get isDirty(): boolean {
    return this.dirty;
  }

  /** Cookies a browser would send to `url`. */
  cookiesFor(url: string): NetscapeCookie[] {
    return cookiesForUrl(this.cookies, url, this.now());
  }
  headerFor(url: string): string {
    return buildCookieHeader(this.cookiesFor(url));
  }

  /** Apply Set-Cookie headers from a response to `requestUrl`. Returns true if anything changed. */
  applySetCookie(headers: string[], requestUrl: string): boolean {
    let changed = false;
    for (const h of headers) {
      let parsed;
      try {
        parsed = parseSetCookie(h, requestUrl, this.now());
      } catch {
        parsed = null;
      }
      if (!parsed) continue;
      const k = keyOf(parsed.cookie);
      const prev = this.map.get(k);
      if (parsed.remove) {
        if (prev) {
          this.map.delete(k);
          changed = true;
        }
        continue;
      }
      if (!prev || prev.value !== parsed.cookie.value || prev.expires !== parsed.cookie.expires || prev.secure !== parsed.cookie.secure || Boolean(prev.httpOnly) !== Boolean(parsed.cookie.httpOnly)) {
        this.map.set(k, parsed.cookie);
        changed = true;
      }
    }
    if (changed) this.dirty = true;
    return changed;
  }

  /** Convenience for a fetch Response. */
  applyResponse(res: Response, requestUrl: string): boolean {
    const list = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    return this.applySetCookie(list, requestUrl);
  }

  /** Replace the whole cookie set (used by the browser export). */
  replaceAll(cookies: NetscapeCookie[]): void {
    const next = new Map<string, NetscapeCookie>();
    for (const c of cookies) next.set(keyOf(c), c);
    const same = next.size === this.map.size && [...next].every(([k, c]) => {
      const p = this.map.get(k);
      return p && p.value === c.value && p.expires === c.expires;
    });
    if (same) return;
    this.map = next;
    this.dirty = true;
  }

  private render(): string {
    const remaining = new Map(this.map);
    const out: string[] = [];
    const lines = this.original === "" ? [] : this.original.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      const parsed = parseNetscapeCookies(line);
      if (parsed.length === 0) {
        out.push(line); // comment / blank / unknown: preserved verbatim
        continue;
      }
      const k = keyOf(parsed[0]);
      const cur = remaining.get(k);
      if (!cur) continue; // deleted
      remaining.delete(k);
      const prev = parsed[0];
      out.push(prev.value === cur.value && prev.expires === cur.expires && prev.secure === cur.secure && Boolean(prev.httpOnly) === Boolean(cur.httpOnly) ? line : formatNetscapeCookie(cur));
    }
    if (out.length === 0 || !out.some((l) => l.startsWith("# Netscape"))) out.unshift(HEADER_LINE);
    for (const c of remaining.values()) out.push(formatNetscapeCookie(c));
    return out.join("\n") + "\n";
  }

  /** Write back if (and only if) something changed. Returns whether a write happened. */
  save(): boolean {
    if (!this.dirty) return false;
    const text = this.render();
    const secure = this.opts.secure ?? secureCookiesFile;
    const tmp = `${this.path}.tmp-${process.pid}`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      if (existsSync(this.path)) {
        const bak = `${this.path}.bak`;
        copyFileSync(this.path, bak);
        secure(bak);
      }
      writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw e;
    }
    secure(this.path);
    this.original = text;
    this.dirty = false;
    this.opts.logger?.info("cookiejar.saved", { cookie_count: this.map.size });
    return true;
  }
}
