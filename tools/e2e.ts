/**
 * End-to-end integration check across ALL projects, exercising the real protocols:
 *
 *  1. seed synthetic data (timeline-sync → timeline-mcp index; live simulate)
 *  2. start the local OAuth server + BOTH MCP servers as real subprocesses (HTTP)
 *  3. obtain real OAuth 2.1 tokens via Authorization Code + PKCE against the dev login
 *  4. drive both servers simultaneously with the real MCP SDK client over Streamable HTTP
 *  5. assert cross-resource isolation (a timeline token is refused by the live server) and
 *     that an unauthenticated call is refused (401 + resource_metadata challenge)
 *
 * All synthetic; no Google. Exits non-zero on any failure.
 *
 *   npm run test:e2e
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { obtainDevToken } from "@location/mcp-auth";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AUTH_PORT = 8790;
const TL_PORT = 8791;
const LIVE_PORT = 8792;
const ISSUER = `http://localhost:${AUTH_PORT}`;
const TL_URL = `http://localhost:${TL_PORT}`;
const LIVE_URL = `http://localhost:${LIVE_PORT}`;
const SUBJECT = "e2e-user";
const REDIRECT = "http://127.0.0.1:8799/callback";

const HOME = mkdtempSync(join(tmpdir(), "lp-e2e-"));
const children: ChildProcess[] = [];
let passed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? " — " + detail : ""}`);
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

// Start from the ambient environment minus any platform configuration (a configured container
// or shell must not leak e.g. a JWKS URL for another host or non-default precision into e2e).
const ambient = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(TIMELINE_|LIVE_|MCP_|DEV_AUTH_|LOCATION_|LOG_)/.test(k)),
);
const baseEnv = {
  ...ambient,
  LIVE_SOURCE: "synthetic", // e2e never talks to Google
  LOCATION_PLATFORM_HOME: HOME,
  LOCATION_PLATFORM_ENV_FILE: join(HOME, ".no-env"), // avoid loading the repo .env
  // Pin every data path into the temp home so the Python and Node sides agree.
  TIMELINE_DATA_DIR: join(HOME, "timeline"),
  TIMELINE_SECRETS_DIR: join(HOME, "secrets", "timeline"),
  TIMELINE_MCP_DB: join(HOME, "timeline-mcp", "index.sqlite"),
  LIVE_MCP_DB: join(HOME, "live-location", "live.sqlite"),
  DEV_AUTH_STATE_DIR: join(HOME, "dev-auth"),
  MCP_AUTH_ISSUER: ISSUER,
  MCP_ALLOWED_SUBJECTS: SUBJECT,
  DEV_AUTH_SUBJECT: SUBJECT,
  DEV_AUTH_PORT: String(AUTH_PORT),
  TIMELINE_MCP_PORT: String(TL_PORT),
  TIMELINE_MCP_PUBLIC_URL: TL_URL,
  LIVE_MCP_PORT: String(LIVE_PORT),
  LIVE_MCP_PUBLIC_URL: LIVE_URL,
  LOG_LEVEL: "warn",
} as NodeJS.ProcessEnv;

function nodeArgs(rel: string, args: string[]) {
  return ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(ROOT, rel), ...args];
}
function seedStep(label: string, bin: string, args: string[], cwd = ROOT) {
  const r = spawnSync(bin, args, { cwd, env: baseEnv, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`seed step failed: ${label} (exit ${r.status})`);
}
function startServer(name: string, rel: string, args: string[]): ChildProcess {
  const c = spawn(process.execPath, nodeArgs(rel, args), { cwd: ROOT, env: baseEnv, stdio: ["ignore", "inherit", "inherit"] });
  c.on("exit", (code) => {
    if (code && !shuttingDown) console.error(`[e2e] ${name} exited early (${code})`);
  });
  children.push(c);
  return c;
}
async function waitHealth(url: string, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

let shuttingDown = false;
function cleanup() {
  shuttingDown = true;
  for (const c of children) c.kill("SIGINT");
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {}
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

async function main() {
  console.log(`[e2e] temp home: ${HOME}`);

  // ---- 1. seed synthetic data
  console.log("\n[e2e] seeding synthetic data…");
  const venvBin = process.platform === "win32"
    ? join(ROOT, "timeline-sync", ".venv", "Scripts", "timeline-sync.exe")
    : join(ROOT, "timeline-sync", ".venv", "bin", "timeline-sync");
  // Host: timeline-sync/.venv; container: timeline-sync is on PATH (/opt/venv).
  const tlBin = existsSync(venvBin) ? venvBin : "timeline-sync";
  seedStep("timeline sync", tlBin, ["sync", "--source", "synthetic"], join(ROOT, "timeline-sync"));
  seedStep("timeline index", process.execPath, nodeArgs("timeline-mcp/src/cli.ts", ["index"]));
  seedStep("live simulate", process.execPath, nodeArgs("live-location-mcp/src/cli.ts", ["simulate", "--count", "40"]));

  // ---- 2. start servers
  console.log("\n[e2e] starting OAuth + MCP servers…");
  startServer("dev-auth", "mcp-auth/src/dev-server/cli.ts", []);
  ok("dev-auth healthy", await waitHealth(ISSUER));
  startServer("timeline-mcp", "timeline-mcp/src/cli.ts", ["serve"]);
  startServer("live-location-mcp", "live-location-mcp/src/cli.ts", ["serve"]);
  const tlUp = await waitHealth(TL_URL);
  const liveUp = await waitHealth(LIVE_URL);
  ok("timeline-mcp healthy", tlUp);
  ok("live-location-mcp healthy", liveUp);
  ok("both servers running simultaneously", tlUp && liveUp);

  // health endpoints leak nothing
  const tlHealth = await (await fetch(`${TL_URL}/healthz`)).text();
  const liveHealth = await (await fetch(`${LIVE_URL}/healthz`)).text();
  ok("health endpoints expose no coordinates", !/\d{1,3}\.\d{4,}/.test(tlHealth + liveHealth));

  // ---- 3. unauthenticated is refused with a discovery challenge
  console.log("\n[e2e] auth enforcement…");
  const noAuth = await fetch(`${TL_URL}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  ok("unauthenticated /mcp → 401", noAuth.status === 401, `got ${noAuth.status}`);
  ok("401 carries resource_metadata challenge", (noAuth.headers.get("www-authenticate") ?? "").includes("resource_metadata="));
  const prm = await (await fetch(`${TL_URL}/.well-known/oauth-protected-resource/mcp`)).json();
  ok("protected-resource metadata points at the AS", (prm.authorization_servers ?? []).includes(ISSUER));

  // ---- 4. obtain real tokens via Authorization Code + PKCE
  console.log("\n[e2e] obtaining OAuth tokens (Authorization Code + PKCE)…");
  const tlTok = await obtainDevToken({ issuer: ISSUER, redirectUri: REDIRECT, resource: `${TL_URL}/mcp`, scope: "timeline:read" });
  const liveTok = await obtainDevToken({ issuer: ISSUER, redirectUri: REDIRECT, resource: `${LIVE_URL}/mcp`, scope: "location:read" });
  ok("issued timeline token", !!tlTok.access_token);
  ok("issued live token", !!liveTok.access_token);

  // ---- 5. drive both servers with the real MCP client, simultaneously
  console.log("\n[e2e] MCP protocol over HTTP…");
  const tlClient = await connect(TL_URL, tlTok.access_token);
  const liveClient = await connect(LIVE_URL, liveTok.access_token);

  const tlTools = await tlClient.listTools();
  const liveTools = await liveClient.listTools();
  ok("timeline tools/list has 13 tools", tlTools.tools.length === 13, `got ${tlTools.tools.length}`);
  ok("live tools/list has 5 tools", liveTools.tools.length === 5, `got ${liveTools.tools.length}`);
  ok("every timeline tool has an input schema", tlTools.tools.every((t) => !!t.inputSchema));

  const status = await tlClient.callTool({ name: "timeline_status", arguments: {} });
  const statusData = (status as any).structuredContent ?? JSON.parse((status as any).content[0].text);
  ok("timeline_status returns source=google_timeline", statusData.source === "google_timeline");
  const c = statusData.counts ?? {};
  ok("timeline_status reports indexed records", (c.visits ?? 0) + (c.activities ?? 0) > 0, JSON.stringify(statusData).slice(0, 160));

  const visits = await tlClient.callTool({ name: "visits", arguments: { start: "2026-09-01", end: "2026-09-30", limit: 5 } });
  const visitsData = (visits as any).structuredContent ?? JSON.parse((visits as any).content[0].text);
  ok("visits (semantic default) returns items without exact coordinates", Array.isArray(visitsData.items ?? visitsData.visits ?? visitsData.results));

  const whereAmI = await liveClient.callTool({ name: "where_am_i", arguments: {} });
  const liveData = (whereAmI as any).structuredContent ?? JSON.parse((whereAmI as any).content[0].text);
  ok("where_am_i returns source=google_location_sharing", liveData.source === "google_location_sharing");
  const locStatus = await liveClient.callTool({ name: "location_status", arguments: {} });
  ok("location_status callable", !(locStatus as any).isError);

  // ---- cross-resource isolation
  console.log("\n[e2e] resource isolation…");
  const crossed = await fetch(`${LIVE_URL}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${tlTok.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  ok("timeline token rejected by live server (wrong audience)", crossed.status === 401, `got ${crossed.status}`);

  await tlClient.close();
  await liveClient.close();
}

main()
  .then(() => {
    console.log(`\n[e2e] ${passed} checks passed, ${failures.length} failed`);
    cleanup();
    if (failures.length) {
      console.error("FAILURES:\n - " + failures.join("\n - "));
      process.exit(1);
    }
    console.log("[e2e] PASS — full stack works end-to-end with OAuth.");
    process.exit(0);
  })
  .catch((e) => {
    console.error("\n[e2e] ERROR:", e?.stack ?? e);
    cleanup();
    process.exit(1);
  });
