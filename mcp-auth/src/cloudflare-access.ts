/**
 * Cloudflare Access mode (MCP_AUTH_MODE=cloudflare-access).
 *
 * The MCP servers sit behind a Cloudflare Tunnel whose hostnames are protected by an Access
 * application with Managed OAuth enabled. Cloudflare is then the OAuth authorization server:
 * MCP clients (ChatGPT, Claude) discover it, register via DCR, send the user through the Access
 * login, and present opaque Access tokens at the edge. The origin never sees those tokens;
 * for every admitted request Cloudflare forwards a signed `Cf-Access-Jwt-Assertion`.
 *
 * This module verifies that assertion (defence in depth: the origin must not trust that
 * traffic came through Access just because it arrived): signature against the team's
 * JWKS, issuer = team domain, audience = the Access application's AUD tag, and an explicit
 * email allowlist.
 */
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { NextFunction, Request, Response } from "express";
import { envList } from "./config.ts";
import { AuthFailure } from "./verifier.ts";

export const CF_ACCESS_HEADER = "cf-access-jwt-assertion";

export interface CloudflareAccessConfig {
  /** e.g. https://myteam.cloudflareaccess.com (the JWT issuer) */
  teamDomain: string;
  /** Access application AUD tag(s). */
  audiences: string[];
  /** Lower-cased emails allowed to use the server. */
  allowedEmails: string[];
  /** Injected key resolver (tests). */
  jwks?: JWTVerifyGetKey;
  clockToleranceSec?: number;
}

export function normalizeTeamDomain(v: string): string {
  const t = v.trim().replace(/\/+$/, "");
  if (!t) return "";
  return /^https?:\/\//.test(t) ? t : `https://${t.includes(".") ? t : `${t}.cloudflareaccess.com`}`;
}

export function cloudflareAccessConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CloudflareAccessConfig {
  return {
    teamDomain: normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN ?? ""),
    audiences: envList(env.CF_ACCESS_AUD),
    allowedEmails: envList(env.MCP_ALLOWED_EMAILS).map((e) => e.toLowerCase()),
  };
}

export function assertCloudflareConfigSafe(cfg: CloudflareAccessConfig): void {
  if (!cfg.teamDomain.startsWith("https://")) throw new Error("cloudflare-access: CF_ACCESS_TEAM_DOMAIN must be set (https://<team>.cloudflareaccess.com)");
  if (!cfg.audiences.length) throw new Error("cloudflare-access: CF_ACCESS_AUD must be set to the Access application's AUD tag");
  if (!cfg.allowedEmails.length) throw new Error("cloudflare-access: MCP_ALLOWED_EMAILS must list the email(s) allowed to use this server");
}

export interface AccessAssertionVerifier {
  verifyAssertion(jwt: string): Promise<AuthInfo>;
}

export function createCloudflareAccessVerifier(cfg: CloudflareAccessConfig, resource: string): AccessAssertionVerifier {
  assertCloudflareConfigSafe(cfg);
  const keys = cfg.jwks ?? createRemoteJWKSet(new URL(`${cfg.teamDomain}/cdn-cgi/access/certs`), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
  return {
    async verifyAssertion(jwt: string): Promise<AuthInfo> {
      let payload;
      try {
        ({ payload } = await jwtVerify(jwt, keys, {
          issuer: cfg.teamDomain,
          audience: cfg.audiences,
          algorithms: ["RS256"],
          clockTolerance: cfg.clockToleranceSec ?? 30,
          requiredClaims: ["exp", "iss", "aud"],
        }));
      } catch (e) {
        if (e instanceof joseErrors.JWTExpired) throw new AuthFailure("invalid_token", "access assertion expired");
        if (e instanceof joseErrors.JWTClaimValidationFailed) throw new AuthFailure("invalid_token", `access assertion claim check failed (${e.claim})`);
        throw new AuthFailure("invalid_token", "access assertion signature or format invalid");
      }
      const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
      if (!email || !cfg.allowedEmails.includes(email)) {
        throw new AuthFailure("forbidden_subject", "authenticated identity is not permitted on this server");
      }
      return {
        token: "cf-access", // never keep the assertion itself
        clientId: "cloudflare-access",
        scopes: [],
        expiresAt: payload.exp,
        resource: new URL(resource),
        extra: { sub: email },
      };
    },
  };
}

/** Express middleware: admit only requests carrying a valid Access assertion for an allowed email. */
export function requireCloudflareAccess(opts: {
  verifier: AccessAssertionVerifier;
  onDecision?: (d: { ok: boolean; kind?: string; status: number }) => void;
}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const jwt = req.headers[CF_ACCESS_HEADER];
    if (typeof jwt !== "string" || !jwt) {
      opts.onDecision?.({ ok: false, kind: "missing_access_assertion", status: 401 });
      res.status(401).json({ error: "unauthorized", error_description: "request did not come through Cloudflare Access" });
      return;
    }
    try {
      req.auth = await opts.verifier.verifyAssertion(jwt);
      opts.onDecision?.({ ok: true, status: 200 });
      next();
    } catch (e) {
      const f = e instanceof AuthFailure ? e : new AuthFailure("invalid_token", "access assertion could not be verified");
      opts.onDecision?.({ ok: false, kind: f.kind, status: f.status });
      res.status(f.status).json({ error: f.kind === "forbidden_subject" ? "access_denied" : "unauthorized", error_description: f.message });
    }
  };
}
