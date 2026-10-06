import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestIssuer } from "@location/mcp-auth/testing";
import { listenLoopback } from "@location/shared";
import { loadConfig } from "../src/config.ts";
import { createTimelineHttpApp, healthPayload } from "../src/http.ts";
import { TOOL_NAMES } from "../src/tools.ts";
import { NOW, callTool, connectInMemory } from "./helpers/client.ts";
import { CAFE, COORD_KEYS, allKeys, memoryIndex, silentLogger, standardDataset, tmpDir, writeExportFile, writeSyncStatus } from "./helpers/synthetic.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "src", "cli.ts");
const NODE_ARGS = ["--disable-warning=ExperimentalWarning", "--import", "tsx", CLI];
const DAY = { start: "2025-01-02T00:00:00+02:00", end: "2025-01-03T00:00:00+02:00" };

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

describe("MCP over InMemoryTransport (real SDK client)", () => {
  it("initializes, lists 13 read-only tools with input schemas, and answers calls", async () => {
    const idx = memoryIndex();
    const c = await connectInMemory(idx.db, idx.config);
    try {
      expect(c.client.getServerVersion()).toMatchObject({ name: "timeline-mcp" });
      expect(c.client.getInstructions()).toMatch(/NOT real-time/);
      const { tools } = await c.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
      expect(tools).toHaveLength(13);
      for (const t of tools) {
        expect(t.inputSchema.type, t.name).toBe("object");
        expect(t.description!.length, t.name).toBeGreaterThan(20);
        expect(t.annotations, t.name).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      }
      const visitsSchema = tools.find((t) => t.name === "visits")!.inputSchema as any;
      expect(visitsSchema.required).toEqual(expect.arrayContaining(["start", "end"]));
      expect(visitsSchema.properties.precision.enum).toEqual(["semantic", "approximate", "exact"]);

      const status = await c.call("timeline_status");
      expect(status.data.counts.visits).toBe(13);
      const v = await c.call("visits", { ...DAY, place: "cafe" });
      expect(v.data.items).toHaveLength(1);
      const where = await c.call("where_was_i", { timestamp: "2025-01-02T12:00:00+02:00" });
      expect(where.data.match).toBe("exact");
      const day = await c.call("summarize_day", { date: "2025-01-02", timezone: "Etc/GMT-2" });
      expect(day.data.visit_count).toBe(4);
      // unknown tool → protocol-level error, not a crash
      await expect(c.client.callTool({ name: "run_sql", arguments: { sql: "select 1" } })).resolves.toMatchObject({ isError: true });
    } finally {
      await c.close();
      idx.cleanup();
    }
  });
});

