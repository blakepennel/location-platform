import { describe, expect, it } from "vitest";
import {
  buildCookieHeader,
  cookiesForUrl,
  hasRequiredCookies,
  parseLocationSharingResponse,
  parseNetscapeCookies,
  LOCATION_SHARING_URL,
} from "../src/google.ts";
import { AuthError, FormatError, SharerSelectionError, SharingLapsedError } from "../src/source.ts";
import { HTML_RESPONSE, T0, UNAUTH_RESPONSE, XSSI, fakeResponse } from "./fixtures.ts";

const ONE = { id: "111", lat: 10.5, lng: 20.25, ts: T0 };

describe("parseLocationSharingResponse", () => {
  it("parses a single sharer with lng before lat in the source array", () => {
    const { observations, sharerIds } = parseLocationSharingResponse(
      fakeResponse([{ ...ONE, acc: 25, address: "Nowhere Rd", country: "ZZ", battery: [true, 55], nickname: "nick" }]),
    );
    expect(sharerIds).toEqual(["111"]);
    expect(observations).toHaveLength(1);
    const o = observations[0];
    expect(o.lat).toBe(10.5);
    expect(o.lng).toBe(20.25);
    expect(o.source_ts_ms).toBe(T0);
    expect(o.accuracy_m).toBe(25);
    expect(o.address).toBe("Nowhere Rd");
    expect(o.country).toBe("ZZ");
    expect(o.battery_level).toBe(55);
    expect(o.battery_charging).toBe(true);
    expect(o.display_name).toBe("Synthetic Person");
    expect(o.nickname).toBe("nick");
    expect(o.person_id).toBe("111");
  });

  it("uses the fallback name when the full name is missing and tolerates null country", () => {
    const { observations } = parseLocationSharingResponse(fakeResponse([{ ...ONE, name: null, country: null }]));
    expect(observations[0].display_name).toBe("Fallback Name");
    expect(observations[0].country).toBeUndefined();
  });

  it("tolerates a missing battery block", () => {
    const { observations } = parseLocationSharingResponse(fakeResponse([{ ...ONE, battery: null }]));
    expect(observations[0].battery_level).toBeUndefined();
    expect(observations[0].battery_charging).toBeUndefined();
  });

  it("tolerates a battery block that is the wrong shape", () => {
    const text = fakeResponse([ONE]).replace("[false,77]", '"garbage"');
    const { observations } = parseLocationSharingResponse(text);
    expect(observations[0].battery_level).toBeUndefined();
  });

  it("ignores the recipient's own location at output[9]", () => {
    const { observations } = parseLocationSharingResponse(fakeResponse([ONE], { own: true }));
    expect(observations).toHaveLength(1);
    expect(observations[0].lat).toBe(10.5);
  });

  it("requires a sharer id when several people share, listing ids without coordinates", () => {
    const text = fakeResponse([ONE, { id: "222", lat: 10.7, lng: 20.7, ts: T0 }]);
    let err: unknown;
    try {
      parseLocationSharingResponse(text);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SharerSelectionError);
    const msg = (err as Error).message;
    expect(msg).toContain("111");
    expect(msg).toContain("222");
    expect(msg).not.toMatch(/10\.5|20\.25|10\.7|20\.7/);
    expect((err as SharerSelectionError).available).toEqual(["111", "222"]);
  });

  it("selects the configured sharer among several", () => {
    const text = fakeResponse([ONE, { id: "222", lat: 10.7, lng: 20.7, ts: T0 + 1000 }]);
    const { observations } = parseLocationSharingResponse(text, "222");
    expect(observations[0].person_id).toBe("222");
    expect(observations[0].lat).toBe(10.7);
    expect(observations[0].lng).toBe(20.7);
  });

  it("errors (ids only) when the configured sharer is not present", () => {
    expect(() => parseLocationSharingResponse(fakeResponse([ONE]), "999")).toThrow(SharerSelectionError);
  });

  it("GgA= means not authenticated", () => {
    expect(() => parseLocationSharingResponse(UNAUTH_RESPONSE)).toThrow(AuthError);
  });

  it("HTML / garbage / truncated / missing-prefix bodies are AuthError", () => {
    expect(() => parseLocationSharingResponse(HTML_RESPONSE)).toThrow(AuthError);
    expect(() => parseLocationSharingResponse("")).toThrow(AuthError);
    expect(() => parseLocationSharingResponse("totally not json")).toThrow(AuthError);
    expect(() => parseLocationSharingResponse(XSSI + "\n{not json")).toThrow(AuthError);
    expect(() => parseLocationSharingResponse("[[1,2,3]]")).toThrow(AuthError);
  });

  it("empty or null output[0] means sharing lapsed", () => {
    expect(() => parseLocationSharingResponse(fakeResponse(null))).toThrow(SharingLapsedError);
    expect(() => parseLocationSharingResponse(fakeResponse([]))).toThrow(SharingLapsedError);
  });

  it("a sharer with no location block is treated as lapsed", () => {
    expect(() => parseLocationSharingResponse(fakeResponse([{ ...ONE, noLocation: true }]))).toThrow(SharingLapsedError);
  });

  it("a non-array top level or unrecognizable people are FormatError (layout change), not a crash", () => {
    expect(() => parseLocationSharingResponse(XSSI + '\n{"a":1}')).toThrow(FormatError);
    expect(() => parseLocationSharingResponse(XSSI + "\n" + JSON.stringify([[["x"]]]))).toThrow(FormatError);
  });

  it("rejects out-of-range coordinates as no location", () => {
    expect(() => parseLocationSharingResponse(fakeResponse([{ ...ONE, lat: 123 }]))).toThrow(SharingLapsedError);
  });

  it("accepts a timestamp given in seconds", () => {
    const { observations } = parseLocationSharingResponse(fakeResponse([{ ...ONE, ts: Math.floor(T0 / 1000) }]));
    expect(observations[0].source_ts_ms).toBe(Math.floor(T0 / 1000) * 1000);
  });
});

