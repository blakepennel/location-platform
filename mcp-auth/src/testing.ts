/**
 * Test-only helpers: an in-process token issuer with a real asymmetric key pair so tests
 * exercise genuine signature verification (never a "skip verification" flag).
 */
import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWK } from "jose";
import { randomUUID } from "node:crypto";

export interface MintOptions {
  sub?: string;
  aud?: string | string[];
  scope?: string;
  iss?: string;
  expiresInSec?: number;
  /** absolute exp (epoch seconds) — for expired-token tests */
  exp?: number;
  clientId?: string;
  /** sign with a different (untrusted) key */
  foreignKey?: boolean;
}

export async function createTestIssuer(issuer = "http://issuer.test") {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const foreign = await generateKeyPair("RS256", { extractable: true });
  const kid = "test-key-1";
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  const jwks = { keys: [jwk] };

  async function mint(o: MintOptions = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT({ scope: o.scope ?? "", client_id: o.clientId ?? "test-client" })
      .setProtectedHeader({ alg: "RS256", kid, typ: "at+jwt" })
      .setIssuer(o.iss ?? issuer)
      .setSubject(o.sub ?? "test-user")
      .setIssuedAt(now)
      .setJti(randomUUID())
      .setExpirationTime(o.exp ?? now + (o.expiresInSec ?? 300));
    if (o.aud !== undefined) jwt.setAudience(o.aud);
    return jwt.sign(o.foreignKey ? foreign.privateKey : privateKey);
  }

  /** Serve discovery + JWKS over HTTP so the verifier's discovery path is exercised. */
  async function listen(port = 0): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
    let base = "";
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/.well-known/oauth-authorization-server" || req.url === "/.well-known/openid-configuration") {
        res.end(JSON.stringify({ issuer: base, jwks_uri: `${base}/jwks` }));
      } else if (req.url === "/jwks") {
        res.end(JSON.stringify(jwks));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`;
    return { url: base, server, close: () => new Promise((r) => server.close(() => r())) };
  }

  return { issuer, jwks, keySet: createLocalJWKSet(jwks), mint, listen };
}
