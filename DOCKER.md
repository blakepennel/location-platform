# Running location-platform in Docker

One image runs everything: the local OAuth server, both MCP servers, the live-location poller,
and a Timeline sync scheduler. The image includes Chromium, which runs headless, with an optional
virtual screen you can watch and use from your web browser (noVNC).

| Service | What it does | Port (host loopback only) |
|---|---|---|
| `dev-auth` | Local OAuth 2.1 server for MCP clients | `127.0.0.1:8700` |
| `timeline-mcp` | Historical Timeline MCP (Streamable HTTP + OAuth) | `127.0.0.1:8701` |
| `live-location-mcp` | Live location MCP (Streamable HTTP + OAuth) | `127.0.0.1:8702` |
| `live-poller` | Polls Google Location Sharing (default every 60 s) | — |
| `timeline-sync` | Syncs the Timeline every 6 h, then names new places | `127.0.0.1:6080` (noVNC, when enabled) |
| `import-host` | One-off: copy an existing `~/.location-platform` into Docker | — |

All state (SQLite databases, Timeline exports, secrets) lives in **one volume mounted at `/data`**.
Nothing is baked into the image, and every port is published on `127.0.0.1` only.

## 1. Install Docker

**Windows (recommended): Docker Desktop.** You already have WSL2, which it uses as its engine.
```powershell
winget install -e --id Docker.DockerDesktop
```
Sign out and back in (or restart), start Docker Desktop once, and accept its terms. It's free for
personal use. Check it works with `docker compose version`.

**Alternative: Docker Engine inside WSL Ubuntu** (no Desktop app). In an Ubuntu terminal:
```bash
curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER
```
Then close and reopen Ubuntu, and run the commands below from `/mnt/c/Users/<you>/Documents/dev/claude/location-platform`.

**Linux server:** install Docker Engine the same way.

## 2. First start

Stop anything running on the host first (`npm run dev`, the live `daemon` window). Otherwise the
ports clash and your location would be polled twice.

```powershell
cd path\to\location-platform
docker compose build

# copy your existing secrets + data (Timeline key, master token, live cookies, Places key, DBs) into the volume
$env:HOST_PLATFORM_HOME = "C:/Users/<you>/.location-platform"; docker compose run --rm import-host

docker compose up -d
docker compose ps
```

Health checks (non-sensitive):
```powershell
curl http://localhost:8700/healthz; curl http://localhost:8701/healthz; curl http://localhost:8702/healthz
```

Settings come from `location-platform/.env`, which compose reads automatically. See `.env.example` for all options.

## 3. Watch or drive the browser (noVNC)

Set `BROWSER_MODE=vnc` in `.env` and restart the sync service. Optionally set `VNC_PASSWORD` too.
```powershell
docker compose up -d timeline-sync
```
Open **http://localhost:6080/vnc.html** and click **Connect**. Any Chromium that timeline-sync launches
now opens on that screen, including upstream's normally-headless place-name resolver. To watch a
few lookups happen:
```powershell
docker compose exec timeline-sync timeline-sync names --max 5
```
Set `BROWSER_MODE=headless` again when you're done. The noVNC screen can show Google sign-in pages,
so it's published on `127.0.0.1` only.

Chromium is used rather than Firefox because both of upstream's browser scripts (`resolve_names.js`,
`web_key.py`) are written for Chrome/Chromium via puppeteer.

## 4. Everyday commands

```powershell
docker compose logs -f timeline-sync live-poller           # watch
docker compose exec timeline-sync timeline-sync sync       # sync the Timeline now
docker compose exec timeline-sync timeline-sync status     # Timeline freshness
docker compose exec timeline-sync timeline-sync names      # name the next batch of places
docker compose exec live-poller node --import tsx live-location-mcp/src/cli.ts status   # live freshness
docker compose restart live-poller
docker compose down                                         # stop (the volume keeps all data)
```

### One-time Google steps inside Docker (only if you didn't import them)
```powershell
docker compose exec -it timeline-sync timeline-sync auth --email you@gmail.com   # hidden prompt for the oauth_token
# with BROWSER_MODE=vnc, open http://localhost:6080/vnc.html and answer Google's password prompt there:
docker compose exec timeline-sync timeline-sync key --email you@gmail.com
```

