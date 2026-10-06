/**
 * Local development OAuth 2.1 Authorization Server for the MCP servers.
 *
 * Built on `oidc-provider` (panva) — an OpenID Certified™ implementation — so we do not
 * implement any protocol or crypto ourselves. Enabled standards:
 *   - Authorization Code + PKCE (S256 only, required for every client)
 *   - RFC 8707 Resource Indicators → JWT access tokens (RFC 9068) whose `aud` is the MCP resource
 *   - RFC 7591 Dynamic Client Registration (how Claude / ChatGPT / MCP Inspector register)
 *   - Client ID Metadata Documents (draft; newer MCP clients) — optional
 *   - Refresh tokens with rotation, revocation (RFC 7009), introspection (RFC 7662)
 *   - RFC 8414 + OIDC discovery
 *
 * Login is a single configured local dev account (no passwords — this server is bound to
 * loopback and exists only so the flow can be exercised in a browser). Production swaps this
 * whole process for a real IdP (Auth0, WorkOS, Keycloak, ...) without touching the MCP servers.
 */
import express, { type Request, type Response } from "express";
import Provider, { errors, type Configuration, type KoaContextWithOIDC } from "oidc-provider";
import { exportJWK, generateKeyPair } from "jose";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFileAdapterFactory } from "./file-adapter.ts";

export interface ResourceDef {
  /** canonical resource indicator = MCP endpoint URL */
  resource: string;
  scopes: string[];
  name: string;
}

