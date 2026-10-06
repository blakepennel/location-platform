# DEVELOPMENT

Everything runs locally. Real data and secrets live under `$LOCATION_PLATFORM_HOME`
(default `~/.location-platform`), never in the repo.

## Prerequisites

- Node ≥ 22.13 (developed on Node 24), Python 3.12, Git.
- `git submodule update --init --recursive` (pulls the pinned `timeline-sync/upstream`).
- `npm install`
- `cd timeline-sync && python -m venv .venv && .venv/Scripts/pip install -e .[dev]` (POSIX: `.venv/bin/pip`).

## Start / stop everything

```bash
npm run dev          # OAuth (:8700) + timeline-mcp (:8701) + live-location-mcp (:8702). Ctrl-C stops all.
# or: ./dev.sh   |   make dev
```

Individually:
```bash
npm run dev -w @location/mcp-auth                 # OAuth server only
npm run start -w timeline-mcp                      # historical MCP (HTTP)
npm run start -w live-location-mcp                 # live MCP (HTTP)
npm run daemon -w live-location-mcp                # live polling daemon (separate from the server)
```

Docker: everything (including headless Chromium with an optional web-viewable screen) can run in containers. See [DOCKER.md](DOCKER.md).

## Seed synthetic data (no Google)

```bash
npm run seed        # timeline-sync sync --source synthetic → index into timeline-mcp; live simulate
```

## Tests

```bash
npm test            # Node (shared 19, mcp-auth 27, timeline-mcp 60, live 93) + Python (92, 1 skipped)
npm run test:node   # Node only
npm run test:py     # Python only
npm run test:e2e    # end-to-end: OAuth + both servers + real MCP SDK client over HTTP
npm run typecheck
npm run leak-scan   # secret / real-coordinate scan (add --staged for pre-commit)
```

Optional pre-commit hook:
```bash
printf '#!/bin/sh\nnpm run precommit\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

## Health & freshness

```bash
curl localhost:8700/healthz    # OAuth server
curl localhost:8701/healthz    # timeline-mcp  (index_present, counts, ages — no coordinates)
curl localhost:8702/healthz    # live-location-mcp (authenticated, obs count, ages — no coordinates)

# richer freshness:
cd timeline-sync && .venv/Scripts/timeline-sync status
npm run status -w timeline-mcp
npm run -s -w live-location-mcp start >/dev/null 2>&1 &   # then call the location_status tool
```

## MCP endpoints (local)

| Server | Streamable HTTP | Protected-resource metadata | Scope |
|---|---|---|---|
| timeline-mcp | `http://localhost:8701/mcp` | `http://localhost:8701/.well-known/oauth-protected-resource/mcp` | `timeline:read` |
| live-location-mcp | `http://localhost:8702/mcp` | `http://localhost:8702/.well-known/oauth-protected-resource/mcp` | `location:read` |
| OAuth AS | discovery: `http://localhost:8700/.well-known/oauth-authorization-server` | — | — |

## The local OAuth login flow

1. `npm run dev` starts the AS with a single dev account (`DEV_AUTH_SUBJECT`, default
   `local-dev-user`) — no password; it is loopback-only.
2. An MCP client hitting `/mcp` gets a 401 with a `resource_metadata` challenge, discovers the
   AS, (dynamically registers), and opens the browser to `http://localhost:8700/auth` with PKCE.
3. You click **Sign in**, then **Allow** on the consent page listing the requested resource+scope.
4. The client exchanges the code (PKCE) for a JWT access token + refresh token and calls `/mcp`.

Full details and product-specific notes: [AUTH.md](AUTH.md).

## Connecting Claude

**Claude Code, local, stdio (simplest — no OAuth, local process trust):**
```bash
claude mcp add timeline -- node --disable-warning=ExperimentalWarning --import tsx /ABS/PATH/location-platform/timeline-mcp/src/cli.ts stdio
claude mcp add live     -- node --disable-warning=ExperimentalWarning --import tsx /ABS/PATH/location-platform/live-location-mcp/src/cli.ts stdio
```
If you launch from another working directory, `tsx` may not resolve; use the loader form:
```jsonc
{ "command": "node",
  "args": ["--disable-warning=ExperimentalWarning",
           "--import", "file:///ABS/PATH/location-platform/node_modules/tsx/dist/loader.mjs",
           "/ABS/PATH/location-platform/timeline-mcp/src/cli.ts", "stdio"] }
```