### Keeping the live session alive (one-time login, then automatic)
The live poller keeps the recipient account's Google session alive by itself: it writes rotated cookies
back to `cookies.txt`, calls Google's `RotateCookies` about every 9 minutes, and, if the session is ever
rejected, re-exports fresh cookies from a persistent Chromium profile (at most once per 30 min). You only
sign in once, as a human, inside the container:

```powershell
# 1. in .env:  BROWSER_MODE=vnc   (optionally VNC_PASSWORD=...), then recreate the poller with the display
docker compose up -d live-poller
# 2. run the login (opens Chromium on the virtual display)
docker compose exec live-poller node --import tsx live-location-mcp/src/cli.ts login
```
Open **http://localhost:6082/vnc.html** (`LIVE_VNC_PORT`, loopback only; the live-poller has its own noVNC,
separate from timeline-sync's on 6080), click **Connect**, sign in to the
**dedicated recipient account** in the browser window, then **close the browser window**. `login` then exports
the cookies into `secrets/live/cookies.txt` and prints a summary. Nobody's password is typed or seen by the
tool. Afterwards set `BROWSER_MODE=headless` again and `docker compose up -d live-poller`; the profile
persists in the volume (`/data/secrets/live/browser-profile`, mode 0700 -- it is a full session for that account).

Other commands: `... cli.ts refresh-browser` (re-export cookies from the profile now), `... cli.ts status`
(shows `cookie_rotation`: last OK time / last error kind, never values).

**Fallback: manual cookies.txt import.** Re-export `cookies.txt` from the dedicated Firefox profile into
`C:/Users/<you>/.location-platform/secrets/live/`, then:
```powershell
$env:HOST_PLATFORM_HOME = "C:/Users/<you>/.location-platform"; $env:IMPORT_WHAT = "secrets"; docker compose run --rm import-host; Remove-Item Env:IMPORT_WHAT
docker compose restart live-poller
```
`IMPORT_WHAT=secrets` copies only the `secrets/` folder, so the databases in the volume are left alone.
A full import refuses to overwrite a volume that already has databases unless you pass `FORCE=1`.

## 5. Connect Claude to the Docker servers

**Claude Code over stdio.** Run the stdio server inside the running container so it reads the volume.
In `.mcp.json`:
```jsonc
{
  "mcpServers": {
    "timeline": { "command": "docker",
      "args": ["exec", "-i", "location-platform-timeline-mcp-1", "node", "--import", "tsx", "timeline-mcp/src/cli.ts", "stdio"] },
    "live-location": { "command": "docker",
      "args": ["exec", "-i", "location-platform-live-location-mcp-1", "node", "--import", "tsx", "live-location-mcp/src/cli.ts", "stdio"] }
  }
}
```
The containers already carry the precision settings from `.env` (exact by default in this setup).

**Over HTTP + OAuth:** point any MCP client at `http://localhost:8701/mcp` or `http://localhost:8702/mcp`.
It discovers the OAuth server at `http://localhost:8700` exactly as in [AUTH.md](AUTH.md).

## 6. Tests inside the image

```powershell
docker compose run --rm --no-deps timeline-mcp npm test          # Node + Python suites
docker compose run --rm --no-deps timeline-mcp npm run test:e2e  # OAuth + both servers end to end
```

## Where the data lives

- **Default:** the named volume `location-platform_lp-data`. It's the safest option for SQLite on
  Docker Desktop (Windows/macOS), where sharing host folders with containers doesn't support
  SQLite's file locking reliably.
- **Linux server:** set `LP_DATA=/srv/location-platform` in `.env` to use a normal directory.
- **Back up:** `docker run --rm -v location-platform_lp-data:/d -v ${PWD}:/b alpine tar czf /b/lp-backup.tgz -C /d .`
  The backup contains your secrets and location history, so store it carefully.
- **Delete everything:** `docker compose down -v`. This permanently removes the volume, including your secrets.