export interface DevAuthOptions {
  issuer: string;
  /** Subject (user id) of the single dev account. */
  subject: string;
  displayName?: string;
  resources: ResourceDef[];
  /** Directory for dev keys + persisted clients/grants. null = in-memory (tests). */
  stateDir: string | null;
  accessTokenTtlSec?: number;
  refreshTokenTtlSec?: number;
  enableCimd?: boolean;
  /** Pre-registered public client for local scripts/tests. */
  devClient?: { clientId: string; redirectUris: string[] };
  trustProxy?: boolean;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#1b1b1b;background:#fafafa}
.card{background:#fff;border:1px solid #ddd;border-radius:10px;padding:24px}
h1{font-size:1.25rem;margin-top:0} code{background:#f0f0f0;padding:1px 5px;border-radius:4px}
button{font-size:1rem;padding:10px 18px;border-radius:8px;border:1px solid #888;background:#fff;cursor:pointer;margin-right:8px}
button.primary{background:#1a56db;color:#fff;border-color:#1a56db} .muted{color:#666;font-size:.9rem}
ul{padding-left:20px}
</style></head><body><div class="card">${body}</div>
<p class="muted">location-platform local development authorization server — not for production.</p></body></html>`;
}

async function loadOrCreateKeys(stateDir: string | null) {
  const file = stateDir ? join(stateDir, "jwks.private.json") : null;
  if (file && existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(privateKey)), kid: `dev-${Date.now()}`, alg: "RS256", use: "sig" };
  const keys = { keys: [jwk], cookieKeys: [randomBytes(32).toString("base64url")] };
  if (file) {
    mkdirSync(stateDir!, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  }
  return keys;
}

const norm = (u: string) => u.replace(/\/+$/, "");

export async function createDevAuthServer(opts: DevAuthOptions) {
  const log = opts.log ?? (() => {});
  const keys = await loadOrCreateKeys(opts.stateDir);
  const byResource = new Map(opts.resources.map((r) => [norm(r.resource), r]));
  const resourceScopes = [...new Set(opts.resources.flatMap((r) => r.scopes))];
  const accessTtl = opts.accessTokenTtlSec ?? 600;

  const Adapter = createFileAdapterFactory(opts.stateDir ? join(opts.stateDir, "oidc-store.json") : null);

  const configuration: Configuration = {
    adapter: Adapter as any,
    clients: opts.devClient
      ? [
          {
            client_id: opts.devClient.clientId,
            client_name: "location-platform dev CLI",
            token_endpoint_auth_method: "none",
            redirect_uris: opts.devClient.redirectUris,
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
          },
        ]
      : [],
    async findAccount(_ctx, id) {
      if (id !== opts.subject) return undefined;
      return { accountId: id, async claims() { return { sub: id, name: opts.displayName ?? "Local Dev User" }; } };
    },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    scopes: ["openid", "offline_access", ...resourceScopes],
    claims: { openid: ["sub"] },
    responseTypes: ["code"],
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true },
      revocation: { enabled: true },
      introspection: { enabled: true },
      userinfo: { enabled: false },
      resourceIndicators: {
        enabled: true,
        // Clients that omit `resource`: infer it from the (resource-specific) scope requested.
        defaultResource(ctx: KoaContextWithOIDC, _client: unknown, oneOf?: readonly string[]) {
          if (oneOf?.length) return oneOf.length === 1 ? oneOf[0] : undefined;
          const requested = String((ctx.oidc.params as any)?.scope ?? "").split(" ");
          const matches = opts.resources.filter((r) => r.scopes.some((s) => requested.includes(s)));
          return matches.length === 1 ? matches[0].resource : undefined;
        },
        getResourceServerInfo(_ctx: KoaContextWithOIDC, indicator: string) {
          const r = byResource.get(norm(indicator));
          if (!r) throw new errors.InvalidTarget(`unknown resource indicator`);
          return {
            scope: r.scopes.join(" "),
            audience: r.resource,
            accessTokenTTL: accessTtl,
            accessTokenFormat: "jwt",
            jwt: { sign: { alg: "RS256" } },
          };
        },
        useGrantedResource: () => true,
      },
      ...(opts.enableCimd
        ? {
            clientIdMetadataDocument: {
              enabled: true,
              ack: "draft-02",
              allowFetch: (_ctx: KoaContextWithOIDC, clientId: string) => clientId.startsWith("https://"),
            },
          }
        : {}),
    } as any,
    pkce: { required: () => true },
    ttl: {
      AccessToken: accessTtl,
      AuthorizationCode: 60,
      IdToken: 600,
      Interaction: 600,
      Session: 8 * 3600,
      Grant: opts.refreshTokenTtlSec ?? 14 * 86400,
      RefreshToken: opts.refreshTokenTtlSec ?? 14 * 86400,
    },
    rotateRefreshToken: true,
    async issueRefreshToken(_ctx, client) {
      return client.grantTypeAllowed("refresh_token");
    },
    async expiresWithSession() {
      return false;
    },
    jwks: { keys: keys.keys },
    cookies: { keys: keys.cookieKeys },
    clientBasedCORS: () => true,
    async renderError(ctx, out) {
      ctx.type = "html";
      ctx.body = page("Authorization error", `<h1>Authorization error</h1><p><code>${esc(out.error)}</code></p><p>${esc(out.error_description)}</p>`);
    },
  };

  const provider = new Provider(opts.issuer, configuration);
  if (opts.trustProxy) provider.proxy = true;
  provider.on("server_error", (_ctx, err) => log("auth.server_error", { message: err.message }));
  provider.on("grant.success", (ctx) => log("auth.token_issued", { client_id: ctx.oidc.client?.clientId }));
  provider.on("grant.error", (_ctx, err) => log("auth.token_error", { error: (err as any).error ?? err.message }));
  provider.on("registration_create.success", (_ctx, client) => log("auth.client_registered", { client_id: client.clientId, client_name: (client as any).clientName }));

  const app = express();
  app.disable("x-powered-by");
  const providerCallback = provider.callback();
  const form = express.urlencoded({ extended: false });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", service: "mcp-dev-auth", issuer: opts.issuer });
  });

  // RFC 8414 alias: MCP clients probe this before OIDC discovery.
  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    req.url = "/.well-known/openid-configuration";
    providerCallback(req, res);
  });

  app.get("/interaction/:uid", async (req: Request, res: Response) => {
    try {
      const details = await provider.interactionDetails(req, res);
      const client = await provider.Client.find(String(details.params.client_id));
      const clientName = client?.clientName || details.params.client_id;
      const uid = esc(details.uid);
      if (details.prompt.name === "login") {
        res.type("html").send(
          page("Sign in", `<h1>Sign in to location-platform (dev)</h1>
<p><b>${esc(clientName)}</b> wants to access your location MCP server.</p>
<p>Local development account: <code>${esc(opts.subject)}</code></p>
<form method="post" action="/interaction/${uid}/login">
<button class="primary" type="submit" name="login" value="1">Sign in as dev user</button>
<a href="/interaction/${uid}/abort">Cancel</a></form>`),
        );
        return;
      }
      const rs = (details.prompt.details as any).missingResourceScopes ?? {};
      const oidcScopes: string[] = (details.prompt.details as any).missingOIDCScope ?? [];
      const items = Object.entries(rs)
        .map(([res, scopes]) => `<li><code>${esc((scopes as string[]).join(" "))}</code> on <b>${esc(byResource.get(norm(res))?.name ?? res)}</b><br><span class="muted">${esc(res)}</span></li>`)
        .join("");
      res.type("html").send(
        page("Authorize", `<h1>Authorize ${esc(clientName)}</h1>
<p>This client is requesting:</p><ul>${items || "<li>(no resource scopes)</li>"}${oidcScopes.length ? `<li>identity: <code>${esc(oidcScopes.join(" "))}</code></li>` : ""}</ul>
<p class="muted">Read-only access. Google credentials are never shared with the client.</p>
<form method="post" action="/interaction/${uid}/confirm">
<button class="primary" type="submit">Allow</button>
<a href="/interaction/${uid}/abort">Deny</a></form>`),
      );
    } catch (e) {
      res.status(400).type("html").send(page("Error", `<h1>Session expired</h1><p>Restart the sign-in from your MCP client.</p>`));
    }
  });

  app.post("/interaction/:uid/login", form, async (req, res) => {
    try {
      const details = await provider.interactionDetails(req, res);
      if (details.prompt.name !== "login") throw new Error("unexpected prompt");
      log("auth.login", { client_id: details.params.client_id });
      await provider.interactionFinished(req, res, { login: { accountId: opts.subject } }, { mergeWithLastSubmission: false });
    } catch (e) {
      res.status(400).type("html").send(page("Error", `<h1>Sign-in failed</h1>`));
    }
  });

  app.post("/interaction/:uid/confirm", form, async (req, res) => {
    try {
      const details = await provider.interactionDetails(req, res);
      if (details.prompt.name !== "consent") throw new Error("unexpected prompt");
      const { params, session } = details;
      const pd = details.prompt.details as any;
      let grant = details.grantId
        ? await provider.Grant.find(details.grantId)
        : new provider.Grant({ accountId: session!.accountId, clientId: String(params.client_id) });
      if (!grant) throw new Error("grant not found");
      if (pd.missingOIDCScope) grant.addOIDCScope(pd.missingOIDCScope.join(" "));
      if (pd.missingOIDCClaims) grant.addOIDCClaims(pd.missingOIDCClaims);
      if (pd.missingResourceScopes) {
        for (const [indicator, scopes] of Object.entries(pd.missingResourceScopes)) {
          grant.addResourceScope(indicator, (scopes as string[]).join(" "));
        }
      }
      const grantId = await grant.save();
      log("auth.consent", { client_id: params.client_id });
      await provider.interactionFinished(req, res, { consent: details.grantId ? {} : { grantId } }, { mergeWithLastSubmission: true });
    } catch (e) {
      res.status(400).type("html").send(page("Error", `<h1>Consent failed</h1>`));
    }
  });

  app.get("/interaction/:uid/abort", async (req, res) => {
    try {
      await provider.interactionFinished(req, res, { error: "access_denied", error_description: "user denied access" }, { mergeWithLastSubmission: false });
    } catch {
      res.status(400).type("html").send(page("Error", `<h1>Session expired</h1>`));
    }
  });

  app.use(providerCallback);
  return { app, provider };
}
