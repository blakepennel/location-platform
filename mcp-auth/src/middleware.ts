/**
 * Express middleware + metadata routes that make an MCP server an OAuth 2.1 protected
 * resource per the MCP authorization spec:
 *  - 401 + `WWW-Authenticate: Bearer resource_metadata="..."` (RFC 9728 §5.1, RFC 6750)
 *  - 403 insufficient_scope with the required `scope`
 *  - /.well-known/oauth-protected-resource[/<path>] metadata (RFC 9728)
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { AuthFailure, type AccessTokenVerifier } from "./verifier.ts";

export interface ProtectedResourceOptions {
  /** Canonical resource URL (the MCP endpoint), e.g. http://localhost:8701/mcp */
  resource: string;
  authorizationServers: string[];
  scopesSupported: string[];
  resourceName: string;
  documentationUrl?: string;
}

/** RFC 9728: metadata URL is the resource URL with /.well-known/oauth-protected-resource inserted before the path. */
export function protectedResourceMetadataUrl(resource: string): string {
  const u = new URL(resource);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return `${u.origin}/.well-known/oauth-protected-resource${path}`;
}

export function protectedResourceMetadata(opts: ProtectedResourceOptions): Record<string, unknown> {
  return {
    resource: opts.resource,
    authorization_servers: opts.authorizationServers,
    scopes_supported: opts.scopesSupported,
    bearer_methods_supported: ["header"],
    resource_name: opts.resourceName,
    ...(opts.documentationUrl ? { resource_documentation: opts.documentationUrl } : {}),
  };
}

export function protectedResourceRouter(opts: ProtectedResourceOptions): Router {
  const router = express.Router();
  const doc = protectedResourceMetadata(opts);
  const path = new URL(protectedResourceMetadataUrl(opts.resource)).pathname;
  const handler = (_req: Request, res: Response) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "max-age=300");
    res.json(doc);
  };
  // Path-suffixed form (spec) + bare form (older clients probe the root).
  router.get(path, handler);
  if (path !== "/.well-known/oauth-protected-resource") router.get("/.well-known/oauth-protected-resource", handler);
  return router;
}

export interface RequireAuthOptions {
  verifier: AccessTokenVerifier;
  resource: string;
  requiredScopes: string[];
  /** Called on every decision; must never receive the token itself. */
  onDecision?: (d: { ok: boolean; kind?: string; clientId?: string; status: number }) => void;
}

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthInfo;
  }
}

function quote(s: string): string {
  return s.replace(/["\\]/g, "");
}

export function requireBearerAuth(opts: RequireAuthOptions) {
  const metadataUrl = protectedResourceMetadataUrl(opts.resource);
  const scope = opts.requiredScopes.join(" ");

  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const challenge = (error?: string, description?: string) => {
      const parts = [`Bearer resource_metadata="${metadataUrl}"`, `scope="${scope}"`];
      if (error) parts.push(`error="${error}"`);
      if (description) parts.push(`error_description="${quote(description)}"`);
      return parts.join(", ");
    };

    if (!header) {
      // RFC 6750 §3.1: no error code when the request simply lacks credentials.
      res.set("WWW-Authenticate", challenge());
      opts.onDecision?.({ ok: false, kind: "missing_token", status: 401 });
      res.status(401).json({ error: "invalid_token", error_description: "authorization required" });
      return;
    }
    const m = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)\s*$/i.exec(header);
    if (!m) {
      res.set("WWW-Authenticate", challenge("invalid_request", "malformed Authorization header"));
      opts.onDecision?.({ ok: false, kind: "invalid_request", status: 400 });
      res.status(400).json({ error: "invalid_request", error_description: "malformed Authorization header" });
      return;
    }
    try {
      const info = await opts.verifier.verifyAccessToken(m[1]);
      req.auth = info;
      opts.onDecision?.({ ok: true, clientId: info.clientId, status: 200 });
      next();
    } catch (e) {
      const f = e instanceof AuthFailure ? e : new AuthFailure("invalid_token", "token could not be verified");
      const code = f.kind === "forbidden_subject" ? "insufficient_scope" : f.kind;
      res.set("WWW-Authenticate", challenge(code, f.message));
      opts.onDecision?.({ ok: false, kind: f.kind, status: f.status });
      res.status(f.status).json({ error: f.kind === "forbidden_subject" ? "access_denied" : f.kind, error_description: f.message });
    }
  };
}
