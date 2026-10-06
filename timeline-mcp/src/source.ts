/**
 * The only seam between the indexer/tools and wherever historical location data comes from.
 * Nothing above this file knows about Geller, ODLH or Google internals — it only sees
 * "semantic segments" in the timeline-sync export contract (schemas/TIMELINE_EXPORT_CONTRACT.md).
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export type RawSegment = Record<string, unknown>;

export interface ExportMeta {
  generator?: string;
  upstreamCommit?: string;
  generatedAt?: string;
  adapter?: string;
}

export interface ExportData {
  segments: RawSegment[];
  exportMeta?: ExportMeta;
  sourcePath: string;
  sha256: string;
}

/** Mirrors schemas/sync-status.schema.json. Unknown fields are tolerated and ignored. */
export interface SyncStatus {
  schema_version?: number;
  source?: string;
  adapter?: string;
  last_attempt_at?: string;
  last_success_at?: string | null;
  last_cloud_request_at?: string | null;
  last_error?: { at?: string; stage?: string; message?: string } | null;
  consecutive_failures?: number;
  sync_duration_seconds?: number | null;
  record_counts?: Record<string, number> | null;
  oldest_record_start?: string | null;
  newest_record_end?: string | null;
  newest_cloud_mutation_at?: string | null;
  auth?: { state?: string; checked_at?: string | null; master_token_present?: boolean; key_present?: boolean };
  output?: { current_export?: string; export_sha256?: string; enriched?: boolean; published_at?: string } | null;
}

export interface HistoricalLocationSource {
  /** Read and parse the whole export. Throws ExportFormatError / ExportMissingError. */
  readExport(): Promise<ExportData>;
  /** Sync health metadata, or null when unavailable/unreadable. */
  readSyncStatus(): Promise<SyncStatus | null>;
  /** Cheap change detector (e.g. mtime:size); null when the export does not exist. */
  fingerprint(): Promise<string | null>;
}

export class ExportFormatError extends Error {
  override name = "ExportFormatError";
}
export class ExportMissingError extends Error {
  override name = "ExportMissingError";
}

/** Validate the top-level shape and split off exportMeta. Does not validate individual segments. */
export function parseExportDocument(text: string): { segments: RawSegment[]; exportMeta?: ExportMeta } {
  let doc: unknown;
  try {
    doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new ExportFormatError("export is not valid JSON");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray((doc as any).semanticSegments)) {
    throw new ExportFormatError("export must be a JSON object with a semanticSegments array");
  }
  const rawMeta = (doc as any).exportMeta;
  let exportMeta: ExportMeta | undefined;
  if (rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)) {
    const pick = (k: string) => (typeof rawMeta[k] === "string" ? String(rawMeta[k]).slice(0, 200) : undefined);
    exportMeta = {
      generator: pick("generator"),
      upstreamCommit: pick("upstreamCommit"),
      generatedAt: pick("generatedAt"),
      adapter: pick("adapter"),
    };
  }
  return { segments: (doc as any).semanticSegments as RawSegment[], exportMeta };
}

export interface TimelineSyncFileSourceOptions {
  /** $TIMELINE_DATA_DIR */
  dataDir: string;
  /** Explicit export file (overrides <dataDir>/current/Timeline.json). */
  file?: string;
}

export class TimelineSyncFileSource implements HistoricalLocationSource {
  readonly exportPath: string;
  readonly statusPath: string;

  constructor(opts: TimelineSyncFileSourceOptions) {
    this.exportPath = opts.file ?? join(opts.dataDir, "current", "Timeline.json");
    this.statusPath = join(opts.dataDir, "state", "sync-status.json");
  }

  async readExport(): Promise<ExportData> {
    let buf: Buffer;
    try {
      buf = await readFile(this.exportPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new ExportMissingError("export file not found");
      throw new ExportMissingError("export file could not be read");
    }
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const { segments, exportMeta } = parseExportDocument(buf.toString("utf8"));
    return { segments, exportMeta, sourcePath: this.exportPath, sha256 };
  }

  async readSyncStatus(): Promise<SyncStatus | null> {
    try {
      const doc = JSON.parse((await readFile(this.statusPath, "utf8")).replace(/^﻿/, ""));
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
      return doc as SyncStatus;
    } catch {
      return null;
    }
  }

  async fingerprint(): Promise<string | null> {
    try {
      const s = await stat(this.exportPath);
      return `${Math.round(s.mtimeMs)}:${s.size}`;
    } catch {
      return null;
    }
  }
}
