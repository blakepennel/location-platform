/**
 * SQLite via Node's built-in `node:sqlite` (no native addon to compile on Windows).
 * The module is still flagged experimental in Node 24; we silence only that one warning.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const origEmit = process.emitWarning;
process.emitWarning = function (warning: string | Error, ...args: any[]) {
  const msg = typeof warning === "string" ? warning : warning?.message;
  if (msg && msg.includes("SQLite is an experimental feature")) return;
  return (origEmit as any).call(process, warning, ...args);
} as typeof process.emitWarning;

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export type Database = DatabaseSyncType;

export function openDatabase(path: string, opts: { readOnly?: boolean } = {}): Database {
  if (path !== ":memory:" && !opts.readOnly) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { readOnly: opts.readOnly ?? false });
  if (!opts.readOnly && path !== ":memory:") db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  return db;
}

/** Run fn inside a transaction (BEGIN IMMEDIATE … COMMIT / ROLLBACK). */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
