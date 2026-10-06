import { describe, expect, it, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { createJwtVerifier, AuthFailure, requireBearerAuth, protectedResourceRouter, protectedResourceMetadataUrl } from "../src/index.ts";
import { createTestIssuer } from "../src/testing.ts";

const RESOURCE = "http://localhost:8701/mcp";
const OTHER_RESOURCE = "http://localhost:8702/mcp";

let issuer: Awaited<ReturnType<typeof createTestIssuer>>;
beforeAll(async () => {
  issuer = await createTestIssuer("http://issuer.test");
});

function verifier(extra: Partial<Parameters<typeof createJwtVerifier>[0]> = {}) {
  return createJwtVerifier({
    issuer: "http://issuer.test",
    resource: RESOURCE,
    requiredScopes: ["timeline:read"],
    allowedSubjects: ["owner"],
    jwks: issuer.keySet,
    ...extra,
  });
}

async function failure(p: Promise<unknown>): Promise<AuthFailure> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AuthFailure);
    return e as AuthFailure;
  }
  throw new Error("expected failure");
}

describe("createJwtVerifier", () => {
  it("accepts a correct token", async () => {
    const t = await issuer.mint({ sub: "owner", aud: RESOURCE, scope: "timeline:read" });
    const info = await verifier().verifyAccessToken(t);
    expect(info.scopes).toContain("timeline:read");
    expect((info.extra as any).sub).toBe("owner");
    expect(info.resource?.href).toBe(RESOURCE);
  });

  it("rejects an expired token", async () => {
    const t = await issuer.mint({ sub: "owner", aud: RESOURCE, scope: "timeline:read", exp: Math.floor(Date.now() / 1000) - 3600 });
    const f = await failure(verifier().verifyAccessToken(t));
    expect(f.kind).toBe("invalid_token");
    expect(f.message).toMatch(/expired/);
  });

  it("rejects a token for another resource (wrong audience)", async () => {
    const t = await issuer.mint({ sub: "owner", aud: OTHER_RESOURCE, scope: "timeline:read" });
    const f = await failure(verifier().verifyAccessToken(t));
    expect(f.kind).toBe("invalid_token");
    expect(f.message).toMatch(/audience/);
  });

  it("rejects a token with no audience", async () => {
    const t = await issuer.mint({ sub: "owner", scope: "timeline:read" });
    expect((await failure(verifier().verifyAccessToken(t))).kind).toBe("invalid_token");
  });

  it("rejects a token with the wrong scope", async () => {
    const t = await issuer.mint({ sub: "owner", aud: RESOURCE, scope: "location:read" });
    const f = await failure(verifier().verifyAccessToken(t));
    expect(f.kind).toBe("insufficient_scope");
    expect(f.status).toBe(403);
  });

  it("rejects a valid token for a non-approved subject", async () => {
    const t = await issuer.mint({ sub: "someone-else", aud: RESOURCE, scope: "timeline:read" });
    const f = await failure(verifier().verifyAccessToken(t));
    expect(f.kind).toBe("forbidden_subject");
    expect(f.status).toBe(403);
  });

  it("rejects a token signed by an untrusted key", async () => {
    const t = await issuer.mint({ sub: "owner", aud: RESOURCE, scope: "timeline:read", foreignKey: true });
    expect((await failure(verifier().verifyAccessToken(t))).kind).toBe("invalid_token");
  });

  it("rejects a token from another issuer", async () => {
    const t = await issuer.mint({ sub: "owner", aud: RESOURCE, scope: "timeline:read", iss: "http://evil.test" });
    const f = await failure(verifier().verifyAccessToken(t));
    expect(f.message).toMatch(/issuer/);
  });

  it("rejects garbage and alg=none tokens", async () => {
    expect((await failure(verifier().verifyAccessToken("not-a-jwt"))).kind).toBe("invalid_token");
    const none = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url") + "." +
      Buffer.from(JSON.stringify({ sub: "owner", aud: RESOURCE, iss: "http://issuer.test", scope: "timeline:read", exp: 9999999999 })).toString("base64url") + ".";
    expect((await failure(verifier().verifyAccessToken(none))).kind).toBe("invalid_token");
  });

  it("supports the scp claim form", async () => {
    const t = await issuer.mint({ sub: "owner", aud: RESOURCE, scope: "timeline:read" });
    await expect(verifier().verifyAccessToken(t)).resolves.toBeTruthy();
  });

  it("refuses to construct without an allowed subject unless explicitly disabled", () => {
    expect(() => verifier({ allowedSubjects: [] })).toThrow(/allowed OAuth subject/);
    expect(() => verifier({ allowedSubjects: [], allowAnySubject: true })).not.toThrow();
  });

  it("discovers the JWKS from issuer metadata over HTTP", async () => {
    const srv = await issuer.listen();
    try {
      const v = createJwtVerifier({ issuer: srv.url, resource: RESOURCE, requiredScopes: ["timeline:read"], allowedSubjects: ["owner"] });
      const t = await issuer.mint({ iss: srv.url, sub: "owner", aud: RESOURCE, scope: "timeline:read" });
      await expect(v.verifyAccessToken(t)).resolves.toBeTruthy();
    } finally {
      await srv.close();
    }
  });
});

describe("requireBearerAuth middleware", () => {
  let base = "";
  let server: import("node:http").Server;
  beforeAll(async () => {
    const app = express();
    app.use(protectedResourceRouter({ resource: RESOURCE, authorizationServers: ["http://issuer.test"], scopesSupported: ["timeline:read"], resourceName: "t" }));
    app.post("/mcp", requireBearerAuth({ verifier: verifier(), resource: RESOURCE, requiredScopes: ["timeline:read"] }), (req, res) => {
      res.json({ ok: true, client: req.auth?.clientId });
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("401 with resource_metadata challenge when no token", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST" });
    expect(r.status).toBe(401);
    const h = r.headers.get("www-authenticate")!;
    expect(h).toContain(`resource_metadata="${protectedResourceMetadataUrl(RESOURCE)}"`);
    expect(h).toContain('scope="timeline:read"');
    expect(h).not.toContain("error=");
  });

  it("401 invalid_token for an expired token, 403 for wrong scope/subject", async () => {
    const expired = await issuer.mint({ sub: "owner", aud: RESOURCE, scope: "timeline:read", exp: 1000 });
    let r = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${expired}` } });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain('error="invalid_token"');

    const scope = await issuer.mint({ sub: "owner", aud: RESOURCE, scope: "location:read" });
    r = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${scope}` } });
    expect(r.status).toBe(403);
    expect(r.headers.get("www-authenticate")).toContain('error="insufficient_scope"');

    const sub = await issuer.mint({ sub: "intruder", aud: RESOURCE, scope: "timeline:read" });
    r = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${sub}` } });
    expect(r.status).toBe(403);
  });

  it("400 for a malformed Authorization header", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Basic abc" } });
    expect(r.status).toBe(400);
  });

  it("passes a valid token through", async () => {
    const t = await issuer.mint({ sub: "owner", aud: RESOURCE, scope: "timeline:read", clientId: "c1" });
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${t}` } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, client: "c1" });
  });

  it("serves RFC 9728 metadata at the path-suffixed and root locations", async () => {
    for (const p of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const r = await fetch(base + p);
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.resource).toBe(RESOURCE);
      expect(j.authorization_servers).toEqual(["http://issuer.test"]);
    }
  });
});
