# Timeline export contract (timeline-sync → timeline-mcp)

timeline-sync publishes, under `$TIMELINE_DATA_DIR` (default `~/.location-platform/timeline`,
always outside the git checkout):

| Path | Meaning |
|---|---|
| `current/Timeline.json` | **Last-known-good** export. Replaced atomically only after a fully successful sync. |
| `current/Timeline-full.json` | Optional enriched records from upstream `build_records.py` (may be absent). |
| `exports/Timeline-<UTC yyyymmddTHHMMSSZ>.json` | Timestamped history of exports (rotated, keep N). |
| `raw/odlh-storage.db` | Decrypted ODLH SQLite database (upstream-compatible schema). |
| `state/sync-status.json` | Freshness/health metadata. See `sync-status.schema.json`. No secrets, no coordinates. |

## `Timeline.json` shape

Exactly upstream `odlh_export.py` output (`{"semanticSegments": [...]}`), **plus** two
additive fields per segment that upstream drops:

- `segmentId` (string) — ODLH `segment_id`, stable across fetches. Used for idempotent indexing.
- `segmentType` (int) — 1 visit, 2 activity, 3 timelinePath, 4 trip.

and a top-level `"exportMeta": {"generator": "timeline-sync", "upstreamCommit": "<sha>", "generatedAt": "<iso>", "adapter": "geller|synthetic|local_db"}`.

Consumers must tolerate unknown fields and missing optional fields. Times are ISO-8601 with
the segment's own UTC offset. Coordinates are `"lat°, lng°"` strings.

If a segment has no `segmentId` (e.g. an export produced by plain upstream), consumers derive
a deterministic ID: `sha256(kind|startTime|endTime|placeId or first point)`.
