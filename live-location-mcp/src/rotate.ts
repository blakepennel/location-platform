/**
 * L2 of the session keepalive: periodic `POST accounts.google.com/RotateCookies`, the same call
 * the Google web client makes to refresh __Secure-1PSIDTS / __Secure-3PSIDTS (prior art:
 * HanaokaYuzu/Gemini-API `rotate_1psidts`, notebooklm-py keepalive).
 *
 * Never throws: every outcome is a RotateResult so the poller loop is unaffected. Cookie values
 * are never logged or returned.
 */
import { statSync } from "node:fs";
import type { Logger } from "@location/shared";
import { CookieJar } from "./cookie-jar.ts";
import { hasRequiredCookies } from "./google.ts";
import type { LiveDb } from "./db.ts";
import type { ErrorKind } from "./source.ts";

export const ROTATE_URL = "https://accounts.google.com/RotateCookies";
export const ROTATE_BODY = '[000,"-0000000000000000000"]';
export const DEFAULT_ROTATE_INTERVAL_SEC = 600;
/** Skip when the cookies file changed this recently (another writer just refreshed it). */
export const MTIME_GUARD_MS = 60_000;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface RotateResult {
  ok: boolean;
  skipped?: "guard" | "not_due";
  errorKind?: ErrorKind;
  status?: number;
  /** server-suggested rotation interval in seconds (identity.hfcr) */
  intervalSec?: number;
  cookiesChanged?: boolean;
}

/** Extract `identity.hfcr` seconds from `)]}'\n[["identity.hfcr",600],["di",N]]`. */
export function parseRotateInterval(body: string): number {
  try {
    const nl = body.indexOf("\n");
    const json = JSON.parse(body.startsWith(")]}'") && nl >= 0 ? body.slice(nl + 1) : body);
    if (Array.isArray(json)) {
      for (const row of json) {
        if (Array.isArray(row) && row[0] === "identity.hfcr" && typeof row[1] === "number" && row[1] > 0) return row[1];
      }
    }
  } catch {
    /* fall through */
  }
  return DEFAULT_ROTATE_INTERVAL_SEC;
}

export interface RotateOptions {
  cookiesFile: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  timeoutMs?: number;
}

/** Perform one rotation now (no due/guard checks). */
export async function rotateCookies(o: RotateOptions): Promise<RotateResult> {
  let jar: CookieJar;
  try {
    jar = CookieJar.load(o.cookiesFile, { logger: o.logger }, true);
  } catch {
    return { ok: false, errorKind: "auth" };
  }
  if (!hasRequiredCookies(jar.cookiesFor(ROTATE_URL))) return { ok: false, errorKind: "auth" };
  const f = o.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(ROTATE_URL, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://accounts.google.com",
        Cookie: jar.headerFor(ROTATE_URL),
        "User-Agent": BROWSER_UA,
      },
      body: ROTATE_BODY,
      signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
    });
  } catch {
    return { ok: false, errorKind: "transient" };
  }
  let changed = false;
  try {
    changed = jar.applyResponse(res, ROTATE_URL);
    if (changed) jar.save();
  } catch {
    o.logger?.warn("cookiejar.write_failed");
  }
  const status = res.status;
  if (status === 401 || status === 403 || (status >= 300 && status < 400)) return { ok: false, errorKind: "auth", status, cookiesChanged: changed };
  if (status === 429) return { ok: false, errorKind: "rate_limit", status, cookiesChanged: changed };
  if (status !== 200) return { ok: false, errorKind: "transient", status, cookiesChanged: changed };
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* body is optional */
  }
  return { ok: true, status, intervalSec: parseRotateInterval(body), cookiesChanged: changed };
}

export const ROTATION_META = {
  lastOk: "cookie_rotation_last_ok_ms",
  lastAttempt: "cookie_rotation_last_attempt_ms",
  lastError: "cookie_rotation_last_error_kind",
  serverInterval: "cookie_rotation_server_interval_sec",
} as const;

export interface RotateIfDueOptions extends RotateOptions {
  db: LiveDb;
  minIntervalSec: number;
  now?: () => number;
}

/**
 * Rotate when due: `minIntervalSec` since the last attempt, unless the cookies file was modified
 * within 60 s (guard) — the guard is waived once rotation is badly overdue so a chatty
 * Set-Cookie writer can never starve it. Records the outcome in the meta table.
 */
export async function rotateIfDue(o: RotateIfDueOptions): Promise<RotateResult> {
  const now = (o.now ?? Date.now)();
  const lastOk = o.db.getMetaNumber(ROTATION_META.lastOk);
  const lastAttempt = o.db.getMetaNumber(ROTATION_META.lastAttempt);
  const last = Math.max(lastOk ?? 0, lastAttempt ?? 0);
  const intervalMs = o.minIntervalSec * 1000;
  if (last && now - last < intervalMs) return { ok: true, skipped: "not_due" };
  const overdue = lastOk != null && now - lastOk > intervalMs * 3;
  try {
    const mtime = statSync(o.cookiesFile).mtimeMs;
    if (!overdue && now - mtime < MTIME_GUARD_MS && now - mtime > -MTIME_GUARD_MS) return { ok: true, skipped: "guard" };
  } catch {
    /* missing file: rotateCookies reports auth */
  }
  const r = await rotateCookies(o);
  o.db.setMeta(ROTATION_META.lastAttempt, now);
  if (r.ok) {
    o.db.setMeta(ROTATION_META.lastOk, now);
    o.db.setMeta(ROTATION_META.lastError, null);
    if (r.intervalSec) o.db.setMeta(ROTATION_META.serverInterval, r.intervalSec);
    o.logger?.info("cookie_rotation.ok", { interval_sec: r.intervalSec, cookies_changed: r.cookiesChanged });
  } else {
    o.db.setMeta(ROTATION_META.lastError, r.errorKind ?? "unexpected");
    o.logger?.warn("cookie_rotation.failed", { kind: r.errorKind, status: r.status });
  }
  return r;
}
