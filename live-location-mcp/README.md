# live-location-mcp

An MCP server for **recent / live location** from Google Maps **Location Sharing**. It is a separate
project from the historical Timeline server: it has its own SQLite database, its own poller, and never
reads or writes the Timeline index.

What you get are raw **point observations**: a coordinate, the time Google says the fix was taken, an
accuracy radius, and (sometimes) battery. The server never infers "visited place X" — for that use the
historical Timeline server.

```
Google Location Sharing  --(cookies, HTTPS GET, poll ~60 s)-->  poller/daemon  -->  live.sqlite
                                                                                      |
                              Claude (stdio or OAuth-protected HTTP)  <--  MCP tools  <
```

## How Location Sharing works here

Google Maps lets a person share their real-time location with another Google account. This project
reads that share as the *recipient*:

1. Create a **dedicated Google account** that exists only to receive the share (do not use your main
   account). Have the person whose location you want (you, from your phone) share their location with
   it in Google Maps: *profile picture -> Location sharing -> New share -> pick the account -> "Until
   you turn this off"*.
2. Sign in to that recipient account in a browser and export its cookies to a Netscape `cookies.txt`.
3. The daemon calls the (undocumented) web endpoint `https://www.google.com/maps/rpc/locationsharing/read`
   with those cookies, parses the nested-array response, and stores each *new* fix.

There is no official API. This is reverse-engineered and can break without notice (see "Brittleness").

### cookies.txt setup (human steps)

1. In a private/incognito browser window, sign in to the **recipient** account at
   `https://www.google.com/maps`. Confirm you can see the sharer's face/location.
2. Export cookies for `google.com` in Netscape format using a cookies.txt export extension (for
   example "Get cookies.txt LOCALLY"). Export only while on `google.com`.
3. Save the file to `~/.location-platform/secrets/live/cookies.txt` (or set `LIVE_COOKIES_FILE`), and
   restrict it: on macOS/Linux `chmod 600 cookies.txt`; on Windows keep it in your user profile
   (default ACLs are user-only).
4. **Close the incognito window without signing out** (signing out invalidates the session cookies).
5. Verify: `live-location auth`. It makes one live request and prints `authenticated: true` plus the
   opaque **sharer ids** it can see (never coordinates). If more than one person shares with the
   account, set `LIVE_SHARER_ID` to one of the ids.
6. Start polling: `live-location daemon`.

Cookies expire or get revoked (password change, Google security checks, long inactivity). When that
happens `location_status` reports `auth_state: "expired"`, the daemon backs off (it does not hammer
Google), and you re-export the cookies (steps 1-4) or run `live-location login` — no restart is
needed, the next poll picks up the new file. The layers below make this rare.

## Session keepalive (three layers)

Google's session cookies rotate; a static export eventually dies. The daemon keeps the dedicated
recipient account signed in on its own, following the prior art of HanaokaYuzu/Gemini-API
(`rotate_1psidts`) and notebooklm-py's layered keepalive:

1. **L1 cookie write-back** (`src/cookie-jar.ts`). Every Google response's `Set-Cookie` (location reads
   and rotation) is applied to the cookies file (Domain/Path/Expires/Max-Age/deletion, host-only vs
   domain cookies). Written atomically (tmp + rename), only when something changed, with a
   one-generation `cookies.txt.bak`; comments and unknown lines are preserved; permissions are
   re-secured on each write.
2. **L2 RotateCookies** (`src/rotate.ts`). About every 9 minutes the poller POSTs
   `https://accounts.google.com/RotateCookies` (the call the Google web client makes) to refresh
   `__Secure-1PSIDTS` / `__Secure-3PSIDTS`. Skipped if the cookies file was modified in the last 60 s.
   The outcome is stored in the DB `meta` table and shown as
   `cookie_rotation: {last_ok_at, last_error_kind}` in `location_status`, `live-location status` and
   `/healthz` (never values).
3. **L4 persistent browser profile** (`src/browser-session.ts`). A real Chromium profile signed in to
   the recipient account (by a human, once) refreshes its own cookies, which survives device-bound
   sessions. `live-location refresh-browser` opens the profile in a **plain** Chromium (no automation
   flags; an automated browser made Google sign the session out) on Maps for ~45 s, closes it gracefully,
   then reads the google.com cookies straight from the profile's cookie database (Linux "v10" scheme,
   `--password-store=basic`, as in browser_cookie3 / pycookiecheat) into `cookies.txt`. After `login`
   the export reads the database without launching anything. It refuses to overwrite the file unless
   clearly signed in. On an
   auth failure (poll or rotation) the poller runs it once (then re-polls once) before marking
   `auth_state=expired`, at most once per 30 minutes.

One-time login: `live-location login` starts the system Chromium as a plain process (no automation
flags) on the profile with the Google sign-in page. Sign in to the **dedicated recipient account** in
that window, then close it; the tool never types or sees a password. It then exports the cookies. In
Docker see DOCKER.md (noVNC at http://localhost:6082/vnc.html). Chrome is found via `CHROME_PATH` (in
Docker `/usr/local/bin/chromium-wrapper`) or common install paths. Close the login window before
running `refresh-browser` (a running browser holds the profile lock).

