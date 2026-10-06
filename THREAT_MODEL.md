# THREAT MODEL

Scope: a single-user, single-host deployment of location-platform (timeline-sync,
timeline-mcp, live-location-mcp, and a local OAuth server), initially loopback-only.

## Assets

- **A1** Google master token (long-lived account credential, Layer A).
- **A2** Timeline decryption key (`key.b64`) — decrypts the entire historical Timeline.
- **A3** Recipient-account Google session cookies (Layer A, live location).
- **A4** OAuth access tokens for the MCP resources (Layer B, short-lived).
- **A5** OAuth refresh tokens (Layer B, longer-lived).
- **A6** The location data itself: historical Timeline index DB and live observations DB.
- **A7** The dev IdP signing key.

## Trust boundaries

1. Host process memory / filesystem (trusted) ↔ the network.
2. Layer A (Google credentials, server-side) ↔ Layer B (MCP OAuth, client-facing). Credentials never cross this line.
3. MCP client (Claude/ChatGPT — semi-trusted; may be driven by untrusted content) ↔ MCP server.
4. Google's private APIs (external, unstable) ↔ our adapters.

## Threats and mitigations

### T1 — Leaked Google master token (A1)
*Impact:* attacker can mint webhistory-scoped bearers and pull your Timeline.
*Mitigations:* stored file mode 600 under `secrets/`, outside the repo; never logged/printed/returned;
held in memory only during a token exchange; `.gitignore` + leak-scan. *Residual:* possession of
the host file = compromise. *Response:* revoke at myaccount.google.com/device-activity; the key (A2)
alone cannot be used without a bearer.

### T2 — Leaked Timeline encryption key (A2)
*Impact:* with captured ciphertext (or a bearer), attacker can decrypt history.
*Mitigations:* mode 600, outside repo, never logged; separate from A1 so one leak is insufficient
to fetch *and* decrypt. *Residual:* domain-wide, stable key — rotate only when Google rotates it.
*Response:* re-enrollment / key rotation via Google.

### T3 — Stolen OAuth access token (A4)
*Impact:* read access to one MCP server until expiry.
*Mitigations:* short TTL (~10 min); audience-bound (usable on only one server); scope-bound;
subject-pinned; loopback + rate-limited; `no-store`. *Residual:* ≤ TTL window on one resource, read-only.

### T4 — Stolen OAuth refresh token (A5)
*Impact:* attacker can mint new access tokens.
*Mitigations:* refresh-token **rotation** (reuse of a rotated token is detected and the grant
revoked); bound to the (public, PKCE) client; stored only client-side. *Response:* revoke the grant
at the IdP / delete dev-auth state; subject allowlist still blocks other identities.

### T5 — Compromised live-location recipient account (A3)
*Impact:* attacker sees your live location shares; can read the same feed the daemon reads.
*Mitigations:* a **dedicated** account is the recipient, not your primary — blast radius is limited
to live sharing, not your email/primary identity; cookies mode 600, outside repo, never logged;
distinct from all Layer-B secrets. *Residual:* live location exposure. *Response:* stop sharing from
the primary account; sign the recipient out everywhere; re-export cookies.

### T6 — Public MCP endpoint discovery
*Impact:* someone finds the `/mcp` URL.
*Mitigations:* no unauthenticated mode — discovery yields only RFC 9728 metadata and 401s;
every call needs a valid, scoped, audience+subject-bound token; loopback by default; Host-header
(DNS-rebinding) protection; health endpoint exposes no location data. Exposure requires explicit
user action (tunnel) and keeps auth on.

### T7 — Malicious / confused MCP client (driven by untrusted content)
*Impact:* a client tricked by prompt-injection tries to exfiltrate location data.
*Mitigations:* servers are **read-only** (no write/delete/SQL/file tools); subject allowlist means a
different user's token is refused; scope separation; per-subject rate limiting; result limits +
default `semantic`/`approximate` precision cap so a single call cannot dump exact coordinates en masse.
*Residual:* an authorized client can still read data it is entitled to — this is an application-level,
not transport-level, concern.

### T8 — Excessive MCP result extraction (bulk scraping)
*Mitigations:* every list tool has a bounded `limit` (with `truncated`/`total_available`); no
"dump entire DB" endpoint; no raw GPS path points unless explicitly requested and then downsampled;
precision defaults to semantic/approximate; per-subject per-minute rate limit; max time-range guards.

### T9 — Log leakage (A1–A6)
*Mitigations:* central redaction filter scrubs token/JWT/cookie/Authorization shapes and coordinate
shapes; coordinate logging only via `log.location()` gated on `LOG_LOCATION_DEBUG`; status files store
booleans, not secret values; tests assert redaction.

### T10 — Dependency compromise (supply chain)
*Impact:* a malicious package could read `secrets/` or exfiltrate data.
*Mitigations:* lockfile-pinned deps; small, well-known dependency set (jose, oidc-provider, MCP SDK,
express, zod); Node built-in SQLite (no native build); `npm audit` in CI; upstream Timeline code pinned
as a submodule at a reviewed commit and never auto-updated. *Residual:* transitive trust in these
packages. *Recommended next:* `npm ci --ignore-scripts` in CI, Dependabot/renovate with review, and
optionally running the servers under an OS account without access to unrelated secrets.

### T11 — Google private API changes (availability)
*Impact:* Geller/Location-Sharing shapes change; fetch or parse breaks.
*Mitigations:* Google access is isolated behind `HistoricalLocationSource` / `LiveLocationSource`
adapters — the MCP/query layers are unaffected; parsers fail closed (raise, don't emit garbage);
timeline-sync retains the last-known-good export on any failure; live poller backs off and marks
`auth_state`/staleness rather than crashing. *Residual:* data staleness until an adapter fix; this is a
reverse-engineered private interface with no stability guarantee.

## Explicitly out of scope (initial single-host design)

Multi-tenant isolation; a hardened public deployment; full-disk encryption of the host;
protecting against a local root attacker; defending the user's own browser used for Google sign-in.
These become relevant only if the deployment model changes (see the "Next step" guidance in README).
