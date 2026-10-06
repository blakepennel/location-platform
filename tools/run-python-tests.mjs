#!/usr/bin/env node
/** Run the timeline-sync Python test suite using its venv if present, else system python. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "timeline-sync");
if (!existsSync(join(dir, "pyproject.toml"))) {
  console.log("[test:py] no timeline-sync project — skipping");
  process.exit(0);
}
const venvPy = process.platform === "win32"
  ? join(dir, ".venv", "Scripts", "python.exe")
  : join(dir, ".venv", "bin", "python");
const py = existsSync(venvPy) ? venvPy : process.platform === "win32" ? "python" : "python3";

const r = spawnSync(py, ["-m", "pytest", "-q"], { cwd: dir, stdio: "inherit" });
process.exit(r.status ?? 1);
