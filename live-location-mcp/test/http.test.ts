import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createTestIssuer } from "@location/mcp-auth/testing";
import { createLiveHttpApp } from "../src/http.ts";
import { PERSON, memDb, obs, silentLogger, testConfig } from "./helpers.ts";

const SUB = "owner-sub";
let httpServer: Server;
let issuerHandle: { url: string; close: () => Promise<void> };
let issuer: Awaited<ReturnType<typeof createTestIssuer>>;
let base = "";
let resource = "";

const db = memDb();
const SECRET_ADDRESS = "42 Secret Address Lane";

beforeAll(async () => {
  const probe = await new Promise<Server>((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => r(s));
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  base = `http://127.0.0.1:${port}`;
  resource = `${base}/mcp`;

  issuer = await createTestIssuer();
  issuerHandle = await issuer.listen();

  const now = Date.now();
  db.insertObservations(
    Array.from({ length: 5 }, (_, i) => obs(now - (5 - i) * 60_000, 10.1 + i * 0.001, 20.1, { address: SECRET_ADDRESS })),
    now,
  );
  db.setMeta("auth_state", "ok");

  const config = testConfig({ publicUrl: base });
  const { app } = createLiveHttpApp(
    db,
    config,
    { auth: { issuer: issuerHandle.url, requiredScopes: ["location:read"], allowedSubjects: [SUB] } },
    silentLogger,
  );
  httpServer = app.listen(port, "127.0.0.1");
  await new Promise((r) => httpServer.once("listening", r));
});

afterAll(async () => {
  await new Promise<void>((r) => httpServer.close(() => r()));
  await issuerHandle.close();
});

const initBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

async function rawPost(token?: string) {
  return fetch(resource, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(initBody),
  });
}

const mint = (o: Parameters<typeof issuer.mint>[0]) => issuer.mint({ iss: issuerHandle.url, ...o });
const good = () => mint({ sub: SUB, aud: resource, scope: "location:read" });

describe("HTTP authorization", () => {
  it("missing token -> 401 with resource_metadata challenge", async () => {
    const r = await rawPost();
    expect(r.status).toBe(401);
    const h = r.headers.get("www-authenticate") ?? "";
    expect(h).toMatch(/^Bearer /);
    expect(h).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("expired token -> 401", async () => {
    const t = await mint({ sub: SUB, aud: resource, scope: "location:read", exp: Math.floor(Date.now() / 1000) - 3600 });
    expect((await rawPost(t)).status).toBe(401);
  });

  it("wrong audience -> 401", async () => {
    const t = await mint({ sub: SUB, aud: "http://127.0.0.1:1/mcp", scope: "location:read" });
    expect((await rawPost(t)).status).toBe(401);
  });

  it("untrusted signing key -> 401", async () => {
    const t = await mint({ sub: SUB, aud: resource, scope: "location:read", foreignKey: true });
    expect((await rawPost(t)).status).toBe(401);
  });

  it("wrong scope (timeline:read) -> 403", async () => {
    const t = await mint({ sub: SUB, aud: resource, scope: "timeline:read" });
    expect((await rawPost(t)).status).toBe(403);
  });

  it("wrong subject -> 403", async () => {
    const t = await mint({ sub: "someone-else", aud: resource, scope: "location:read" });
    expect((await rawPost(t)).status).toBe(403);
  });

  it("correct token -> 200", async () => {
    const r = await rawPost(await good());
    expect(r.status).toBe(200);
  });

  it("serves RFC 9728 protected-resource metadata without auth", async () => {
    const j = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(j.resource).toBe(resource);
    expect(j.scopes_supported).toEqual(["location:read"]);
    expect(j.authorization_servers).toEqual([issuerHandle.url]);
  });
});

describe("MCP over real HTTP", () => {
  async function client() {
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { Authorization: `Bearer ${await good()}` } } }));
    return c;
  }

  it("initialize, tools/list, and tool calls", async () => {
    const c = await client();
    try {
      expect(c.getServerVersion()?.name).toBe("live-location-mcp");
      const { tools } = await c.listTools();
      expect(tools).toHaveLength(5);
      for (const t of tools) expect(t.inputSchema.type).toBe("object");

      const w = (await c.callTool({ name: "where_am_i", arguments: {} })) as any;
      expect(w.structuredContent.kind).toBe("observation");
      expect(w.structuredContent.latitude).toBeCloseTo(10.104, 6);
      expect(w.structuredContent.longitude).toBeCloseTo(20.1, 6);
      expect(w.structuredContent.freshness_seconds).toBeLessThan(120);
      expect(JSON.stringify(w)).not.toContain(SECRET_ADDRESS);
      expect(JSON.stringify(w)).not.toContain(PERSON);

      const r = (await c.callTool({ name: "recent_locations", arguments: { start: "today", end: "now", max_points: 3 } })) as any;
      // "today" is local midnight; seeded points are within the last 5 minutes (may straddle midnight only in odd cases)
      expect(r.structuredContent.points.length).toBeLessThanOrEqual(3);
      expect(r.structuredContent.points.length).toBeGreaterThan(0);

      const s = (await c.callTool({ name: "location_status", arguments: {} })) as any;
      expect(s.structuredContent).toMatchObject({ kind: "status", observation_count: 5, authenticated: true });
    } finally {
      await c.close();
    }
  });
});

describe("/healthz", () => {
  it("is open, and exposes no coordinates, addresses or ids", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const j = JSON.parse(text);
    expect(j).toMatchObject({ service: "live-location-mcp", authenticated: true, observation_count: 5, consecutive_failures: 0 });
    expect(j.newest_observation_age_seconds).toBeLessThan(120);
    expect(j).toHaveProperty("last_poll_age_seconds");
    expect(j).toHaveProperty("last_success_age_seconds");
    expect(text).not.toContain(SECRET_ADDRESS);
    expect(text).not.toContain(PERSON);
    expect(text).not.toMatch(/10\.1\d*|lat|lng|longitude|latitude|address/i);
  });
});
