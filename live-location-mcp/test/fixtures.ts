/** Synthetic Location Sharing responses matching the documented index layout. No real data. */
export interface FakePerson {
  id: string;
  lat: number;
  lng: number;
  ts: number;
  acc?: number;
  address?: string | null;
  country?: string | null;
  battery?: [boolean, number] | null;
  name?: string | null;
  fallbackName?: string;
  nickname?: string;
  noLocation?: boolean;
}

export function fakePerson(p: FakePerson): unknown[] {
  const arr: unknown[] = new Array(14).fill(null);
  arr[0] = [null, null, null, p.name === undefined ? "Synthetic Person" : p.name];
  arr[1] = p.noLocation
    ? null
    : [null, [null, p.lng, p.lat], p.ts, p.acc ?? 12, p.address === undefined ? "1 Fake Street" : p.address, null, p.country === undefined ? null : p.country];
  arr[6] = [p.id, "https://example.invalid/photo.png", p.fallbackName ?? "Fallback Name", p.nickname ?? null];
  arr[13] = p.battery === undefined ? [false, 77] : p.battery;
  return arr;
}

const XSSI = ")]}'";

export function fakeResponse(people: FakePerson[] | null, opts: { own?: boolean } = {}): string {
  const output: unknown[] = new Array(10).fill(null);
  output[0] = people === null ? null : people.map(fakePerson);
  if (opts.own) output[9] = [null, [null, [null, 20.9, 10.9], 1]];
  return XSSI + "\n" + JSON.stringify(output);
}

export const UNAUTH_RESPONSE = XSSI + "\n" + JSON.stringify([null, null, null, null, null, null, "GgA=", null, null, null]);
export const HTML_RESPONSE = "<!doctype html><html><body>Sign in - Google Accounts</body></html>";
export { XSSI };

export const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
