import { openDatabase, type Database } from "@location/shared";

export type { Database };

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS places (
  place_key TEXT PRIMARY KEY,
  place_id TEXT,
  feature_id TEXT,
  name TEXT,
  address TEXT,
  category TEXT,
  semantic_type TEXT,
  semantic_type_code INTEGER,
  place_type_code INTEGER,
  lat REAL,
  lng REAL,
  first_seen INTEGER,      -- epoch ms of the earliest visit start
  last_seen INTEGER,       -- epoch ms of the latest visit end
  visit_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_places_name ON places(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_places_place_id ON places(place_id);
CREATE INDEX IF NOT EXISTS idx_places_feature_id ON places(feature_id);
CREATE INDEX IF NOT EXISTS idx_places_semantic ON places(semantic_type);

CREATE TABLE IF NOT EXISTS visits (
  segment_id TEXT PRIMARY KEY,
  place_key TEXT REFERENCES places(place_key),
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  start_offset_min INTEGER NOT NULL DEFAULT 0,
  end_offset_min INTEGER NOT NULL DEFAULT 0,
  start_iso TEXT NOT NULL,
  end_iso TEXT NOT NULL,
  probability REAL,
  candidate_probability REAL,
  semantic_type TEXT,
  is_confirmed INTEGER NOT NULL DEFAULT 0,
  finalization_status INTEGER,
  source INTEGER,
  import_id INTEGER,
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visits_start ON visits(start_ms);
CREATE INDEX IF NOT EXISTS idx_visits_end ON visits(end_ms);
CREATE INDEX IF NOT EXISTS idx_visits_place ON visits(place_key, start_ms);

CREATE TABLE IF NOT EXISTS activities (
  segment_id TEXT PRIMARY KEY,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  start_offset_min INTEGER NOT NULL DEFAULT 0,
  end_offset_min INTEGER NOT NULL DEFAULT 0,
  mode TEXT,
  mode_code INTEGER,
  mode_probability REAL,
  distance_m REAL,
  start_lat REAL, start_lng REAL,
  end_lat REAL, end_lng REAL,
  finalization_status INTEGER,
  source INTEGER,
  import_id INTEGER,
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_start ON activities(start_ms);
CREATE INDEX IF NOT EXISTS idx_activities_end ON activities(end_ms);
CREATE INDEX IF NOT EXISTS idx_activities_mode ON activities(mode);

CREATE TABLE IF NOT EXISTS timeline_paths (
  segment_id TEXT PRIMARY KEY,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  start_offset_min INTEGER NOT NULL DEFAULT 0,
  end_offset_min INTEGER NOT NULL DEFAULT 0,
  point_count INTEGER NOT NULL DEFAULT 0,
  points_json TEXT NOT NULL,   -- compact [[lat,lng,offset_min_from_start|null],...]
  import_id INTEGER,
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paths_start ON timeline_paths(start_ms);
CREATE INDEX IF NOT EXISTS idx_paths_end ON timeline_paths(end_ms);

CREATE TABLE IF NOT EXISTS trips (
  segment_id TEXT PRIMARY KEY,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  start_offset_min INTEGER NOT NULL DEFAULT 0,
  end_offset_min INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  import_id INTEGER,
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trips_start ON trips(start_ms);
CREATE INDEX IF NOT EXISTS idx_trips_end ON trips(end_ms);

CREATE TABLE IF NOT EXISTS sync_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256 TEXT NOT NULL,
  source_path TEXT,
  imported_at TEXT NOT NULL,
  generator TEXT,
  upstream_commit TEXT,
  adapter TEXT,
  export_generated_at TEXT,
  visit_count INTEGER NOT NULL DEFAULT 0,
  activity_count INTEGER NOT NULL DEFAULT 0,
  path_count INTEGER NOT NULL DEFAULT 0,
  trip_count INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT
);
`;

/** Open (creating if needed) the index database. Pass ":memory:" for tests. */
export function openIndexDb(path: string): Database {
  const db = openDatabase(path);
  const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (v > SCHEMA_VERSION) throw new Error(`index database schema v${v} is newer than this build (v${SCHEMA_VERSION})`);
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

export function getMeta(db: Database, key: string): string | null {
  const r = db.prepare("SELECT value FROM sync_metadata WHERE key = ?").get(key) as { value: string } | undefined;
  return r ? r.value : null;
}

export function setMeta(db: Database, key: string, value: string | null): void {
  if (value === null) db.prepare("DELETE FROM sync_metadata WHERE key = ?").run(key);
  else
    db.prepare("INSERT INTO sync_metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      key,
      value,
    );
}

export function getMetaJson<T>(db: Database, key: string): T | null {
  const v = getMeta(db, key);
  if (v === null) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

export function setMetaJson(db: Database, key: string, value: unknown): void {
  setMeta(db, key, value === null ? null : JSON.stringify(value));
}
