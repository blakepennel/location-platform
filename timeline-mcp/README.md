# timeline-mcp

Read-only MCP server over **historical** Google Maps Timeline data (visits, activities, trips, GPS path
buckets). It indexes the export produced by `timeline-sync` into its own SQLite database and answers
questions such as "where was I at 14:30 last Tuesday?" or "summarize my day".

Important semantics (also stated in every tool result as `source: "google_timeline"`,
`semantics: "google_semantic_reconstruction"`):

- Timeline is Google's **semantic reconstruction**, not raw GPS observations.
- It is **not real-time**: the phone backs up hours to a day late. `timeline_status` reports the lag.
- Default precision is **semantic**: place names/types, **no coordinates**.

See `../schemas/TIMELINE_EXPORT_CONTRACT.md` (input), `../schemas/sync-status.schema.json` and
`../schemas/MCP_RESPONSE_CONVENTIONS.md` (output conventions).

## Architecture

```
timeline-sync  ->  $TIMELINE_DATA_DIR/current/Timeline.json  ->  [source.ts]  ->  [indexer.ts]  ->  SQLite index
                   $TIMELINE_DATA_DIR/state/sync-status.json                                          |
                                                                          queries.ts / analysis.ts <--+
                                                                                  |
                                                                       tools.ts (13 tools) -> stdio | HTTP+OAuth
```

| File | Role |
|---|---|
| `src/source.ts` | `HistoricalLocationSource` interface + `TimelineSyncFileSource`. The only place that knows where data comes from; nothing else knows about Geller/Google internals. |
| `src/db.ts` | Schema: `places`, `visits`, `activities`, `timeline_paths`, `trips`, `sync_metadata`, `imports`. |
| `src/indexer.ts` | Idempotent import, derived segment ids, malformed-segment handling, `IndexManager` (auto-reindex). |
| `src/queries.ts`, `src/analysis.ts` | Pure read-only query layer and rollups (where_was_i, distance, day/week summaries). |
| `src/present.ts` | The single place coordinates are emitted, always via `applyPrecision()`. |
| `src/tools.ts` | `buildServer(deps)` registering the 13 tools. |
| `src/http.ts` | Streamable HTTP host (shared `createMcpHttpApp`) + minimal `/healthz`. |
| `src/cli.ts` | `serve`, `stdio`, `index`, `status`. |

### Indexing behaviour

- **Idempotent.** Upsert by `segment_id` in one transaction. The same export (sha256) twice is a no-op;
  a changed segment is updated in place; unchanged segments are not rewritten.
- **Full-snapshot semantics.** Segments missing from a newer export (e.g. deleted by the user) are removed,
  and orphaned places dropped. Counts (`added/updated/unchanged/removed`) are reported per kind.
- **Malformed input.** A document that is not `{"semanticSegments": [...]}` (or not JSON) is rejected and the
  existing index is left untouched. Individual bad segments (bad/impossible times, end < start, missing kind,
  unparseable coordinates, wrong shape) are skipped and counted by reason, never fatal to the batch.
  An export with **zero** valid segments will not wipe a populated index (use `--allow-empty` to override).
- **Ids.** Uses `segmentId` when present, otherwise `d-` + sha256(`kind|startMs|endMs|placeId-or-first-point`)[:32].
  Places are keyed by `placeId`, else `featureId`, else a rounded-location hash (`loc_...`).
- **Time zones.** Times keep their own UTC offset (`+02:00`, `-05:00`, DST changes inside a visit). Instants are
  stored as epoch ms plus offset minutes; output ISO strings use each segment's own offset.
- **Auto-reindex.** On server start, and at most every 60 s on a request (`stat` of the export: mtime+size), the
  export is re-imported only if it changed and its sha256 differs. The large JSON is never parsed per request.
  A corrupt new export keeps the old index and records a sanitized `last_import_error` (shown by `timeline_status`).
- **Enrichment.** If visits carry `placeName` / `placeAddress` / `placeCategory` (upstream `build_records.py` /
  name resolution), they populate `places.name/address/category`. Un-enriched exports still work (place id + semantic type).