**Claude (remote / custom connector) over Streamable HTTP:** add a custom connector with URL
`http://localhost:8701/mcp` (or the live URL). Claude follows RFC 9728 → RFC 8414 discovery and
DCR and runs the OAuth flow above. (Remote connectors generally require a public HTTPS URL — see
tunneling below; localhost works for Claude Code's own HTTP client and the MCP Inspector.)

**MCP Inspector** (protocol debugging):
```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP; URL http://localhost:8701/mcp; it will run the OAuth flow.
```

## Connecting ChatGPT (later)

ChatGPT's MCP support requires a **public HTTPS** endpoint; it cannot reach localhost. Keep
OAuth enabled and expose via a temporary tunnel for testing:

```bash
# example with cloudflared (or ngrok); do NOT disable auth
cloudflared tunnel --url http://localhost:8701
```
Then set `TIMELINE_MCP_PUBLIC_URL` to the tunnel's https URL and restart the server so the
issued audience + protected-resource metadata match the public URL, and register the tunnel URL
as an allowed redirect/resource with your production IdP. **Do not** expose the servers publicly
without explicit intent — see [SECURITY.md](SECURITY.md). For production, switch
`MCP_AUTH_ISSUER` to a hosted IdP (Auth0/WorkOS/Keycloak/Entra) as described in [AUTH.md](AUTH.md).
`export const enableCimd` / `MCP_ALLOW_ANY_SUBJECT` remain off unless you deliberately change them.

## Going live with real Google data

These require **interactive** steps (Google blocks automated sign-in). See each project's README
for details; the order is:

### timeline-sync (historical)
```bash
cd timeline-sync
# 1. Browser sign-in at the embedded-setup URL (2FA and all), then:
.venv/Scripts/timeline-sync auth --email you@example.com --oauth-token-stdin     # paste the oauth_token
#    (Chrome 127+ app-bound cookie encryption often blocks --from-browser chrome; stdin is reliable.)
# 2. One-time decryption key retrieval (opens a real browser; answer the password re-auth):
.venv/Scripts/timeline-sync key --email you@example.com
# 3. Routine sync (refresh auth → fetch → decrypt → export → publish → freshness):
.venv/Scripts/timeline-sync sync            # add --enrich for place names/trips (needs Chromium or a Places API key)
# then index into the historical MCP:
cd .. && npm run index -w timeline-mcp
```

### live-location-mcp (live)
```
# On your iPhone (Google Maps): share your location INDEFINITELY with a DEDICATED recipient Google account.
# Sign in to that recipient account in a throwaway browser and export cookies.txt (Netscape format).
```
```bash
cp /path/to/cookies.txt ~/.location-platform/secrets/live/cookies.txt   # mode 600
chmod 600 ~/.location-platform/secrets/live/cookies.txt
npm run -w live-location-mcp start   # or: node ... src/cli.ts auth   (validates + one live fetch; prints sharer ids, never coordinates)
node --import tsx live-location-mcp/src/cli.ts daemon    # start polling
```

## Environment variables

See [.env.example](.env.example) for the complete list with defaults. Key ones:
`LOCATION_PLATFORM_HOME`, `MCP_AUTH_ISSUER`, `MCP_ALLOWED_SUBJECTS`, `TIMELINE_MAX_PRECISION`,
`LIVE_POLL_INTERVAL`, `LIVE_RETENTION_DAYS`, `LOG_LEVEL`, `LOG_LOCATION_DEBUG`.

## Bumping upstream Timeline

```bash
git -C timeline-sync/upstream fetch
git -C timeline-sync/upstream checkout <new-sha>
cd timeline-sync && .venv/Scripts/python -m pytest    # the shims assert upstream shape; tests fail loudly if it drifted
```
Rationale and the list of runtime shims: `timeline-sync/UPSTREAM.md`.
