# location-platform

A private, single-user platform that puts your Google location data behind Model Context
Protocol (MCP) servers you can use from Claude and ChatGPT — **without merging** two very
different kinds of truth:

- **Historical Timeline** — Google's *semantic* reconstruction (visits, activities, trips,
  Place IDs). Sourced from your encrypted Timeline cloud backup. **Not real-time** (the phone
  backs it up hours to a day late).
- **Live Location** — recent *point observations* from Google Maps Location Sharing, for
  "where am I now?" and recent movement.

These are **two independent SQLite stores and two independent MCP servers**. An LLM connects to
both and picks the right tool; nothing is ever reconciled into one database.

```
timeline-sync (Python)  ──▶  current/Timeline.json  ──▶  timeline-mcp (TS, read-only)  ──▶  Claude / ChatGPT
   Geller direct cloud                                     historical tools               (OAuth 2.1)

Google Maps Location Sharing  ──▶  live poller  ──▶  live.sqlite  ──▶  live-location-mcp (TS, read-only)  ──▶  Claude / ChatGPT
                                                                        live tools               (OAuth 2.1)
```

> **Personal project, unofficial APIs.** This reads *your own* data using undocumented Google
> endpoints (the Timeline cloud backup via [arkenoi/timeline-export](https://github.com/arkenoi/timeline-export),
> included as a git submodule under its own license, and Maps Location Sharing). Google can change
> or block them at any time, and using them may conflict with Google's Terms of Service. It is
> not affiliated with or endorsed by Google. Use it only for accounts you own, at your own risk.

See **[ARCHITECTURE.md](ARCHITECTURE.md)** (diagrams), **[SECURITY.md](SECURITY.md)**,
**[THREAT_MODEL.md](THREAT_MODEL.md)**, **[AUTH.md](AUTH.md)**, and
**[DEVELOPMENT.md](DEVELOPMENT.md)**, and **[DOCKER.md](DOCKER.md)** to run it all in containers.

## Layout

```
location-platform/
├── timeline-sync/        # PROJECT 1 — Python wrapper over arkenoi/timeline-export (pinned submodule)
├── timeline-mcp/         # PROJECT 2 — historical MCP server (TypeScript, read-only, 13 tools)
├── live-location-mcp/    # PROJECT 3 — live MCP server (TypeScript, read-only, 5 tools)
├── mcp-auth/             # OAuth 2.1 verifier + middleware + local dev authorization server
├── shared/               # logging/redaction, time/geo utils, sqlite, common OAuth HTTP host
├── schemas/              # export contract, sync-status JSON schema, response conventions
├── tools/                # dev orchestrator, e2e harness, seed, leak scanner
├── Dockerfile · docker-compose.yml · docker/   # run everything in Docker (see DOCKER.md)
├── dev.sh · Makefile     # convenience wrappers
└── .env.example          # copy to .env
```

## Requirements

- **Node ≥ 22.13** (uses the built-in `node:sqlite`; developed on Node 24) and **Python 3.12**.
- No database server, no Docker required. Docker Compose is optional.
- Windows/macOS/Linux for the apps. The upstream Timeline **redroid** path is Linux-only and is
  **not** used — this platform uses the direct Geller cloud path.

## Quick start (all synthetic — no Google needed)

```bash
# 0. clone with the pinned upstream submodule
git submodule update --init --recursive

# 1. install
npm install
cd timeline-sync && python -m venv .venv && .venv/Scripts/pip install -e .[dev] && cd ..   # (POSIX: .venv/bin/pip)

# 2. configure
cp .env.example .env        # defaults work for local dev

# 3. seed synthetic data + run everything
npm run seed                # synthetic Timeline + live observations
npm run dev                 # starts OAuth + both MCP servers on :8700/:8701/:8702
```

Then point an MCP client at `http://localhost:8701/mcp` (historical) or
`http://localhost:8702/mcp` (live); it will discover the OAuth server and open a browser
sign-in. For local Claude Code, use stdio (no OAuth) — see [DEVELOPMENT.md](DEVELOPMENT.md).

## Tests

```bash
npm test          # 199 Node tests + 92 Python tests
npm run test:e2e  # full stack: OAuth + both MCP servers + real MCP client, end to end
npm run leak-scan # secret / real-coordinate scan
```

## The two authentication layers

- **Layer A (Google, server-side only):** the Timeline master token + decryption key, and the
  Location-Sharing recipient-account cookies. Stored as files under
  `$LOCATION_PLATFORM_HOME/secrets`, mode 600, **never** given to any MCP client.
- **Layer B (MCP OAuth, client-facing):** Claude/ChatGPT receive **only** a short-lived OAuth
  token for the specific MCP resource. See [AUTH.md](AUTH.md).

## What is real vs. synthetic

Everything in this repository and every automated test uses **synthetic** coordinates and
places. Real location data and all secrets live **outside** the checkout under
`$LOCATION_PLATFORM_HOME` (default `~/.location-platform`). Connecting to the real Google
services requires interactive steps documented in [DEVELOPMENT.md](DEVELOPMENT.md) (Google
sign-in, a one-time key retrieval, and Location-Sharing setup from your iPhone).
