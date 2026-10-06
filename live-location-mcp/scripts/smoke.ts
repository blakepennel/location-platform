/**
 * Manual smoke: spawn `live-location stdio` against the current LIVE_MCP_DB and call a few tools
 * over real stdio. Prints tool results (coordinates are whatever is in your DB: use a synthetic one).
 *   LIVE_MCP_DB=/tmp/x.sqlite LIVE_SOURCE=synthetic node --import tsx scripts/smoke.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--disable-warning=ExperimentalWarning", "--import", "tsx", cli, "stdio"],
  env: { ...(process.env as Record<string, string>) },
  stderr: "ignore",
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);
const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
for (const [name, args] of [
  ["where_am_i", {}],
  ["location_status", {}],
  ["movement_since", { timestamp: new Date(Date.now() - 3600_000).toISOString() }],
] as const) {
  const r = (await client.callTool({ name, arguments: args })) as { structuredContent?: unknown };
  console.log(`\n== ${name}\n` + JSON.stringify(r.structuredContent, null, 2));
}
await client.close();
