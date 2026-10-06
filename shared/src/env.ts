import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

let loaded = false;

/** Load the workspace .env (if present) without overriding real environment variables. */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const explicit = process.env.LOCATION_PLATFORM_ENV_FILE;
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    candidates.push(join(dir, ".env"));
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const f of candidates) {
    if (existsSync(f)) {
      const before = { ...process.env };
      try {
        process.loadEnvFile(f);
      } catch {
        continue;
      }
      // Real environment variables win over .env values.
      for (const [k, v] of Object.entries(before)) if (v !== undefined) process.env[k] = v;
      return;
    }
  }
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/** Root for real data + secrets, always outside the git checkout. */
export function platformHome(): string {
  return resolve(expandHome(process.env.LOCATION_PLATFORM_HOME ?? "~/.location-platform"));
}

export function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number`);
  return n;
}

export function envBool(name: string, def = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}