## Tools (all read-only; no SQL, file or bulk-dump tool)

Every result includes `source`, `semantics`, `precision` (used), `freshness_seconds` (age of the newest indexed
record) and items with `kind`, `start_time`, `end_time` (ISO with the segment's own offset) and `confidence`
(Google probability) where available. Every list tool takes `limit` (default 50, clamped to 500) and returns
`returned`, `truncated`, `total_available`. Time ranges must have `end > start` and be at most 400 days.
Times accept ISO-8601 (with/without offset), epoch s/ms, `now`, `today`, `yesterday`; offset-less times use the
optional `timezone` (IANA) argument, default `LOCATION_TIMEZONE`/system zone.

| Tool | Purpose |
|---|---|
| `timeline_status` | Last sync success / cloud request, coverage (oldest start, newest end), newest record, counts, freshness and lag, auth state, last error stage (sanitized), "not real-time" note. |
| `where_was_i {timestamp, tolerance_minutes?, timezone?}` | Containing visit (preferred) -> containing activity -> nearest within tolerance (`match:"nearest"`, `gap_seconds`) -> path interpolation (`match:"estimate"`) -> `match:"none"`. |
| `visits {start, end, place?, semantic_type?, limit}` | Visits overlapping a range. |
| `timeline_between {start, end, include_points?, max_points?}` | Compact chronological visits + activities + trip markers. Path points only with `include_points` (needs approximate/exact), downsampled to `max_points` (default 200, max 500). |
| `search_places {query?, semantic_type?, limit}` | Places by name/category/placeId (address too when precision is not semantic) with visit count, total time, first/last seen. |
| `visit_history {place, start?, end?, order?, limit}` | Visits to a place (place_key, placeId, or name). |
| `time_at_place {place, start?, end?}` | Merged total seconds clipped to the range, visit count, bounded per-day breakdown. |
| `trips {start?, end?, limit}` | Trip segments with contained visit/activity counts, source distance by mode, top places. |
| `activities {start, end, mode?, limit}` | Movement segments with Google's distance. |
| `distance_traveled {start, end, group_by?}` | Sum of Google `distanceMeters` by `mode` (default) / `day` / `none`. Missing distances with both end points known get a **separate** `estimated_meters` (`method:"haversine_estimate"`); never merged into `source_meters`. Activities are attributed to the day they start. |
| `summarize_day {date, timezone?}` | Ordered timeline, places with durations, movement by mode, first/last known place, unknown-time gaps (>= 10 min), coverage flags (before/after indexed range, Timeline lag). DST days are 23/25 h. |
| `summarize_week {week_start, timezone?, precision?}` | Exactly 7 calendar days: per-day rollups, top places, movement totals. |
| `visits_near {latitude, longitude, radius_meters?, start?, end?, limit?, precision?}` | Places within a radius of a point (nearest first, with distance) and their visits: "when was I in <area>?". |

### Precision

`precision` is `semantic` (default; no coordinate keys or values anywhere, and no street address),
`approximate` (2 decimals, ~1.1 km), or `exact`. The server caps it with `TIMELINE_MAX_PRECISION`; a clamped
request is answered at the cap with `precision_clamped: true` and `requested_precision`.

## Commands

Run from `timeline-mcp/` (or the workspace root with `-w timeline-mcp`):

```bash
npm run index                  # import $TIMELINE_DATA_DIR/current/Timeline.json into the index
npx tsx src/cli.ts index --file path/to/Timeline.json --db path/to/index.sqlite [--force] [--allow-empty]
npm run status                 # counts, coverage, freshness, sync health (never creates a DB)
npm run start                  # HTTP server (OAuth required)  == cli.ts serve
npm run stdio                  # stdio server for local Claude Code == cli.ts stdio
npm test                       # vitest (synthetic data only)
npm run typecheck
```

Direct form: `node --disable-warning=ExperimentalWarning --import tsx src/cli.ts <serve|stdio|index|status>`.

`index` prints a summary (counts only, no place names) and exits 1 on failure.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `TIMELINE_DATA_DIR` | `~/.location-platform/timeline` | timeline-sync data dir (`current/Timeline.json`, `state/sync-status.json`). |
| `TIMELINE_MCP_DB` | `~/.location-platform/timeline-mcp/timeline-index.sqlite` | The index database (own DB). |
| `TIMELINE_MAX_PRECISION` | `exact` | Cap: `semantic` \| `approximate` \| `exact`. |
| `TIMELINE_DEFAULT_PRECISION` | `semantic` | Used when a call doesn't pass `precision` (clamped to the cap). Set `exact` for full coordinates by default. |
| `TIMELINE_MCP_PORT` | `8701` | HTTP port (listens on loopback only unless `MCP_BIND_HOST`). |
| `TIMELINE_MCP_PUBLIC_URL` | `http://localhost:8701` | Public base URL; the OAuth resource / token audience is `<url>/mcp`. |
| `MCP_AUTH_ISSUER` | `http://localhost:8700` | OAuth issuer (see `../mcp-auth`). Required scope: `timeline:read`. |
| `MCP_ALLOWED_SUBJECTS` | (none) | Allowed OAuth `sub` values. HTTP refuses to start with none unless `MCP_ALLOW_ANY_SUBJECT=true`. |
| `MCP_AUTH_JWKS_URI`, `MCP_ALLOW_ANY_SUBJECT`, `MCP_TRUST_PROXY`, `MCP_BIND_HOST` | | See `@location/mcp-auth` / `@location/shared`. |
| `LOCATION_PLATFORM_HOME`, `LOCATION_TIMEZONE`, `LOG_LEVEL`, `LOG_LOCATION_DEBUG` | | Shared platform settings. Logs go to stderr and redact secrets and coordinates. |

## HTTP transport and health

`serve` exposes stateless Streamable HTTP at `POST /mcp` with OAuth bearer enforcement (audience = resource URL,
scope `timeline:read`, allowed subject), RFC 9728 metadata under `/.well-known/oauth-protected-resource`, and
`GET /healthz`. Health returns only: `status`, `index_present`, record `counts`, `newest_record_age_seconds`,
`last_sync_age_seconds` (plus `service`). No coordinates, names, paths or error text.

## Claude Code (stdio)

The `stdio` transport has **no OAuth**: it trusts the local process that spawned it (anyone who can run it can
read your index). Use it only for local clients; use `serve` + OAuth for anything remote.

`--import tsx` resolves relative to the *current directory*, and Claude Code may launch the server from
elsewhere, so point `--import` at the absolute loader path:

```json
{
  "mcpServers": {
    "timeline": {
      "command": "node",
      "args": [
        "--disable-warning=ExperimentalWarning",
        "--import", "file:///<abs path>/location-platform/node_modules/tsx/dist/loader.mjs",
        "<abs path>/location-platform/timeline-mcp/src/cli.ts",
        "stdio"
      ],
      "env": { "TIMELINE_DEFAULT_PRECISION": "exact" }
    }
  }
}
```

Equivalent when the working directory is the workspace (or `timeline-mcp/`):
`node --disable-warning=ExperimentalWarning --import tsx <abs path>/src/cli.ts stdio`, e.g.
`claude mcp add timeline -- node --disable-warning=ExperimentalWarning --import tsx <abs path>/src/cli.ts stdio`.

## Data and privacy

- Real data lives outside the checkout (`~/.location-platform`). Tests use only synthetic data (coordinates near
  lat 10.x / lng 20.x, names like "Synthetic Cafe"); fixtures are built programmatically in `test/helpers/synthetic.ts`
  and, if present, `test/fixtures/Timeline.synthetic.json` is also exercised.
- The index is derived data and can be deleted and rebuilt at any time (`index --force`).
- Coordinates never appear in logs; `LOG_LOCATION_DEBUG` is the only opt-in.
- Semantic-precision place keys for places Google gave no id for are hashes of the rounded location; they are
  stable identifiers, not secrets.
