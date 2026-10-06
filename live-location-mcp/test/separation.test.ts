import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("project separation guard", () => {
  it("package.json has no dependency on the Timeline projects", () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
    for (const name of Object.keys(all)) {
      expect(name).not.toMatch(/timeline/i);
    }
    expect(Object.keys(all)).toEqual(expect.arrayContaining(["@location/shared", "@location/mcp-auth"]));
  });

  it("src never imports or names Timeline packages or database files", () => {
    const files = walk(join(root, "src")).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(5);
    const forbidden: [RegExp, string][] = [
      [/timeline-mcp/, "timeline-mcp reference"],
      [/timeline-sync/, "timeline-sync reference"],
      [/from\s+["'][^"']*timeline[^"']*["']/i, "import mentioning timeline"],
      [/timeline[\w-]*\.(sqlite3?|db)\b/i, "timeline database file"],
      [/["'`][^"'`\n]*[\\/]timeline[\\/][^"'`\n]*["'`]/i, "path into a timeline directory"],
      [/join\([^)]*["'`]timeline["'`]/i, "join(... 'timeline' ...)"],
      [/TIMELINE_(MCP_)?DB/, "timeline DB env var"],
    ];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      // the one deliberate mention is the guard in config.ts that REJECTS timeline-looking paths
      const scan = f.endsWith("config.ts") ? text.replace(/\/timeline\/i/g, "").replace(/\^timeline/g, "") : text;
      for (const [re, what] of forbidden) {
        expect(re.test(scan), `${f}: ${what}`).toBe(false);
      }
    }
  });

  it("default DB path lives under its own live-location directory", () => {
    const cfg = readFileSync(join(root, "src", "config.ts"), "utf8");
    expect(cfg).toContain('"live-location", "live.sqlite"');
  });
});
