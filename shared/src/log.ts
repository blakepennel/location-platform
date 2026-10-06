/**
 * Structured JSON logging to stderr (stdout is reserved for the MCP stdio transport).
 * Redacts credentials and, unless LOG_LOCATION_DEBUG=true, anything coordinate-shaped.
 */
import { envBool } from "./env.ts";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_PATTERNS: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]"],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[REDACTED_JWT]"],
  [/oauth2_4\/[A-Za-z0-9_\-.]+/g, "[REDACTED_OAUTH_TOKEN]"],
  [/ya29\.[A-Za-z0-9_\-.]+/g, "[REDACTED_ACCESS_TOKEN]"],
  [/aas_et\/[A-Za-z0-9_\-.]+/g, "[REDACTED_MASTER_TOKEN]"],
  [/(__Secure-[0-9A-Za-z]+|SAPISID|APISID|HSID|SSID|SID|NID|SIDCC|OSID)=([^;\s]+)/g, "$1=[REDACTED]"],
];
const COORD_PATTERN = /-?\d{1,3}\.\d{4,}\s*°?\s*,\s*-?\d{1,3}\.\d{4,}/g;
const SENSITIVE_KEYS =
  /^(authorization|cookie|cookies|set-cookie|token|access_token|refresh_token|id_token|password|secret|key|master|code|code_verifier)$/i;
const LOCATION_KEYS = /^(lat|lng|lon|latitude|longitude|latlng|point|points|coordinates|address)$/i;

export function redactString(s: string, allowLocation = false): string {
  let out = s;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  if (!allowLocation) out = out.replace(COORD_PATTERN, "[REDACTED_COORDS]");
  return out;
}

export function redact(value: unknown, allowLocation = false, depth = 0): unknown {
  if (depth > 6) return "[...]";
  if (typeof value === "string") return redactString(value, allowLocation);
  if (Array.isArray(value)) return value.map((v) => redact(v, allowLocation, depth + 1));
  if (value && typeof value === "object") {
    if (value instanceof Error) return { name: value.name, message: redactString(value.message, allowLocation) };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEYS.test(k)) out[k] = "[REDACTED]";
      else if (!allowLocation && LOCATION_KEYS.test(k)) out[k] = "[REDACTED_LOCATION]";
      else out[k] = redact(v, allowLocation, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  /** Location-bearing debug output; emitted only with LOG_LOCATION_DEBUG=true. */
  location(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  service: string,
  sink: (line: string) => void = (l) => process.stderr.write(l + "\n"),
): Logger {
  const min = ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? ORDER.info;
  const locationDebug = envBool("LOG_LOCATION_DEBUG", false);
  const emit = (level: Level, event: string, fields?: Record<string, unknown>, allowLocation = false) => {
    if (ORDER[level] < min) return;
    const rec = { ts: new Date().toISOString(), level, service, event, ...(redact(fields ?? {}, allowLocation) as object) };
    sink(JSON.stringify(rec));
  };
  return {
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
    location: (e, f) => {
      if (locationDebug) emit("debug", e, { ...f, location_debug: true }, true);
    },
  };
}
