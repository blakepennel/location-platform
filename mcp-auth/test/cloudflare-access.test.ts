import { describe, expect, it } from "vitest";
import express from "express";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  cloudflareAccessConfigFromEnv,
  createCloudflareAccessVerifier,
  normalizeTeamDomain,
  requireCloudflareAccess,
} from "../src/cloudflare-access.ts";

const TEAM = "https://fake-team.cloudflareaccess.com";
const AUD = "FAKE-aud-tag-0000";
const RESOURCE = "https://timeline.example.test/mcp";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>, o: { iss?: string; aud?: string; exp?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(o.iss ?? TEAM)
      .setAudience(o.aud ?? AUD)
      .setIssuedAt()
      .setExpirationTime(o.exp ?? "5m")
      .sign(privateKey);
  const verifier = createCloudflareAccessVerifier({ teamDomain: TEAM, audiences: [AUD], allowedEmails: ["me@example.test"], jwks }, RESOURCE);
  return { sign, verifier };
}

async function call(mw: express.RequestHandler, headers: Record<string, string>) {
  const app = express();
  app.post("/mcp", mw, (req, res) => res.json({ sub: (req.auth?.extra as any)?.sub }));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const port = (srv.address() as any).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers });
    return { status: r.status, body: await r.json() };
  } finally {
    srv.close();
  }
}

describe("cloudflare access mode", () => {
  it("admits a valid assertion for an allowed email (case-insensitive)", async () => {
    const { sign, verifier } = await setup();
    const r = await call(requireCloudflareAccess({ verifier }), { "cf-access-jwt-assertion": await sign({ email: "Me@Example.test" }) });
    expect(r.status).toBe(200);
    expect(r.body.sub).toBe("me@example.test");
  });

  it("rejects requests without the assertion header (bypassed the tunnel)", async () => {
    const { verifier } = await setup();
    const r = await call(requireCloudflareAccess({ verifier }), { authorization: "Bearer oauth:FAKE" });
    expect(r.status).toBe(401);
  });

  it("rejects wrong audience, wrong issuer, expired and forged assertions", async () => {
    const { sign, verifier } = await setup();
    const mw = requireCloudflareAccess({ verifier });
    expect((await call(mw, { "cf-access-jwt-assertion": await sign({ email: "me@example.test" }, { aud: "other-app" }) })).status).toBe(401);
    expect((await call(mw, { "cf-access-jwt-assertion": await sign({ email: "me@example.test" }, { iss: "https://evil.cloudflareaccess.com" }) })).status).toBe(401);
    expect((await call(mw, { "cf-access-jwt-assertion": await sign({ email: "me@example.test" }, { exp: "-10m" }) })).status).toBe(401);
    const other = await setup(); // signed by a key not in our JWKS
    expect((await call(mw, { "cf-access-jwt-assertion": await other.sign({ email: "me@example.test" }) })).status).toBe(401);
  });

  it("rejects an authenticated identity that is not allowlisted", async () => {
    const { sign, verifier } = await setup();
    const r = await call(requireCloudflareAccess({ verifier }), { "cf-access-jwt-assertion": await sign({ email: "someone@example.test" }) });
    expect(r.status).toBe(403);
  });

  it("refuses to start without team domain, AUD or allowlist", () => {
    expect(() => createCloudflareAccessVerifier(cloudflareAccessConfigFromEnv({}), RESOURCE)).toThrow(/CF_ACCESS_TEAM_DOMAIN/);
    expect(() => createCloudflareAccessVerifier(cloudflareAccessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: "fake-team" }), RESOURCE)).toThrow(/CF_ACCESS_AUD/);
    expect(() =>
      createCloudflareAccessVerifier(cloudflareAccessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: "fake-team", CF_ACCESS_AUD: AUD }), RESOURCE),
    ).toThrow(/MCP_ALLOWED_EMAILS/);
  });

  it("normalizes team domain forms", () => {
    expect(normalizeTeamDomain("fake-team")).toBe(TEAM);
    expect(normalizeTeamDomain("fake-team.cloudflareaccess.com/")).toBe(TEAM);
    expect(normalizeTeamDomain(TEAM)).toBe(TEAM);
  });
});
