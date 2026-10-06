import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/tools.ts";
import type { Config } from "../../src/config.ts";
import type { Database } from "../../src/db.ts";
import { silentLogger } from "./synthetic.ts";

export const NOW = Date.parse("2025-03-11T00:00:00Z");

export interface Called {
  data: any;
  isError: boolean;
  text: string;
  raw: any;
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Called> {
  const raw: any = await client.callTool({ name, arguments: args });
  const text = raw.content?.[0]?.text ?? "";
  const isError = raw.isError === true;
  let data = raw.structuredContent;
  if (!data && !isError) data = JSON.parse(text);
  return { data, isError, text, raw };
}

export async function connectInMemory(db: Database, config: Config, now: () => number = () => NOW) {
  const server = buildServer({ db, config, logger: silentLogger, now });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientT);
  return {
    client,
    call: (name: string, args?: Record<string, unknown>) => callTool(client, name, args),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
