/**
 * Resource-server side access-token verification for the MCP servers.
 *
 * Standards only: RFC 9068 (JWT access tokens), RFC 8707 (resource indicators → `aud`),
 * RFC 8414 / OIDC discovery (to find the JWKS). No bespoke crypto — signature checks are
 * done by `jose`. The IdP is swappable: anything that issues signed JWT access tokens with
 * an `aud` equal to our resource URL and a `scope`/`scp` claim works (oidc-provider,
 * Keycloak, Auth0, WorkOS, Entra, ...).
 */
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export interface ResourceServerAuthConfig {
  /** Expected `iss` claim, e.g. http://localhost:8700 */
  issuer: string;
  /** Canonical resource URL of this MCP server, e.g. http://localhost:8701/mcp. Must equal the token `aud`. */
  resource: string;
  /** Scopes that every request needs, e.g. ["timeline:read"]. */
  requiredScopes: string[];
  /** Explicit allowlist of OAuth `sub` values. Empty only if allowAnySubject is true. */
  allowedSubjects: string[];
  /** Must be explicitly set to disable the single-user subject check. */
  allowAnySubject?: boolean;
  /** Override JWKS URI; otherwise discovered from the issuer's metadata. */
  jwksUri?: string;
  /** Injected key resolver (tests). */
  jwks?: JWTVerifyGetKey;
  /** Seconds of allowed clock skew. */
  clockToleranceSec?: number;
  /** Allowed JWS algorithms (asymmetric only). */
  algorithms?: string[];
}

export type AuthFailureKind = "invalid_token" | "insufficient_scope" | "forbidden_subject";

export class AuthFailure extends Error {
  constructor(public kind: AuthFailureKind, message: string) {
    super(message);
  }
  get status(): number {
    return this.kind === "invalid_token" ? 401 : 403;
  }
}

const DEFAULT_ALGS = ["RS256", "PS256", "ES256", "EdDSA"];

export function assertConfigSafe(cfg: ResourceServerAuthConfig): void {
  if (!cfg.issuer) throw new Error("auth config: issuer is required");
  if (!cfg.resource) throw new Error("auth config: resource is required");
  if (!cfg.requiredScopes?.length) throw new Error("auth config: at least one required scope is required");
  if (!cfg.allowAnySubject && !cfg.allowedSubjects?.length) {
    throw new Error(
      "auth config: no allowed OAuth subject configured. Set MCP_ALLOWED_SUBJECTS to your IdP user id " +
        "(or MCP_ALLOW_ANY_SUBJECT=true to deliberately disable the single-user check).",
    );
  }
}

async function discoverJwksUri(issuer: string): Promise<string> {
  const base = issuer.replace(/\/$/, "");
  const candidates = [`${base}/.well-known/oauth-authorization-server`, `${base}/.well-known/openid-configuration`];
  let lastErr: unknown;
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) continue;
      const doc = (await res.json()) as { issuer?: string; jwks_uri?: string };
      if (doc.issuer && doc.issuer.replace(/\/$/, "") !== base) {
        throw new Error(`issuer mismatch in ${url}`);
      }
      if (doc.jwks_uri) return doc.jwks_uri;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`could not discover jwks_uri for issuer ${issuer}: ${String(lastErr ?? "no metadata")}`);
}

export function scopesOf(payload: JWTPayload): string[] {
  const s = (payload as Record<string, unknown>).scope;
  const scp = (payload as Record<string, unknown>).scp;
  if (typeof s === "string") return s.split(" ").filter(Boolean);
  if (Array.isArray(scp)) return scp.filter((x): x is string => typeof x === "string");
  if (typeof scp === "string") return scp.split(" ").filter(Boolean);
  return [];
}

export interface AccessTokenVerifier {
  verifyAccessToken(token: string): Promise<AuthInfo>;
}

export function createJwtVerifier(cfg: ResourceServerAuthConfig): AccessTokenVerifier {
  assertConfigSafe(cfg);
  let keyResolver: JWTVerifyGetKey | undefined = cfg.jwks;
  let resolving: Promise<JWTVerifyGetKey> | undefined;

  async function keys(): Promise<JWTVerifyGetKey> {
    if (keyResolver) return keyResolver;
    resolving ??= (async () => {
      const uri = cfg.jwksUri ?? (await discoverJwksUri(cfg.issuer));
      keyResolver = createRemoteJWKSet(new URL(uri), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
      return keyResolver;
    })().catch((e) => {
      resolving = undefined; // retry discovery on the next request
      throw e;
    });
    return resolving;
  }

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        const res = await jwtVerify(token, await keys(), {
          issuer: cfg.issuer,
          audience: cfg.resource,
          algorithms: cfg.algorithms ?? DEFAULT_ALGS,
          clockTolerance: cfg.clockToleranceSec ?? 30,
          requiredClaims: ["exp", "sub", "iss", "aud"],
        });
        payload = res.payload;
      } catch (e) {
        // Deliberately coarse messages: never echo token contents back.
        if (e instanceof joseErrors.JWTExpired) throw new AuthFailure("invalid_token", "token expired");
        if (e instanceof joseErrors.JWTClaimValidationFailed) {
          const claim = e.claim;
          if (claim === "aud") throw new AuthFailure("invalid_token", "token audience does not match this resource");
          if (claim === "iss") throw new AuthFailure("invalid_token", "token issuer not trusted");
          throw new AuthFailure("invalid_token", `token claim check failed (${claim})`);
        }
        if (e instanceof joseErrors.JOSEError) throw new AuthFailure("invalid_token", "token signature or format invalid");
        if (e instanceof AuthFailure) throw e;
        throw new AuthFailure("invalid_token", "token could not be verified");
      }

      const scopes = scopesOf(payload);
      const missing = cfg.requiredScopes.filter((s) => !scopes.includes(s));
      if (missing.length) throw new AuthFailure("insufficient_scope", `missing required scope: ${missing.join(" ")}`);

      const sub = String(payload.sub ?? "");
      if (!cfg.allowAnySubject && !cfg.allowedSubjects.includes(sub)) {
        throw new AuthFailure("forbidden_subject", "authenticated identity is not permitted on this server");
      }

      const clientId =
        (typeof payload.client_id === "string" && payload.client_id) ||
        (typeof payload.azp === "string" && payload.azp) ||
        "unknown";

      return {
        token,
        clientId,
        scopes,
        expiresAt: payload.exp,
        resource: new URL(cfg.resource),
        extra: { sub },
      };
    },
  };
}
