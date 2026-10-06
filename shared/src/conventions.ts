/** Shared MCP response conventions — see schemas/MCP_RESPONSE_CONVENTIONS.md */
export type SourceName = "google_timeline" | "google_location_sharing";
export type Precision = "semantic" | "approximate" | "exact";

export const PRECISION_RANK: Record<Precision, number> = { semantic: 0, approximate: 1, exact: 2 };

/** Clamp a requested precision to a server-configured maximum. */
export function clampPrecision(requested: Precision, max: Precision): Precision {
  return PRECISION_RANK[requested] <= PRECISION_RANK[max] ? requested : max;
}

/**
 * Apply a precision level to a coordinate pair.
 * semantic → no coordinates; approximate → 2 decimals (~1.1 km); exact → as-is (7 decimals max).
 */
export function applyPrecision(
  lat: number | null | undefined,
  lng: number | null | undefined,
  precision: Precision,
): { latitude?: number; longitude?: number } {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return {};
  if (precision === "semantic") return {};
  const d = precision === "approximate" ? 2 : 7;
  const f = 10 ** d;
  return { latitude: Math.round(lat * f) / f, longitude: Math.round(lng * f) / f };
}

export function freshnessSeconds(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now - t) / 1000));
}

export function boundedLimit(requested: number | undefined, def: number, max: number): number {
  const n = Math.floor(requested ?? def);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
}

/** Standard MCP tool result carrying both structured content and a JSON text block. */
export function toolResult(data: Record<string, unknown>) {
  return {
    structuredContent: data,
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

export function toolError(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export function humanDuration(seconds: number | null): string | null {
  if (seconds == null) return null;
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} d`;
}
