/**
 * Common Streamable HTTP host for both MCP servers.
 *
 *  - POST/GET/DELETE /mcp   MCP Streamable HTTP (stateless: fresh server+transport per request)
 *  - /.well-known/oauth-protected-resource[/mcp]  RFC 9728 metadata
 *  - GET /healthz            non-sensitive operational health only
 *
 * Every /mcp request must carry a valid OAuth access token for THIS resource (audience),
 * with the required scope, from the allowed subject. There is no unauthenticated mode for HTTP.
 *
 * MCP_AUTH_MODE=cloudflare-access instead delegates OAuth to Cloudflare Access (Managed OAuth)
 * in front of a Cloudflare Tunnel: every /mcp request must carry a valid Cf-Access-Jwt-Assertion
 * for an allowed email, and this server publishes no OAuth metadata of its own.
 */
import express, { type Request, type Response } from "express";
import type { Server as HttpServer } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  cloudflareAccessConfigFromEnv,
  createCloudflareAccessVerifier,
  createJwtVerifier,
  requireCloudflareAccess,
  type AccessAssertionVerifier,
  protectedResourceRouter,
  requireBearerAuth,
  type AccessTokenVerifier,
  type ResourceServerAuthConfig,
} from "@location/mcp-auth";
import type { Logger } from "./log.ts";

export interface McpHttpOptions {
  name: string;
  /** Public base URL, e.g. http://localhost:8701 — the resource is `${publicUrl}/mcp`. */
  publicUrl: string;
  auth: Omit<ResourceServerAuthConfig, "resource">;
  /** Or supply a verifier directly (tests). */
  verifier?: AccessTokenVerifier;
  /** "oauth" (default) or "cloudflare-access". Defaults to MCP_AUTH_MODE. */
  authMode?: "oauth" | "cloudflare-access";
  /** Cloudflare Access assertion verifier (tests); otherwise built from CF_ACCESS_* env. */
  accessVerifier?: AccessAssertionVerifier;
  buildServer: () => McpServer;
  health: () => Record<string, unknown>;
  logger: Logger;
  /** Extra Host header values to accept (DNS-rebinding protection). */
  allowedHosts?: string[];
  /** Per-subject request budget per minute. */
  rateLimitPerMinute?: number;
  documentationUrl?: string;
}

export function mcpResourceUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/mcp`;
}

export function createMcpHttpApp(opts: McpHttpOptions) {
  const resource = mcpResourceUrl(opts.publicUrl);
  const mode = opts.authMode ?? (process.env.MCP_AUTH_MODE === "cloudflare-access" ? "cloudflare-access" : "oauth");
  if (process.env.MCP_AUTH_MODE && !["oauth", "cloudflare-access"].includes(process.env.MCP_AUTH_MODE)) {
    throw new Error(`MCP_AUTH_MODE must be "oauth" or "cloudflare-access"`);
  }
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", process.env.MCP_TRUST_PROXY === "true");

  const publicHost = new URL(opts.publicUrl).host;
  const allowedHosts = new Set([publicHost, ...(opts.allowedHosts ?? [])]);
  const port = new URL(opts.publicUrl).port;
  for (const h of ["localhost", "127.0.0.1", "[::1]"]) allowedHosts.add(port ? `${h}:${port}` : h);

  // DNS-rebinding protection: only answer to known Host headers.
  app.use((req, res, next) => {
    const host = req.headers.host ?? "";
    if (!allowedHosts.has(host) && !(opts.allowedHosts ?? []).includes("*")) {
      res.status(421).json({ error: "misdirected_request" });
      return;
    }
    next();
  });

  // CORS for browser-based MCP clients (e.g. MCP Inspector). Tokens are bearer-only, no cookies.
  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID");
    res.set("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Cache-Control", "no-store");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", service: opts.name, ...opts.health() });
  });

  const onDecision = (d: { ok: boolean; kind?: string; status: number }) => {
    if (!d.ok) opts.logger.warn("auth.rejected", { reason: d.kind, status: d.status });
  };
  let auth: ReturnType<typeof requireBearerAuth>;
  if (mode === "cloudflare-access") {
    // Cloudflare serves the OAuth discovery/DCR/authorize/token endpoints at the edge.
    const accessVerifier = opts.accessVerifier ?? createCloudflareAccessVerifier(cloudflareAccessConfigFromEnv(), resource);
    auth = requireCloudflareAccess({ verifier: accessVerifier, onDecision });
  } else {
    const verifier = opts.verifier ?? createJwtVerifier({ ...opts.auth, resource });
    app.use(
      protectedResourceRouter({
        resource,
        authorizationServers: [opts.auth.issuer],
        scopesSupported: opts.auth.requiredScopes,
        resourceName: opts.name,
        documentationUrl: opts.documentationUrl,
      }),
    );
    auth = requireBearerAuth({ verifier, resource, requiredScopes: opts.auth.requiredScopes, onDecision });
  }

  // Simple fixed-window per-subject rate limit (defence against bulk extraction).
  const budget = opts.rateLimitPerMinute ?? 120;
  const windows = new Map<string, { start: number; count: number }>();
  const rateLimit = (req: Request, res: Response, next: () => void) => {
    const key = String((req.auth?.extra as any)?.sub ?? req.auth?.clientId ?? req.ip);
    const now = Date.now();
    const w = windows.get(key);
    if (!w || now - w.start > 60_000) windows.set(key, { start: now, count: 1 });
    else if (++w.count > budget) {
      res.set("Retry-After", "60");
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    next();
  };

  const handle = async (req: Request, res: Response) => {
    const server = opts.buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req as any, res as any, req.body);
    } catch (e) {
      opts.logger.error("mcp.request_failed", { error: e as Error });
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
    }
  };

  app.post("/mcp", auth, rateLimit, express.json({ limit: "256kb" }), handle);
  // Stateless server: no standalone SSE stream or sessions to delete.
  const notAllowed = (_req: Request, res: Response) => {
    res.set("Allow", "POST");
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  };
  app.get("/mcp", auth, notAllowed);
  app.delete("/mcp", auth, notAllowed);

  return { app, resource };
}

/** Listen on loopback only (IPv4 + IPv6) unless MCP_BIND_HOST overrides. */
export async function listenLoopback(app: express.Express, port: number, host = process.env.MCP_BIND_HOST): Promise<HttpServer[]> {
  const hosts = host ? [host] : ["127.0.0.1", "::1"];
  const servers: HttpServer[] = [];
  for (const h of hosts) {
    try {
      const s = await new Promise<HttpServer>((resolve, reject) => {
        const srv = app.listen(port, h, () => resolve(srv));
        srv.once("error", reject);
      });
      servers.push(s);
    } catch (e) {
      if (h === "::1" && servers.length) continue; // no IPv6 loopback — fine
      throw e;
    }
  }
  return servers;
}
