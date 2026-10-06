# timeline-sync

Keeps a local, validated copy of **your own** Google Maps Timeline for `timeline-mcp`.
It is a thin wrapper around the pinned upstream
[arkenoi/timeline-export](https://github.com/arkenoi/timeline-export) (submodule `upstream/`,
commit `3c1faa0`, never edited): it adds secret-safe storage, structured redacted logging,
atomic last-known-good publishing, freshness tracking and an offline synthetic mode.

* Strategy and shims: [UPSTREAM.md](UPSTREAM.md)
* How the upstream pipeline actually works: [HOW_UPSTREAM_WORKS.md](HOW_UPSTREAM_WORKS.md)
* Contracts: `../schemas/TIMELINE_EXPORT_CONTRACT.md`, `../schemas/sync-status.schema.json`

> **Timeline backup is not real-time.** Google only receives the phone's on-device Timeline backup
> periodically (typically hours, up to about a day behind). Syncing more often cannot make the
> data fresher than the last upload; `timeline-sync status` reports the lag.

## Install (Windows, Git Bash or PowerShell)

```bash
cd timeline-sync
python -m venv .venv
.venv/Scripts/pip install -e ".[dev]"          # add ,browser for `auth --from-browser`
npm ci --prefix upstream                        # only needed once, for `timeline-sync key`
.venv/Scripts/timeline-sync doctor
```

(POSIX: `.venv/bin/...`.) The upstream submodule must be checked out
(`git submodule update --init timeline-sync/upstream`).

## Where things live (never inside the git checkout)

| | Default | Override |
|---|---|---|
| data | `~/.location-platform/timeline` | `TIMELINE_DATA_DIR` |
| secrets | `~/.location-platform/secrets/timeline` (`master.txt`, `key.b64`, `android_id`, `account.json`) | `TIMELINE_SECRETS_DIR` |

Other env: `TIMELINE_SOURCE` (`geller`\|`synthetic`\|`local_db`), `TIMELINE_LOCAL_DB`,
`TIMELINE_KEEP_EXPORTS` (10), `TIMELINE_DEFAULT_UTC_OFFSET_MIN` (120, the seed offset for leading
`timelinePath` rows), `TIMELINE_LOG_LEVEL`.

Data layout: `raw/odlh-storage.db`, `exports/Timeline-<UTC ts>.json` (rotated),
`current/Timeline.json` (last-known-good), `current/Timeline-full.json` (optional),
`state/sync-status.json`, `state/sync.lock`.

Secret files are created private from the start (POSIX `0600`/`0700`; Windows
`icacls <path> /inheritance:r /grant:r "<USER>:F"`), written atomically, and never printed.
Logs are JSON lines on stderr with a redaction filter (`oauth2_4/`, `ya29.`, `aas_et/`, `Bearer`,
32-byte base64 keys) and coordinates are never logged.

## One-time setup (real account)

```bash
# 1. sign in normally in YOUR browser at
#    https://accounts.google.com/embedded/setup/android?source=com.google.android.gms&xoauth_display_name=Android%20Device
#    then store the master token (hidden prompt; or --oauth-token-stdin, or --from-browser firefox)
timeline-sync auth --email you@example.com

# 2. fetch the Timeline decryption key: opens a real browser window, you type your password
timeline-sync key
```

Chrome on Windows (v127+) uses app-bound cookie encryption, so `auth --from-browser chrome` often
fails; copy the `oauth_token` cookie from DevTools and use the hidden prompt or
`--oauth-token-stdin`. Revoke the master token any time at
<https://myaccount.google.com/device-activity>.

## Routine use

```bash
timeline-sync sync                 # fetch -> decrypt -> export -> validate -> atomic publish -> status
timeline-sync sync --enrich        # also build current/Timeline-full.json (upstream build_records)
timeline-sync sync --source synthetic          # fully offline, fake data
timeline-sync sync --source local_db --local-db path\to\odlh-storage.db
timeline-sync status [--json]
timeline-sync doctor [--json]
```

| Command | What it does |
|---|---|
| `auth --email E [--from-browser chrome\|edge\|firefox] [--oauth-token-stdin]` | one-time; stores master token, email, android_id |
| `key [--email E] [--chrome PATH]` | one-time; headful key retrieval via shimmed upstream `web_key.py` |
| `fetch [--source X]` | adapter fetch to `raw/odlh-storage.db` |
| `export` | decode the raw db to `exports/Timeline-<ts>.json`; does **not** publish |
| `sync [--enrich] [--source X] [--allow-shrink]` | the routine command (see below) |
| `status [--json]` | last success / cloud request, oldest/newest record, newest mutation, lag hours, counts, auth health, last error |
| `doctor` | python deps, upstream pin and shim anchors, node/npm/puppeteer/Chrome, secrets presence (booleans) and permissions |
| `synthetic --out DIR [--days N --seed N --end-date D]` | generate a synthetic data dir for developing other projects |

`sync` guarantees: one run at a time (lock file, stale locks reclaimed); the bearer token lives
only in memory; `current/Timeline.json` is replaced with `os.replace` only after the export parsed,
is non-empty, carries `segmentId`/`segmentType` and did not shrink by more than 50% versus the last
published export (`--allow-shrink` overrides); on **any** failure last-known-good is untouched,
`state/sync-status.json` records the sanitized error with the failing stage and increments
`consecutive_failures`, and the exit code is non-zero (`75` if another sync holds the lock).

## Adapters (`timeline_sync/sources.py`)

* `GellerCloudSource`: real. Master + key from the secrets dir, bearer via `gpsoauth`, POST
  `BatchSync`, decrypt with upstream code. HTTP 401/403 or gRPC UNAUTHENTICATED marks auth
  `expired`.
* `SyntheticSource`: builds a wire-exact encrypted BatchSync response from synthetic protobufs
  (`synthetic.py`) and pushes it through the same decode pipeline: proves decrypt + decode
  end to end offline. All places are fake, around lat 10.0 / lng 20.0. Includes a 3-day trip, a
  deleted segment, a `-05:00` segment and a `+01:00 -> +02:00` change.
* `LocalDbSource`: copies an existing `odlh-storage.db` (e.g. from the old redroid container path).

## Tests

```bash
.venv/Scripts/python -m pytest        # all offline; synthetic data and tmp dirs only
.venv/Scripts/python tools/make_mcp_fixture.py   # regenerate ../timeline-mcp/test/fixtures/*.synthetic.json
```
