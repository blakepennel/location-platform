/**
 * Timestamp parsing shared by both MCP servers. Accepts ISO-8601 (with or without offset),
 * epoch seconds/milliseconds, or the keywords "now" / "today" / "yesterday".
 * Offset-less ISO strings are interpreted in `tz` (IANA, default LOCATION_TIMEZONE or system).
 */
export function defaultTimeZone(): string {
  return process.env.LOCATION_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function assertTimeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    throw new Error(`unknown IANA time zone: ${tz.slice(0, 60)}`);
  }
}

/** Offset (minutes east of UTC) of an IANA zone at a given instant. */
export function tzOffsetMinutes(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** Interpret wall-clock components in a zone → epoch ms (handles DST with one correction pass). */
export function zonedToEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const off = tzOffsetMinutes(tz, new Date(guess));
  let t = guess - off * 60000;
  const off2 = tzOffsetMinutes(tz, new Date(t));
  if (off2 !== off) t = guess - off2 * 60000;
  return t;
}

export function formatDateInZone(epochMs: number, tz: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(epochMs))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

/** [start, end) epoch ms of a calendar day in a zone. */
export function dayBounds(date: string, tz: string): { start: number; end: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error("date must be YYYY-MM-DD");
  const start = zonedToEpoch(+m[1], +m[2], +m[3], 0, 0, 0, 0, tz);
  const next = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1));
  const end = zonedToEpoch(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0, 0, tz);
  return { start, end };
}

export function parseTimestamp(input: string | number, tz = defaultTimeZone(), now = Date.now()): number {
  if (typeof input === "number") return input < 1e12 ? input * 1000 : input;
  const s = input.trim();
  const lower = s.toLowerCase();
  if (lower === "now") return now;
  if (lower === "today" || lower === "yesterday") {
    return dayBounds(formatDateInZone(now - (lower === "yesterday" ? 86400000 : 0), tz), tz).start;
  }
  if (/^\d{10}(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  if (/^\d{13}$/.test(s)) return Number(s);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (!m) throw new Error(`unrecognized timestamp: ${JSON.stringify(s).slice(0, 60)}`);
  const [, y, mo, d, h = "00", mi = "00", se = "00", frac = "0", zone] = m;
  const ms = Number(frac.padEnd(3, "0").slice(0, 3));
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +se > 60) {
    throw new Error(`invalid timestamp: ${s.slice(0, 60)}`);
  }
  if (zone) {
    const z = zone.toUpperCase() === "Z" ? "Z" : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
    const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${se}.${String(ms).padStart(3, "0")}${z}`);
    if (Number.isNaN(t)) throw new Error(`invalid timestamp: ${s.slice(0, 60)}`);
    return t;
  }
  return zonedToEpoch(+y, +mo, +d, +h, +mi, +se, ms, tz);
}

/** ISO string of an instant rendered with the offset of a zone (e.g. 2025-01-02T09:15:00+02:00). */
export function isoInZone(epochMs: number, tz: string): string {
  const off = tzOffsetMinutes(tz, new Date(epochMs));
  const local = new Date(epochMs + off * 60000).toISOString();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${local.slice(0, 19)}${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/** ISO string of an instant rendered with a fixed offset in minutes. */
export function isoWithOffset(epochMs: number, offsetMin: number): string {
  const local = new Date(epochMs + offsetMin * 60000).toISOString();
  const sign = offsetMin >= 0 ? "+" : "-";
  const a = Math.abs(offsetMin);
  return `${local.slice(0, 19)}${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

export function isoUtc(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
