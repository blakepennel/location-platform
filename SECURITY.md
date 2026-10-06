# SECURITY

This system handles two of the most sensitive data classes a person owns: **long-term
location history** and **live location**. It is designed for a single trusted user on a
single trusted machine. Security is built around four principles:

1. **Secrets and real location data live outside the git checkout.**
2. **Two independent Google credential sets, never handed to MCP clients.**
3. **Every remote MCP request is OAuth-authenticated, scoped, audience-bound, and pinned to one approved identity.**
4. **Logs never contain secrets and — by default — never contain precise coordinates.**

See [THREAT_MODEL.md](THREAT_MODEL.md) for the adversary analysis.

## Where everything lives

Nothing sensitive is stored in the repository. All runtime state is under
`$LOCATION_PLATFORM_HOME` (default `~/.location-platform`), created with `700` permissions:

```
~/.location-platform/
├── secrets/
│   ├── timeline/         # Google master token, key.b64, android_id, account.json   (mode 600)
│   ├── live/             # cookies.txt for the dedicated recipient Google account    (mode 600)
│   └── dev-auth/         # local OAuth signing keys (jwks.private.json), clients      (mode 600)
├── timeline/             # timeline-sync output: current/Timeline.json, exports/, raw odlh db, state/
├── timeline-mcp/         # historical index DB (derived; still real data)
└── live-location/        # live.sqlite (raw observations; real data)
```

On Windows, secret files/dirs are locked down with
`icacls <path> /inheritance:r /grant:r "%USERNAME%:F"`; on POSIX with `chmod 600/700`.

## The two authentication layers (never confused)

| | Layer A — Google (server-side only) | Layer B — MCP OAuth (client-facing) |
|---|---|---|
| Purpose | Fetch Timeline backup; read Location Sharing | Authorize Claude/ChatGPT to call the MCP servers |
| Credentials | Google master token, Timeline AES key, recipient-account cookies | OAuth access/refresh tokens for *our* resource |
| Stored | Files under `secrets/`, mode 600 | Client-side only; never persisted by us beyond the IdP |
| Ever sent to an MCP client? | **Never** | Yes — that is all the client ever receives |

An MCP client (Claude, ChatGPT) receives **only** a Layer-B token for our resource. It never
sees any Google credential. Google credentials never leave the host.

## What counts as a secret (never printed, logged, committed, or returned in MCP responses)

- Google master token (`aas_et/…`), OAuth `oauth_token` cookie (`oauth2_4/…`), bearer tokens (`ya29.…`)
- The Timeline decryption key (`key.b64`, decrypts your entire history)
- Google session cookies for the recipient account (`__Secure-1PSID`, `SAPISID`, …)
- OAuth access/refresh tokens and the dev IdP's private signing key
- Browser authentication artifacts / profiles

Claude/agents must not read or display these files' contents. The wrapper tools read them
into memory only when needed, never echo them, and write only booleans (“present/absent”)
into status files.

## Logging

Structured JSON to stderr. A redaction filter (`shared/src/log.ts`) scrubs anything shaped
like a token, JWT, Google cookie, or `Authorization` header, and — unless
`LOG_LOCATION_DEBUG=true` — anything shaped like a coordinate pair, plus keys named
`lat/lng/address/point/...`. Location-bearing debug output only appears through the explicit
`log.location()` channel gated on that flag.

## MCP transport authorization

- Streamable HTTP `/mcp` endpoints require a valid OAuth 2.1 access token (RFC 9068 JWT) with:
  issuer match, signature (JWKS), expiry, **audience == this server's resource URL** (RFC 8707),
  the required **scope** (`timeline:read` vs `location:read`), and an **approved subject**
  (`MCP_ALLOWED_SUBJECTS`). A token for one server is rejected by the other.
- 401 responses carry `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728) so clients
  can discover the authorization server. There is **no unauthenticated HTTP mode.**
- Servers bind to loopback by default, apply DNS-rebinding (Host header) protection, set
  `Cache-Control: no-store`, and rate-limit per subject to bound bulk extraction.
- stdio transport is for local single-process use (Claude Code on the same machine) and
  relies on OS process trust, not OAuth. Do not expose stdio remotely.

## Exposure

The servers are **not** publicly reachable by default. Exposing them (e.g. via a tunnel for
ChatGPT) requires the user's explicit action and must keep OAuth enabled. See
[AUTH.md](AUTH.md) and [DEVELOPMENT.md](DEVELOPMENT.md).

## Leak prevention

- Broad `.gitignore` for tokens, cookies, keys, `*.db`, `Timeline*.json`, browser profiles, `.env`.
- `tools/leak-scan.mjs` (also usable as a pre-commit hook: `npm run precommit`) scans staged
  content for credential- and real-coordinate-shaped strings and an optional private denylist
  (`.private-denylist`, git-ignored) of your real town/street/device names.
- Synthetic coordinates (lat 10–13 / lng 20–23) and `FAKE`-labelled tokens are used in all tests.

## Reporting / rotation

- Revoke a leaked Google master token at <https://myaccount.google.com/device-activity>.
- Re-export recipient-account cookies (and consider signing that account out everywhere) if `cookies.txt` leaks.
- Rotate the dev IdP key by deleting `secrets/dev-auth/jwks.private.json` (clients re-auth).
