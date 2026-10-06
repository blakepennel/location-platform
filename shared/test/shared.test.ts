import { describe, expect, it } from "vitest";
import { redact, redactString } from "../src/log.ts";
import { applyPrecision, boundedLimit, clampPrecision, freshnessSeconds, humanDuration } from "../src/conventions.ts";
import { downsample, haversineMeters, parseLatLngString, pathLengthMeters } from "../src/geo.ts";
import { dayBounds, isoInZone, isoWithOffset, parseTimestamp, tzOffsetMinutes } from "../src/time.ts";

describe("log redaction", () => {
  it("scrubs credential-shaped strings", () => {
    expect(redactString("Authorization: Bearer ya29.SECRETVALUE_abcdef")).not.toContain("SECRETVALUE");
    expect(redactString("token oauth2_4/abcDEF-123.456")).toContain("[REDACTED_OAUTH_TOKEN]");
    expect(redactString("m aas_et/longlonglongtoken")).toContain("[REDACTED_MASTER_TOKEN]");
    expect(redactString("cookie __Secure-1PSID=abcdefghijklmnop; x=1")).toContain("[REDACTED]");
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJvd25lci1hY2NvdW50In0.sig_part_here_abc";
    expect(redactString(jwt)).toContain("[REDACTED_JWT]");
  });

  it("scrubs coordinate-shaped strings by default and coordinate-named keys", () => {
    expect(redactString("at 12.3456789, 98.7654321 now")).toContain("[REDACTED_COORDS]");
    const obj = redact({ latitude: 12.34, address: "1 Main St", note: "hi", access_token: "abc", authHeader: "ya29.SECRETSECRETSECRET" }) as Record<string, unknown>;
    expect(obj.latitude).toBe("[REDACTED_LOCATION]");
    expect(obj.address).toBe("[REDACTED_LOCATION]");
    expect(obj.note).toBe("hi");
    // key-based redaction for a known sensitive key name
    expect(obj.access_token).toBe("[REDACTED]");
    // value-based redaction even when the key name is innocuous
    expect(String(obj.authHeader)).not.toContain("SECRETSECRET");
  });

  it("can allow location when explicitly requested", () => {
    expect(redactString("12.3456789, 98.7654321", true)).toContain("12.3456789");
  });
});

describe("precision", () => {
  it("semantic drops coordinates entirely", () => {
    expect(applyPrecision(12.3456789, 98.7654321, "semantic")).toEqual({});
  });
  it("approximate rounds to 2dp, exact keeps 7dp", () => {
    expect(applyPrecision(12.3456789, 98.7654321, "approximate")).toEqual({ latitude: 12.35, longitude: 98.77 });
    expect(applyPrecision(12.3456789, 98.7654321, "exact")).toEqual({ latitude: 12.3456789, longitude: 98.7654321 });
  });
  it("clamps to a maximum", () => {
    expect(clampPrecision("exact", "approximate")).toBe("approximate");
    expect(clampPrecision("semantic", "exact")).toBe("semantic");
  });
});

describe("limits + freshness", () => {
  it("bounds limits", () => {
    expect(boundedLimit(undefined, 50, 500)).toBe(50);
    expect(boundedLimit(10000, 50, 500)).toBe(500);
    expect(boundedLimit(-3, 50, 500)).toBe(50);
  });
  it("computes freshness seconds", () => {
    const now = Date.parse("2026-01-01T00:10:00Z");
    expect(freshnessSeconds("2026-01-01T00:00:00Z", now)).toBe(600);
    expect(freshnessSeconds(null)).toBeNull();
  });
  it("humanizes durations", () => {
    expect(humanDuration(30)).toMatch(/s$/);
    expect(humanDuration(600)).toMatch(/min$/);
    expect(humanDuration(7200)).toMatch(/h$/);
  });
});

describe("geo", () => {
  it("haversine ~ known distance", () => {
    const d = haversineMeters({ lat: 10, lng: 20 }, { lat: 10, lng: 20.001 });
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(120);
  });
  it("path length sums segments", () => {
    const pts = [{ lat: 10, lng: 20 }, { lat: 10, lng: 20.001 }, { lat: 10, lng: 20.002 }];
    expect(pathLengthMeters(pts)).toBeCloseTo(2 * haversineMeters(pts[0], pts[1]), 3);
  });
  it("downsample keeps endpoints and cap", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const ds = downsample(arr, 10);
    expect(ds.length).toBe(10);
    expect(ds[0]).toBe(0);
    expect(ds.at(-1)).toBe(99);
    expect(downsample(arr, 200).length).toBe(100);
  });
  it("parses lat/lng strings and rejects junk", () => {
    expect(parseLatLngString("12.34°, 98.76°")).toEqual({ lat: 12.34, lng: 98.76 });
    expect(parseLatLngString("nonsense")).toBeNull();
    expect(parseLatLngString("200.0, 0.0")).toBeNull();
  });
});

describe("time", () => {
  it("parses ISO with offset, epoch, and keywords", () => {
    expect(parseTimestamp("2025-01-02T14:01:06.171+02:00")).toBe(Date.parse("2025-01-02T12:01:06.171Z"));
    expect(parseTimestamp(1735825266)).toBe(1735825266000);
    expect(parseTimestamp(1735825266171)).toBe(1735825266171);
    const now = Date.parse("2026-03-15T12:00:00Z");
    expect(parseTimestamp("now", "UTC", now)).toBe(now);
  });
  it("interprets offset-less times in the given zone", () => {
    // New York is UTC-5 in January (no DST).
    expect(parseTimestamp("2025-01-02T09:00:00", "America/New_York")).toBe(Date.parse("2025-01-02T14:00:00Z"));
  });
  it("computes day bounds in a zone", () => {
    const { start, end } = dayBounds("2025-07-01", "America/New_York"); // DST, UTC-4
    expect(new Date(start).toISOString()).toBe("2025-07-01T04:00:00.000Z");
    expect(end - start).toBe(86400000);
  });
  it("handles a DST-transition day length", () => {
    // US spring-forward 2025-03-09 is 23h long.
    const { start, end } = dayBounds("2025-03-09", "America/New_York");
    expect(end - start).toBe(23 * 3600000);
  });
  it("renders ISO in a zone and with a fixed offset", () => {
    const t = Date.parse("2025-01-02T12:00:00Z");
    expect(isoInZone(t, "America/New_York")).toBe("2025-01-02T07:00:00-05:00");
    expect(isoWithOffset(t, -300)).toBe("2025-01-02T07:00:00-05:00");
    expect(isoWithOffset(t, 120)).toBe("2025-01-02T14:00:00+02:00");
  });
  it("offset helper is correct for both hemispheres", () => {
    expect(tzOffsetMinutes("America/New_York", new Date("2025-01-15T00:00:00Z"))).toBe(-300);
    expect(tzOffsetMinutes("Europe/Athens", new Date("2025-07-15T00:00:00Z"))).toBe(180);
  });
});