## Commands

Run from this directory (`npm run` scripts, or `node --import tsx src/cli.ts <cmd>`; the package also
declares a `live-location` bin).

| Command | What it does |
|---|---|
| `live-location auth` | Validate the cookies file and do **one** live fetch. Prints ok + sharer ids, never coordinates. The only command intended for ad-hoc Google contact; it refuses to run under test environments. |
| `live-location login [--timeout MIN]` | Human sign-in to the recipient account in the persistent browser profile (default 15 min), then export cookies. Refuses to run in test environments. |
| `live-location refresh-browser` | Re-export `cookies.txt` from the persistent browser profile (L4 keepalive). |
| `live-location poll` | One poll now (`LIVE_SOURCE=synthetic` for the generator). |
| `live-location daemon` | Poll forever with backoff. Handles SIGINT/SIGTERM. **Never prunes.** |
| `live-location simulate --count N` | Insert N synthetic observations (fake coordinates near 10.x/20.x) into the DB for development. Refuses to write into a DB holding real observations. |
| `live-location status` | Pipeline status as JSON (no coordinates). |
| `live-location prune [--yes]` | Retention. Dry run by default (prints how many rows are older than `LIVE_RETENTION_DAYS`). Deletes only with `--yes` or `LIVE_PRUNE_CONFIRM=true`. |
| `live-location serve` | OAuth-protected Streamable HTTP MCP server (`POST /mcp`, `GET /healthz`). |
| `live-location stdio` | MCP over stdio (for Claude Code / Claude Desktop). |

The daemon and the MCP server are separate processes sharing the SQLite file (WAL mode). Run the
daemon somewhere long-lived; the MCP server (stdio or HTTP) only reads.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `LIVE_MCP_DB` | `~/.location-platform/live-location/live.sqlite` | Own SQLite file. Paths that look like a Timeline DB are rejected, as is any existing DB containing foreign tables. |
| `LIVE_COOKIES_FILE` | `~/.location-platform/secrets/live/cookies.txt` | Netscape cookies file of the recipient account. |
| `LIVE_SHARER_ID` | unset | Sharer id to track. Unset + exactly one sharer = use it; unset + several = error listing ids. |
| `LIVE_COOKIE_ROTATION` | `true` | L2: periodic RotateCookies from the daemon. |
| `LIVE_ROTATE_MIN_INTERVAL_SEC` | `540` | Minimum seconds between rotation attempts (clamped to >= 60). |
| `LIVE_BROWSER_REFRESH` | `true` | L4: on auth failure, refresh cookies from the browser profile (only if the profile dir exists; max once per 30 min). |
| `LIVE_BROWSER_PROFILE` | `~/.location-platform/secrets/live/browser-profile` | Persistent Chromium profile dir (created 0700). |
| `CHROME_PATH` | auto-detected | Chrome/Chromium executable (Docker: `/usr/local/bin/chromium-wrapper`). |
| `LIVE_PB` | built-in constant | Override the opaque `pb` map-tile parameter if Google rejects the built-in one. |
| `LIVE_SOURCE` | `google` | `google` or `synthetic` (generator; no network). |
| `LIVE_POLL_INTERVAL` | `60000` | ms between polls; **clamped to a minimum of 30000**. |
| `LIVE_BACKOFF_MAX` | `900000` | Maximum delay after repeated failures (ms). Delay doubles per failure; auth failures jump straight to this. |
| `LIVE_STALE_SECONDS` | `300` | Observation older than this is flagged `stale`. |
| `LIVE_RETENTION_DAYS` | `7` | Raw observation retention used by `prune`. Nothing deletes automatically. |
| `LIVE_PRUNE_CONFIRM` | `false` | `true` makes `prune` delete without `--yes`. |
| `LIVE_MAX_PRECISION` | `exact` | Server-side cap: `semantic` (no coordinates) / `approximate` (2 decimals, ~1 km) / `exact`. |
| `LIVE_DEFAULT_PRECISION` | `approximate` | Default precision for history tools (`recent_locations`, `where_was_i_recently`, `movement_since`); `where_am_i` is exact by default. Set `exact` for full coordinates everywhere. |
| `LIVE_MCP_PORT` | `8702` | HTTP port (loopback only unless `MCP_BIND_HOST`). |
| `LIVE_MCP_PUBLIC_URL` | `http://localhost:8702` | Public base URL; the OAuth resource is `<url>/mcp`, scope `location:read`. |
| `MCP_AUTH_ISSUER`, `MCP_ALLOWED_SUBJECTS`, `MCP_ALLOW_ANY_SUBJECT`, `MCP_AUTH_JWKS_URI` | see `@location/mcp-auth` | OAuth resource-server settings for `serve`. |
| `LOG_LEVEL`, `LOG_LOCATION_DEBUG` | `info`, `false` | Logs go to stderr as JSON. Coordinates are only logged when `LOG_LOCATION_DEBUG=true`. |
| `LOCATION_PLATFORM_HOME` | `~/.location-platform` | Root for data and secrets (outside the repo). |

