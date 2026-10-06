# AUTH.md — MCP authorization

This document covers **Layer B**: the OAuth 2.1 authorization that MCP clients (Claude,
ChatGPT, MCP Inspector) use to reach the two MCP servers. For **Layer A** (Google Timeline /
Location Sharing credentials) see [SECURITY.md](SECURITY.md); the two never mix.

## Why this design

The MCP authorization spec makes each MCP server an **OAuth 2.1 protected resource**. We
implement exactly that, standards-only:

- **Authorization Code + PKCE (S256)** — required for every client, including public clients.
- **JWT access tokens (RFC 9068)** validated by signature (JWKS), issuer, expiry, **audience**
  (RFC 8707 resource indicators) and **scope**.
- **Protected Resource Metadata (RFC 9728)** + **Authorization Server Metadata (RFC 8414)** /
  OIDC discovery, so clients can bootstrap from a `/mcp` URL alone.
- **Dynamic Client Registration (RFC 7591)** so Claude/ChatGPT can self-register.
- **Refresh tokens with rotation** and **revocation (RFC 7009)**.
- A configurable **approved subject allowlist** on top of all of the above (single-user system).

We do not invent crypto or a username/password system. Signature/JWT work is done by
[`jose`](https://github.com/panva/jose); the authorization server is
[`oidc-provider`](https://github.com/panva/node-oidc-provider) — an OpenID Certified™
implementation.

## Why oidc-provider for local development

| Option | Verdict |
|---|---|
| **oidc-provider (chosen)** | Certified, supports PKCE + RFC 8707 resource indicators + DCR + refresh rotation + JWT access tokens out of the box; pure Node, no Docker, trivial to embed in tests; swappable for a real IdP because our servers only rely on standard discovery + JWT. |
| Keycloak | Fully featured and standards-based, but a heavyweight Java service requiring Docker; overkill for one user and slower to test. Documented as a production option. |
| Hand-rolled Node authorization server | Rejected — "do not invent crypto / bespoke auth". |
| Auth0 / WorkOS | Rejected for local dev (paid cloud, network dependency). Fine for **production** — see below. |

Because the resource servers are standards-based, **switching the IdP is a config change**
(`MCP_AUTH_ISSUER` + `MCP_ALLOWED_SUBJECTS`), not a code change.

## Resources, scopes, audiences

Two independent resources. A token for one is **not** valid for the other.

| Server | Resource (audience) | Scope |
|---|---|---|
| timeline-mcp | `http://localhost:8701/mcp` | `timeline:read` |
| live-location-mcp | `http://localhost:8702/mcp` | `location:read` |

The client sends `resource=<the /mcp URL>` (RFC 8707); the AS mints a JWT whose `aud` is that
URL and whose granted scope is that resource's scope. Each server verifies `aud == its own
resource` and rejects everything else. The dev AS can also **infer** the resource from the
requested scope when a client omits `resource`.

## Single-user enforcement

Beyond issuer/signature/expiry/audience/scope, each server checks the token `sub` against
`MCP_ALLOWED_SUBJECTS`. Any other authenticated identity is rejected (403). Your identity is
**not** hardcoded — it lives in env/config. With the local dev AS the subject is
`DEV_AUTH_SUBJECT` (default `local-dev-user`). With a real IdP, set `MCP_ALLOWED_SUBJECTS` to
your `sub` there. (`MCP_ALLOW_ANY_SUBJECT=true` disables this — not recommended.)

## The local login flow (what you see)

1. An MCP client is pointed at, e.g., `http://localhost:8701/mcp`.
2. Unauthenticated, the server returns **401** with
   `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`.
3. The client fetches that metadata → finds `authorization_servers: ["http://localhost:8700"]`.
4. The client fetches the AS metadata, (dynamically registers if needed), and opens a browser to
   the **/auth** endpoint with PKCE.
5. You see a **Sign in** page (dev account) then an **Authorize** page listing the requested
   resource + scope. Click **Allow**.
6. The AS redirects back with a code; the client exchanges it (with the PKCE verifier) for a
   JWT access token + refresh token.
7. The client retries `/mcp` with `Authorization: Bearer <token>` → **200**, MCP proceeds.

Refreshing happens automatically via the refresh token (rotated each use).

## Differences between Claude products and ChatGPT

- **Claude Code (stdio):** runs the server as a local subprocess — **no OAuth**; trust is the
  local OS process. Simplest for development. See [DEVELOPMENT.md](DEVELOPMENT.md).
- **Claude (remote/custom connector) & ChatGPT:** connect over **Streamable HTTP** and perform
  the full OAuth flow above. Both support discovery + DCR. Practical notes:
  - Claude's remote MCP connector follows RFC 9728 → RFC 8414 discovery and DCR.
  - ChatGPT requires an HTTPS, publicly reachable endpoint; localhost won't do. For testing,
    expose via a tunnel (keeping OAuth on) — see [DEVELOPMENT.md](DEVELOPMENT.md#exposing-for-chatgpt).
  - Some clients probe `/.well-known/oauth-protected-resource` at the origin root as well as the
    path-suffixed form; we serve both.
  - Newer clients may present a **Client ID Metadata Document** (an https client_id URL) instead
    of DCR; the dev AS supports this (`DEV_AUTH_ENABLE_CIMD=true`).

## Production migration

Point `MCP_AUTH_ISSUER` at your provider (Auth0/WorkOS/Keycloak/Entra), define two API
resources with audiences equal to the deployed `/mcp` URLs and the two scopes, set
`MCP_ALLOWED_SUBJECTS` to your provider `sub`, and (optionally) `MCP_AUTH_JWKS_URI`. No server
code changes are required.
