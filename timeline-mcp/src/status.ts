/** Status report shared by the timeline_status tool and the `status` CLI command. No coordinates, no place names. */
import { freshnessSeconds } from "@location/shared";
import { getMeta, getMetaJson, type Database } from "./db.ts";
import { sanitizeMessage, tableCounts } from "./indexer.ts";
import { iso } from "./present.ts";
import * as Q from "./queries.ts";
import type { ExportMeta, SyncStatus } from "./source.ts";

export function buildStatus(db: Database, nowMs: number): Record<string, unknown> {
  const now = () => nowMs;
  const counts = tableCounts(db);
  const cov = Q.coverage(db);
  const sync = getMetaJson<SyncStatus>(db, "sync_status");
  const importMeta = getMetaJson<ExportMeta>(db, "last_import_meta");
  const importErr = getMetaJson<{ at: string; message: string }>(db, "last_import_error");
  const lastImportAt = getMeta(db, "last_import_at");
  const present = lastImportAt !== null;
  const t = now();
  const age = (s: string | null | undefined) => freshnessSeconds(s ?? null, t);

  const authState = sync?.auth?.state ?? null;
  const lastErr = sync?.last_error
    ? {
        at: sync.last_error.at ?? null,
        stage: sync.last_error.stage ?? "unknown",
        message: sanitizeMessage(String(sync.last_error.message ?? ""), 200),
      }
    : null;
  const lastSuccessAge = age(sync?.last_success_at);
  let health: string;
  if (!present || counts.visit + counts.activity + counts.timeline_path + counts.trip === 0) health = "no_data";
  else if ((sync?.consecutive_failures ?? 0) > 0 || (authState && !["ok", "unknown"].includes(authState)) || importErr) health = "degraded";
  else if (lastSuccessAge !== null && lastSuccessAge > 48 * 3600) health = "stale";
  else health = "ok";

  const publishedAt = sync?.output?.published_at ?? null;
  const exportSha = getMeta(db, "last_import_sha256");
  const indexBehind =
    sync?.output?.export_sha256 && exportSha ? sync.output.export_sha256 !== exportSha : null;

  return {
    health,
    index: {
      present,
      last_import_at: lastImportAt,
      last_import_age_seconds: age(lastImportAt),
      export_sha256_prefix: exportSha ? exportSha.slice(0, 12) : null,
      generator: importMeta?.generator ?? null,
      upstream_commit: importMeta?.upstreamCommit ?? null,
      adapter: importMeta?.adapter ?? null,
      export_generated_at: importMeta?.generatedAt ?? null,
      last_import_error: importErr ? { at: importErr.at, message: importErr.message } : null,
    },
    counts: {
      places: counts.place,
      visits: counts.visit,
      activities: counts.activity,
      timeline_paths: counts.timeline_path,
      trips: counts.trip,
    },
    coverage: {
      oldest_start: cov.oldest_ms === null ? null : iso(cov.oldest_ms, cov.oldest_offset_min),
      newest_end: cov.newest_ms === null ? null : iso(cov.newest_ms, cov.newest_offset_min),
    },
    newest_record:
      cov.newest_ms === null ? null : { kind: cov.newest_kind, end_time: iso(cov.newest_ms, cov.newest_offset_min) },
    sync: sync
      ? {
          adapter: sync.adapter ?? null,
          last_attempt_at: sync.last_attempt_at ?? null,
          last_success_at: sync.last_success_at ?? null,
          last_cloud_request_at: sync.last_cloud_request_at ?? null,
          consecutive_failures: sync.consecutive_failures ?? 0,
          sync_duration_seconds: sync.sync_duration_seconds ?? null,
          newest_cloud_mutation_at: sync.newest_cloud_mutation_at ?? null,
          published_at: publishedAt,
        }
      : null,
    lag: {
      newest_record_age_seconds: cov.newest_ms === null ? null : freshnessSeconds(new Date(cov.newest_ms).toISOString(), t),
      last_sync_age_seconds: lastSuccessAge,
      last_cloud_request_age_seconds: age(sync?.last_cloud_request_at),
      index_behind_latest_sync: indexBehind,
    },
    auth: sync ? { state: authState, checked_at: sync.auth?.checked_at ?? null } : null,
    last_error: lastErr,
    notes: [
      "Google Timeline is NOT real-time: the phone backs its data up hours to a day late, so the newest movements may be missing.",
      "Records are Google's semantic reconstruction (visits, activities, trips), not raw GPS observations.",
    ],
  };
}