## Tools

All tools are read-only. Every result carries `source: "google_location_sharing"`,
`semantics: "raw_point_observation"`, `kind`, `observed_at` (Google's timestamp of the fix, UTC),
`polled_at` (when our daemon fetched it), `freshness_seconds`, `precision`, `accuracy_meters`, `stale`.

| Tool | Input | Default precision |
|---|---|---|
| `where_am_i` | `precision?` | exact |
| `recent_locations` | `start`, `end`, `max_points?` (default 200, max 1000), `precision?` | approximate |
| `where_was_i_recently` | `timestamp`, `tolerance_minutes?` (default 30), `precision?` | approximate |
| `movement_since` | `timestamp`, `max_points?`, `include_points?`, `precision?` | approximate |
| `location_status` | none | n/a (no coordinates) |

Timestamps accept ISO-8601, epoch seconds/ms, `now`, `today`, `yesterday`. Movement figures
(distance, displacement, speed, bounding box) are **estimates derived from observations** and are
inflated by GPS jitter and sparse polling. Addresses Google returns are stored in the DB but are not
exposed by any tool or by `/healthz`.

## Claude Code stdio config example

```json
{
  "mcpServers": {
    "live-location": {
      "command": "node",
      "args": ["--disable-warning=ExperimentalWarning", "--import", "tsx",
               "C:/Users/you/Documents/dev/claude/location-platform/live-location-mcp/src/cli.ts", "stdio"],
      "env": {
        "LIVE_MCP_DB": "C:/Users/you/.location-platform/live-location/live.sqlite",
        "LIVE_SHARER_ID": "<id printed by `live-location auth`>"
      }
    }
  }
}
```

The stdio server only reads the DB, so the daemon must be running separately for data to stay fresh.

## Security notes

- **The cookies file is full session access to the recipient Google account.** Anyone holding it can
  act as that account. That is why the account must be a dedicated, otherwise empty one — never your
  main account. Store the file outside the repo (default `~/.location-platform/secrets/live/`), mode
  `0600`, and never commit or share it. Repo `.gitignore` already blocks `cookies*.txt`.
- **The browser profile directory is a full session for the recipient account** (cookies, tokens, everything Chromium stores). It lives under `secrets/` (default `secrets/live/browser-profile`), mode `0700`; never commit, share or back it up to a synced folder. The cookies file is rewritten atomically and a `cookies.txt.bak` (also a full session) is kept next to it.
- Cookies are only sent to `www.google.com`, chosen by domain/path/expiry like a browser would; they
  are never logged, and error messages never include them.
- The location DB holds precise real-world positions. Keep it outside the repo, and set
  `LIVE_MAX_PRECISION=approximate` if you want the server to never hand out exact coordinates.
- HTTP mode requires OAuth bearer tokens (audience = `<public url>/mcp`, scope `location:read`,
  allowed subject list). `/healthz` is unauthenticated but contains no coordinates, addresses or ids.
- Retention is explicit: raw observations are kept until you run `live-location prune --yes`.
  The daemon never deletes anything.
- Sharer ids are opaque Google account ids; they are stored but never returned by tools or health.

## Freshness caveats

- Data is only as fresh as the phone's last upload to Google, then the poll interval (default 60 s).
  A phone that is offline, in battery saver, or has Maps in the background can hold a fix for many
  minutes; Google keeps returning the *same* fix (deduplicated here by person + source timestamp) so
  `observed_at` can be far older than `polled_at`. Always read `freshness_seconds` and `stale`.
- If sharing lapses (the person stops sharing, expiry) polls succeed with zero observations and
  `location_status.sharing_state` becomes `lapsed`.

## Brittleness

- The endpoint and its positional array layout are undocumented; a layout change surfaces as a
  `format` error kind (poll fails, backoff) rather than wrong coordinates, but will need code changes
  in `src/google.ts`.
- The `pb` parameter is an opaque map-tile string copied from the public `locationsharinglib`
  project; override with `LIVE_PB` if requests start failing.
- Google may throttle or challenge automated access (HTTP 429/503, or an HTML sign-in page that we
  classify as expired auth). The poller backs off and never polls faster than every 30 s.
- Using the endpoint this way may violate Google's terms of service; it is intended for reading your
  own shared location.

## Development

```
npm test        # vitest, all synthetic data, no network
npm run typecheck
LIVE_MCP_DB=/tmp/live.sqlite LIVE_SOURCE=synthetic node --import tsx src/cli.ts simulate --count 20
LIVE_MCP_DB=/tmp/live.sqlite LIVE_SOURCE=synthetic node --import tsx scripts/smoke.ts
```

Architecture: everything Google-specific is behind `LiveLocationSource` (`src/source.ts`); the Google
implementation and the pure `parseLocationSharingResponse` live in `src/google.ts`; the poller, DB
and tools only see normalized observations.
