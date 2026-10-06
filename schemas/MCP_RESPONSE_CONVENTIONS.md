# Shared MCP response conventions

Both MCP servers return **conceptually compatible** JSON (as MCP `structuredContent` and as a
JSON text block). They are NOT semantically equivalent and must never be merged.

| Field | Historical (`timeline-mcp`) | Live (`live-location-mcp`) |
|---|---|---|
| `source` | `"google_timeline"` | `"google_location_sharing"` |
| `kind` | `visit` \| `activity` \| `timeline_path` \| `trip` \| `summary` \| `status` | `observation` \| `movement_summary` \| `status` |
| `observed_at` | — (semantic segments are intervals) | source timestamp of the fix (ISO-8601 UTC) |
| `polled_at` | — | when our daemon fetched it |
| `start_time` / `end_time` | interval of the segment (ISO-8601 with source offset) | range for summaries |
| `latitude` / `longitude` | present only when `precision` allows (see below) | present only when `precision` allows |
| `accuracy_meters` | — (not provided by Timeline) | Google-reported accuracy radius |
| `confidence` | Google's probability 0..1 | — |
| `freshness_seconds` | age of newest indexed record vs now | age of latest observation vs now |
| `precision` | `semantic` \| `approximate` \| `exact` | `approximate` \| `exact` |
| `semantics` | `"google_semantic_reconstruction"` | `"raw_point_observation"` |

## Precision

- `semantic` (historical default): no coordinates; place ID, place name (if enriched), semantic type.
- `approximate`: coordinates rounded to 2 decimals (~1.1 km).
- `exact`: full source precision. Must be requested explicitly per call.

Live defaults to `exact` for `where_am_i` (that is the point of the tool) but `approximate`
for bulk history tools unless requested; a server-side `MAX_PRECISION` env can cap it.

## Limits

Every list tool takes `limit` (bounded by a server max) and reports `truncated: true` plus
`total_available` when it cut results. No tool returns raw GPS path points unless
`include_points=true`, and even then points are downsampled to `max_points` (≤ 500).

## Errors

Tool errors return `isError: true` with a short, non-sensitive message.
