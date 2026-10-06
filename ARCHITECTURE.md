# ARCHITECTURE

Three **logically separate** projects plus shared libraries. The historical and live systems
are independent by design — separate data stores, separate MCP servers, separate OAuth
resources. They are **never merged**; an LLM connects to both and picks the right tool.

```
                         ┌─────────────────────────────────────────────┐
                         │                MCP clients                    │
                         │        Claude Code · Claude · ChatGPT         │
                         └───────────────┬───────────────┬──────────────┘
                          Layer B OAuth  │               │  Layer B OAuth
                    (token aud=timeline) │               │ (token aud=live)
                                         ▼               ▼
   ┌───────────────────┐     ┌───────────────────┐   ┌───────────────────┐
   │  local OAuth AS    │◄────┤   timeline-mcp     │   │ live-location-mcp  │
   │  (mcp-auth,        │ JWKS│  (historical, RO)  │   │  (live, RO)        │
   │   oidc-provider)   │◄────┤  Streamable HTTP   │   │  Streamable HTTP   │
   │  :8700             │     │  :8701 /mcp        │   │  :8702 /mcp        │
   └───────────────────┘     └─────────┬──────────┘   └─────────┬─────────┘
                                        │ reads                  │ reads
                                        ▼                        ▼
                             ┌────────────────────┐   ┌────────────────────┐
                             │ timeline-index DB  │   │  live.sqlite        │
                             │ (SQLite, derived)  │   │  (SQLite, raw obs)  │
                             └─────────┬──────────┘   └─────────┬─────────┘
                                       │ indexes                │ appends
                                       │                        │
                             ┌─────────┴──────────┐   ┌─────────┴─────────┐
                             │  timeline-sync     │   │ live poller daemon │
                             │  (Python wrapper)  │   │ (in live-location) │
                             └─────────┬──────────┘   └─────────┬─────────┘
                        Layer A Google │                        │ Layer A Google
                                       ▼                        ▼
                        ┌──────────────────────────┐  ┌────────────────────────┐
                        │ Geller BatchSync (gRPC)   │  │ Maps Location Sharing   │
                        │ geller-pa.googleapis.com  │  │ google.com/maps/rpc/... │
                        │ + AES-256-GCM decrypt     │  │ (recipient cookies)     │
                        └──────────────────────────┘  └────────────────────────┘

   ══════════ NO DATA PATH between the two SQLite stores. ══════════
```

## Languages

- **Python** for `timeline-sync` — it wraps the upstream `arkenoi/timeline-export` project
  (Python: gRPC/protobuf/AES pipeline), pinned as a git submodule. Rewriting it in another
  language would fight the upstream and lose future fixes.
- **TypeScript / Node 24** for the MCP servers and shared libraries — the MCP SDK is
  first-class in TS, and Node's built-in `node:sqlite` avoids native builds on Windows.

## Project 1 — timeline-sync (Python)

Direct **cloud / Geller** path (not the redroid/Android container path):

```
Google Timeline encrypted cloud backup
  → Geller BatchSync (gRPC over HTTP/2, geller-pa.googleapis.com)
  → encrypted ODLH records (GellerE2eeElement)
  → local AES-256-GCM decrypt (security-domain key)
  → odlh-storage.db (SQLite, upstream-compatible)
  → semantic Timeline records (odlh_export → {semanticSegments:[…]})
  → [optional] enriched records (build_records)
  → published atomically as current/Timeline.json (+ sync-status.json)
```

**Upstream strategy:** pinned git **submodule** at `timeline-sync/upstream/` (a reviewed
commit), driven by a thin Python wrapper that imports upstream functions and applies small
runtime shims (never editing upstream files) — so upstream fixes are a submodule bump + test
run. Rationale and shim list in `timeline-sync/UPSTREAM.md`.

**Source abstraction:** `HistoricalLocationSource` (`geller` | `synthetic` | `local_db`) hides
Google internals from the rest of the pipeline (dependency isolation for T11).

## Project 2 — timeline-mcp (TypeScript, read-only)

Consumes `current/Timeline.json` via a `HistoricalLocationSource` interface and maintains its
**own derived SQLite index** (`places`, `visits`, `activities`, `timeline_paths`, `trips`,
`sync_metadata`, `imports`). Indexing is **idempotent** (upsert by segment id; deterministic
derived ids when absent; full-snapshot semantics so deletions propagate). Tools never parse the
giant JSON per request. Transports: **Streamable HTTP** (primary, OAuth) + optional **stdio**
(local Claude Code). Tools: `timeline_status`, `where_was_i`, `visits`, `timeline_between`,
`search_places`, `visit_history`, `time_at_place`, `trips`, `activities`, `distance_traveled`,
`summarize_day`, `summarize_week`, `visits_near`. Privacy-tiered coordinates (`semantic`/`approximate`/`exact`); the default tier is configurable (`TIMELINE_DEFAULT_PRECISION`) and every place carries a Google Maps link when coordinates are shown.

## Project 3 — live-location-mcp (TypeScript, read-only)

A `LiveLocationSource` adapter reads **Google Maps Location Sharing** for a **dedicated
recipient account** (see below), normalizing point **observations** (lat/lng, source
timestamp, accuracy, battery/charging). A **polling daemon** (configurable cadence, default
60 s, exponential backoff, staleness tracking) appends de-duplicated raw observations to its
**own** `live.sqlite`. Retention is 7 days by default and **pruning is manual only**. Tools:
`where_am_i`, `recent_locations`, `where_was_i_recently`, `movement_since`, `location_status`.
These are raw observations — never presented as semantic "visits".

### Recipient-account strategy

```
iPhone / primary Google account  ──shares location indefinitely──▶  dedicated recipient account
                                                                          │
                                                          live-location daemon authenticates
                                                          as the recipient (cookies.txt)
```

The daemon holds only the throwaway recipient account's session, so a cookie leak exposes live
location but not the primary identity/email (T5). Tradeoff: cookie lifetime is unpredictable and
must be re-exported periodically.

## Shared libraries

- **shared/** — env/secrets paths, redacting JSON logger, MCP response conventions
  (source/kind/precision/freshness/limits), geo + timezone-correct time utilities, a
  `node:sqlite` wrapper, and the common authenticated **Streamable HTTP MCP host**
  (OAuth-enforced `/mcp`, RFC 9728 metadata, `/healthz`, loopback + rate limiting).
- **mcp-auth/** — resource-server JWT **verifier** (issuer/sig/exp/aud/scope/subject), Express
  **middleware** + protected-resource metadata, the local **oidc-provider dev AS**, and a
  headless OAuth-flow client used by tests.
- **schemas/** — the timeline-sync ↔ timeline-mcp export contract, the `sync-status.json`
  JSON Schema, and the shared MCP response conventions.

## Optional future component (documented, not built)

`location-router-mcp` — a thin MCP that *routes* a natural-language question to the live or
historical server ("where am I now?" → live; "three months ago?" → historical). It would route,
**not merge**, and is intentionally left unimplemented; two independent MCP servers are
preferred for now.

## Ports (defaults, loopback)

| Service | Port | Endpoint |
|---|---|---|
| dev OAuth AS | 8700 | `/.well-known/oauth-authorization-server`, `/auth`, `/token`, `/jwks`, `/reg` |
| timeline-mcp | 8701 | `/mcp`, `/.well-known/oauth-protected-resource/mcp`, `/healthz` |
| live-location-mcp | 8702 | `/mcp`, `/.well-known/oauth-protected-resource/mcp`, `/healthz` |