describe("MCP over real HTTP with OAuth", () => {
  const idx = memoryIndex(standardDataset(), {});
  let idp: Awaited<ReturnType<typeof createTestIssuer>>;
  let idpSrv: Awaited<ReturnType<Awaited<ReturnType<typeof createTestIssuer>>["listen"]>>;
  let servers: import("node:http").Server[] = [];
  let base = "";
  let resource = "";

  const mint = (o: Record<string, unknown> = {}) =>
    idp.mint({ sub: "owner", aud: resource, scope: "timeline:read", iss: idpSrv.url, ...o } as any);

  const initBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  };
  const post = (token: string | null, body: unknown = initBody) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    idp = await createTestIssuer();
    idpSrv = await idp.listen();
    const port = await freePort();
    base = `http://localhost:${port}`;
    const config = loadConfig({ publicUrl: base, port, dbPath: ":memory:", dataDir: idx.dir });
    const { app, resource: res } = createTimelineHttpApp({
      db: idx.db,
      config,
      logger: silentLogger,
      now: () => NOW,
      auth: { issuer: idpSrv.url, requiredScopes: ["timeline:read"], allowedSubjects: ["owner"] },
    });
    resource = res;
    servers = await listenLoopback(app, port);
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    await idpSrv.close();
    idx.cleanup();
  });

  it("serves protected-resource metadata", async () => {
    const r = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(r.status).toBe(200);
    const meta: any = await r.json();
    expect(meta.resource).toBe(`${base}/mcp`);
    expect(meta.authorization_servers).toEqual([idpSrv.url]);
    expect(meta.scopes_supported).toEqual(["timeline:read"]);
  });

  it("401 with WWW-Authenticate resource_metadata when no token", async () => {
    const r = await post(null);
    expect(r.status).toBe(401);
    const h = r.headers.get("www-authenticate")!;
    expect(h).toContain("Bearer");
    expect(h).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("401 for expired, wrong-audience, wrong-issuer and foreign-key tokens", async () => {
    const expired = await mint({ exp: Math.floor(Date.now() / 1000) - 3600 });
    const r1 = await post(expired);
    expect(r1.status).toBe(401);
    expect(r1.headers.get("www-authenticate")).toMatch(/invalid_token/);
    expect((await post(await mint({ aud: "http://localhost:9/mcp" }))).status).toBe(401);
    expect((await post(await mint({ aud: undefined, scope: "timeline:read" }))).status).toBe(401);
    expect((await post(await mint({ iss: "http://evil.example" }))).status).toBe(401);
    expect((await post(await mint({ foreignKey: true }))).status).toBe(401);
    expect((await post("not-a-jwt")).status).toBe(401);
  });

  it("403 for wrong scope and wrong subject", async () => {
    const scope = await post(await mint({ scope: "location:read" }));
    expect(scope.status).toBe(403);
    expect(scope.headers.get("www-authenticate")).toMatch(/insufficient_scope/);
    const sub = await post(await mint({ sub: "someone-else" }));
    expect(sub.status).toBe(403);
  });

  it("200 with a correct token: SDK client initializes, lists tools and calls several", async () => {
    const token = await mint();
    expect((await post(token)).status).toBe(200);

    const client = new Client({ name: "http-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(13);
      expect(tools.every((t) => t.inputSchema.type === "object")).toBe(true);
      const status = await callTool(client, "timeline_status");
      expect(status.data.counts).toMatchObject({ visits: 13, activities: 6 });
      expect(status.data.freshness_seconds).toBe(3 * 3600);
      const visits = await callTool(client, "visits", { ...DAY, place: "Synthetic Cafe", precision: "approximate" });
      expect(visits.data.items[0].place).toMatchObject({ name: "Synthetic Cafe", latitude: 10.3, longitude: 20.31 });
      const day = await callTool(client, "summarize_day", { date: "2025-01-02", timezone: "Etc/GMT-2" });
      expect(day.data.places_visited[0].name).toBe("Synthetic Home");
      expect([...allKeys(day.data)].filter((k) => COORD_KEYS.test(k))).toEqual([]);
      const bad = await callTool(client, "visits", { start: DAY.end, end: DAY.start });
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("/healthz is unauthenticated and contains no coordinates, names or paths", async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    const text = await r.text();
    const body = JSON.parse(text);
    expect(body).toMatchObject({
      status: "ok",
      index_present: true,
      counts: { visits: 13, activities: 6, timeline_paths: 2, trips: 1 },
    });
    expect(typeof body.newest_record_age_seconds).toBe("number");
    expect(Object.keys(body).sort()).toEqual(["counts", "index_present", "last_sync_age_seconds", "newest_record_age_seconds", "service", "status"]);
    expect(text).not.toMatch(/Synthetic|\b(10|20)\.\d{2,}|latitude|longitude|address|Timeline\.json/i);
    expect(text).not.toContain(CAFE.name);
  });

  it("healthPayload reports no_data on an empty index", () => {
    const empty = memoryIndex([]);
    expect(healthPayload(empty.db, NOW)).toMatchObject({ status: "no_data", index_present: false, newest_record_age_seconds: null });
    empty.cleanup();
  });
});

describe("CLI", () => {
  it("index + status via the real CLI (temp DB, synthetic export)", () => {
    const t = tmpDir();
    try {
      const file = writeExportFile(t.dir, standardDataset());
      writeSyncStatus(t.dir, { schema_version: 1, source: "google_timeline", adapter: "synthetic", last_attempt_at: "2025-03-10T23:30:00Z", last_success_at: "2025-03-10T23:00:00Z", consecutive_failures: 0, auth: { state: "ok" } });
      const env = { ...process.env, TIMELINE_MCP_DB: join(t.dir, "idx.sqlite"), TIMELINE_DATA_DIR: t.dir, LOCATION_PLATFORM_HOME: t.dir };
      const run = (...args: string[]) => spawnSync(process.execPath, [...NODE_ARGS, ...args], { env, encoding: "utf8" });

      const empty = run("status");
      expect(JSON.parse(empty.stdout)).toMatchObject({ health: "no_data", index: { present: false } });
      expect(existsSync(join(t.dir, "idx.sqlite"))).toBe(false); // status never creates an index

      const first = run("index", "--file", file);
      expect(first.status, first.stderr).toBe(0);
      const r1 = JSON.parse(first.stdout);
      expect(r1).toMatchObject({ status: "imported", valid: 22, skipped: 0, totals: { visit: 13, activity: 6, timeline_path: 2, trip: 1, place: 7 } });
      expect(first.stdout).not.toMatch(/Synthetic/); // summary only, no place names

      const again = JSON.parse(run("index").stdout); // default path = $TIMELINE_DATA_DIR/current/Timeline.json
      expect(again.status).toBe("unchanged");

      const status = JSON.parse(run("status").stdout);
      expect(status.counts).toMatchObject({ visits: 13, trips: 1 });
      expect(status.sync.last_success_at).toBe("2025-03-10T23:00:00Z");

      const bad = run("index", "--file", join(t.dir, "missing.json"));
      expect(bad.status).toBe(1);
      expect(run("bogus").status).toBe(2);
    } finally {
      t.cleanup();
    }
  }, 30_000);

  it("stdio subcommand serves MCP to a real stdio client and auto-indexes on start", async () => {
    const t = tmpDir();
    const file = writeExportFile(t.dir, standardDataset());
    void file;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: NODE_ARGS.concat("stdio"),
      env: { ...(process.env as Record<string, string>), TIMELINE_MCP_DB: join(t.dir, "idx.sqlite"), TIMELINE_DATA_DIR: t.dir, LOCATION_PLATFORM_HOME: t.dir },
      stderr: "ignore",
    });
    const client = new Client({ name: "stdio-test", version: "0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(13);
      const r = await callTool(client, "visits", { ...DAY, place: "cafe" });
      expect(r.data.items).toHaveLength(1);
    } finally {
      await client.close();
      t.cleanup();
    }
  }, 30_000);
});