describe("cookies.txt handling", () => {
  const future = Math.floor(Date.now() / 1000) + 86400;
  const past = Math.floor(Date.now() / 1000) - 86400;
  const line = (d: string, name: string, value: string, exp = future, path = "/") => [d, "TRUE", path, "TRUE", exp, name, value].join("\t");
  const text = [
    "# Netscape HTTP Cookie File",
    "",
    "#HttpOnly_" + line(".google.com", "__Secure-1PSID", "fakepsid"),
    line(".google.com", "SAPISID", "fakesapisid"),
    line("accounts.google.com", "ACCOUNT_CHOOSER", "x"),
    line(".example.com", "other", "nope"),
    line(".google.com", "OLD", "expired", past),
    line(".google.com", "SESSION", "s", 0),
    "garbage line without tabs",
  ].join("\n");

  it("parses HttpOnly lines and skips comments/garbage", () => {
    const c = parseNetscapeCookies(text);
    expect(c.map((x) => x.name)).toContain("__Secure-1PSID");
    expect(c.find((x) => x.name === "__Secure-1PSID")!.domain).toBe(".google.com");
    expect(c.some((x) => x.value.includes("garbage"))).toBe(false);
  });

  it("only sends cookies a browser would send to www.google.com (domain + unexpired)", () => {
    const usable = cookiesForUrl(parseNetscapeCookies(text), LOCATION_SHARING_URL);
    const names = usable.map((x) => x.name).sort();
    expect(names).toEqual(["SAPISID", "SESSION", "__Secure-1PSID"]);
    expect(hasRequiredCookies(usable)).toBe(true);
    expect(buildCookieHeader(usable)).toContain("__Secure-1PSID=fakepsid");
  });

  it("detects missing required cookies", () => {
    const usable = cookiesForUrl(parseNetscapeCookies(line(".google.com", "NID", "x")), LOCATION_SHARING_URL);
    expect(hasRequiredCookies(usable)).toBe(false);
  });

  it("accepts __Secure-3PSID as the required cookie", () => {
    const usable = cookiesForUrl(parseNetscapeCookies(line(".google.com", "__Secure-3PSID", "x")), LOCATION_SHARING_URL);
    expect(hasRequiredCookies(usable)).toBe(true);
  });
});
