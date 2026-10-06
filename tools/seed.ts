/**
 * Seed both MCP data stores with SYNTHETIC data for local development.
 *   npm run seed
 * - timeline-sync: `sync --source synthetic` → publishes current/Timeline.json under $TIMELINE_DATA_DIR
 * - timeline-mcp: index that export into its own SQLite index
 * - live-location-mcp: `simulate` synthetic observations into live.sqlite
 * Nothing touches Google. Uses $LOCATION_PLATFORM_HOME (default ~/.location-platform).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEnv } from "@location/shared";

loadEnv();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const node = (rel: string, args: string[]) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(ROOT, rel), ...args], {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  });

function run(label: string, r: ReturnType<typeof spawnSync>) {
  if (r.status !== 0) {
    console.error(`[seed] ${label} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
  console.error(`[seed] ${label} ok`);
}

// 1. Timeline export (Python). Prefer the venv console script.
const tlDir = join(ROOT, "timeline-sync");
const venvBin = process.platform === "win32" ? join(tlDir, ".venv", "Scripts", "timeline-sync.exe") : join(tlDir, ".venv", "bin", "timeline-sync");
// Host: timeline-sync/.venv; container: timeline-sync is on PATH (/opt/venv).
const tlBin = existsSync(venvBin) ? venvBin : "timeline-sync";
const r = spawnSync(tlBin, ["sync", "--source", "synthetic"], { cwd: tlDir, env: process.env, stdio: "inherit" });
if (r.error) {
  console.error("[seed] timeline-sync not found — run: cd timeline-sync && python -m venv .venv && .venv/Scripts/pip install -e .[dev]");
  process.exit(1);
}
run("timeline-sync sync --source synthetic", r);

// 2. Index into timeline-mcp
run("timeline-mcp index", node("timeline-mcp/src/cli.ts", ["index"]));

// 3. Synthetic live observations
run("live-location simulate", node("live-location-mcp/src/cli.ts", ["simulate", "--count", process.env.SEED_LIVE_COUNT ?? "60"]));

console.error("\n[seed] done. Start the servers with `npm run dev`.");
