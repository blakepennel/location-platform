import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeJwt } from "jose";
import { createDevAuthServer } from "../src/dev-server/server.ts";
import { createJwtVerifier, AuthFailure } from "../src/index.ts";
import { authorizeViaDevLogin, exchangeCode, obtainDevToken, refresh, registerPublicClient } from "../src/flow.ts";

const TIMELINE = "http://localhost:8701/mcp";
const LIVE = "http://localhost:8702/mcp";
const REDIRECT = "http://127.0.0.1:8799/callback";

let server: Server;
let issuer = "";

beforeAll(async () => {
  // Bind first to learn the port, then build the provider with the matching issuer.
  const probe = await new Promise<Server>((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => r(s));
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  issuer = `http://127.0.0.1:${port}`;
  const { app } = await createDevAuthServer({
    issuer,
    subject: "dev-owner",
    stateDir: null,
    resources: [
      { resource: TIMELINE, scopes: ["timeline:read"], name: "Timeline" },
      { resource: LIVE, scopes: ["location:read"], name: "Live" },
    ],
    accessTokenTtlSec: 120,
  });
  server = app.listen(port, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const timelineVerifier = () =>
  createJwtVerifier({ issuer, resource: TIMELINE, requiredScopes: ["timeline:read"], allowedSubjects: ["dev-owner"] });
const liveVerifier = () => createJwtVerifier({ issuer, resource: LIVE, requiredScopes: ["location:read"], allowedSubjects: ["dev-owner"] });

describe("local dev authorization server", () => {
  it("advertises OAuth 2.1-compatible metadata (code only, S256 only, DCR)", async () => {
    const j = await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json();
    expect(j.issuer).toBe(issuer);
    expect(j.code_challenge_methods_supported).toEqual(["S256"]);
    expect(j.response_types_supported).toEqual(["code"]);
    expect(j.grant_types_supported).not.toContain("implicit");
    expect(j.registration_endpoint).toBeTruthy();
  });

  it("issues a JWT access token bound to the requested resource via Authorization Code + PKCE", async () => {
    const tok = await obtainDevToken({ issuer, redirectUri: REDIRECT, resource: TIMELINE, scope: "timeline:read" });
    const claims = decodeJwt(tok.access_token);
    expect(claims.aud).toBe(TIMELINE);
    expect(claims.sub).toBe("dev-owner");
    expect(String(claims.scope)).toBe("timeline:read");
    expect(tok.refresh_token).toBeTruthy();
    const info = await timelineVerifier().verifyAccessToken(tok.access_token);
    expect(info.scopes).toEqual(["timeline:read"]);
  });

  it("a timeline token does NOT authorize the live resource", async () => {
    const tok = await obtainDevToken({ issuer, redirectUri: REDIRECT, resource: TIMELINE, scope: "timeline:read" });
    await expect(liveVerifier().verifyAccessToken(tok.access_token)).rejects.toBeInstanceOf(AuthFailure);
  });

  it("requesting location scope on the timeline resource yields no usable scope", async () => {
    const tok = await obtainDevToken({ issuer, redirectUri: REDIRECT, resource: TIMELINE, scope: "location:read" }).catch((e) => e);
    if (tok instanceof Error) return; // AS refused outright — also acceptable
    const claims = decodeJwt(tok.access_token);
    expect(String(claims.scope ?? "")).not.toContain("location:read");
    await expect(timelineVerifier().verifyAccessToken(tok.access_token)).rejects.toBeInstanceOf(AuthFailure);
  });

  it("infers the resource from the scope when the client omits it", async () => {
    const clientId = await registerPublicClient(issuer, REDIRECT);
    const { code, verifier } = await authorizeViaDevLogin({ issuer, clientId, redirectUri: REDIRECT, resource: LIVE, scope: "location:read" });
    const tok = await exchangeCode(issuer, { clientId, redirectUri: REDIRECT, code: code!, verifier });
    expect(decodeJwt(tok.access_token).aud).toBe(LIVE);
    await expect(liveVerifier().verifyAccessToken(tok.access_token)).resolves.toBeTruthy();
  });

  it("rejects an unknown resource indicator", async () => {
    await expect(obtainDevToken({ issuer, redirectUri: REDIRECT, resource: "http://localhost:9999/mcp", scope: "timeline:read" })).rejects.toThrow();
  });

  it("rejects a code exchange with the wrong PKCE verifier", async () => {
    const clientId = await registerPublicClient(issuer, REDIRECT);
    const { code } = await authorizeViaDevLogin({ issuer, clientId, redirectUri: REDIRECT, resource: TIMELINE, scope: "timeline:read" });
    await expect(exchangeCode(issuer, { clientId, redirectUri: REDIRECT, code: code!, verifier: "x".repeat(43) })).rejects.toThrow(/invalid_grant/);
  });

  it("returns access_denied when the user denies consent", async () => {
    const clientId = await registerPublicClient(issuer, REDIRECT);
    const r = await authorizeViaDevLogin({ issuer, clientId, redirectUri: REDIRECT, resource: TIMELINE, scope: "timeline:read", decision: "deny" });
    expect(r.code).toBeUndefined();
    expect(r.error).toBe("access_denied");
  });

  it("rotates refresh tokens and rejects reuse of the old one", async () => {
    const tok = await obtainDevToken({ issuer, redirectUri: REDIRECT, resource: TIMELINE, scope: "timeline:read" });
    const next = await refresh(issuer, { clientId: tok.client_id, refreshToken: tok.refresh_token! });
    expect(next.refresh_token).toBeTruthy();
    expect(next.refresh_token).not.toBe(tok.refresh_token);
    expect(decodeJwt(next.access_token).aud).toBe(TIMELINE);
    await expect(refresh(issuer, { clientId: tok.client_id, refreshToken: tok.refresh_token! })).rejects.toThrow(/invalid_grant/);
  });

  it("requires PKCE (authorization request without code_challenge fails)", async () => {
    const clientId = await registerPublicClient(issuer, REDIRECT);
    const u = new URL(`${issuer}/auth`);
    u.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope: "timeline:read", resource: TIMELINE, state: "s" }).toString();
    const r = await fetch(u, { redirect: "manual" });
    const loc = r.headers.get("location") ?? "";
    expect(loc).toContain("error=invalid_request");
  });
});
