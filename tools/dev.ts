/**
 * Local dev orchestrator: starts the OAuth server, the historical MCP and the live MCP,
 * waits for health, then prints the URLs + a login hint. Ctrl-C stops everything.
 *
 *   npm run dev
 *
 * SQLite stays local; nothing is exposed beyond loopback. This runs the apps directly on
 * the host (recommended, so private Google credentials never enter a container).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEnv, envInt } from "@location/shared";

loadEnv();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUN = (rel: string, args: string[]) => [process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(ROOT, rel), ...args]] as const;

const AUTH_PORT = envInt("DEV_AUTH_PORT", 8700);
const TL_PORT = envInt("TIMELINE_MCP_PORT", 8701);
const LIVE_PORT = envInt("LIVE_MCP_PORT", 8702);

interface Svc { name: string; cmd: readonly [string, string[]]; port: number; healthPath: string }
const services: Svc[] = [
  { name: "dev-auth", cmd: RUN("mcp-auth/src/dev-server/cli.ts", []), port: AUTH_PORT, healthPath: "/healthz" },
  { name: "timeline-mcp", cmd: RUN("timeline-mcp/src/cli.ts", ["serve"]), port: TL_PORT, healthPath: "/healthz" },
  { name: "live-location-mcp", cmd: RUN("live-location-mcp/src/cli.ts", ["serve"]), port: LIVE_PORT, healthPath: "/healthz" },
];

const children: ChildProcess[] = [];
let shuttingDown = false;

function start(s: Svc): ChildProcess {
  const [bin, args] = s.cmd;
  const child = spawn(bin, args, { cwd: ROOT, env: process.env, stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`\n[dev] ${s.name} exited unexpectedly (code ${code}); shutting down.`);
      shutdown(1);
    }
  });
  children.push(child);
  return child;
}

async function waitHealthy(s: Svc, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}${s.healthPath}`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error("\n[dev] stopping services…");
  for (const c of children) c.kill("SIGINT");
  setTimeout(() => process.exit(code), 800).unref();
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

for (const s of services) {
  start(s);
}
let ok = true;
for (const s of services) {
  const healthy = await waitHealthy(s);
  console.error(`[dev] ${s.name}: ${healthy ? "healthy" : "NOT healthy"} (http://localhost:${s.port})`);
  ok &&= healthy;
}

console.error(`
──────────────────────────────────────────────────────────────
 location-platform dev environment ${ok ? "ready" : "started WITH ERRORS"}
──────────────────────────────────────────────────────────────
 OAuth (IdP)     http://localhost:${AUTH_PORT}
   discovery     http://localhost:${AUTH_PORT}/.well-known/oauth-authorization-server
 Timeline MCP    http://localhost:${TL_PORT}/mcp      (scope timeline:read)
   metadata      http://localhost:${TL_PORT}/.well-known/oauth-protected-resource/mcp
 Live MCP        http://localhost:${LIVE_PORT}/mcp      (scope location:read)
   metadata      http://localhost:${LIVE_PORT}/.well-known/oauth-protected-resource/mcp
 Health          /healthz on each port

 Connect an MCP client to a /mcp URL; it will discover the OAuth server and open a
 browser sign-in (dev account: ${process.env.DEV_AUTH_SUBJECT ?? "local-dev-user"}).
 Ctrl-C to stop.
──────────────────────────────────────────────────────────────
`);
if (!ok) shutdown(1);
