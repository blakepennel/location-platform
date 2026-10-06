#!/usr/bin/env node
/**
 * timeline-mcp CLI
 *
 *   serve   HTTP (Streamable HTTP, OAuth-protected) on 127.0.0.1/::1:$TIMELINE_MCP_PORT
 *   stdio   local MCP over stdio for Claude Code (NO OAuth: the local process is trusted — whoever can spawn it can read the index)
 *   index   import the export into the SQLite index   [--file path] [--db path] [--force] [--allow-empty]
 *   status  print index status (counts, coverage, freshness, sync health) [--db path]
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLogger, listenLoopback, loadEnv, type Logger } from "@location/shared";
import { loadConfig, type Config } from "./config.ts";
import { openIndexDb, type Database } from "./db.ts";
import { createTimelineHttpApp } from "./http.ts";
import { IndexManager } from "./indexer.ts";
import { TimelineSyncFileSource } from "./source.ts";
import { buildStatus } from "./status.ts";
import { buildServer } from "./tools.ts";

const USAGE = `usage: timeline-mcp <serve|stdio|index|status> [options]
  serve                 HTTP MCP server (OAuth required)
  stdio                 stdio MCP server for local Claude Code (no OAuth)
  index [--file PATH] [--force] [--allow-empty]
                        import the export (default: $TIMELINE_DATA_DIR/current/Timeline.json)
  status                show index status
  common: --db PATH     index database (default: $TIMELINE_MCP_DB)`;

interface Runtime {
  config: Config;
  logger: Logger;
  db: Database;
  index: IndexManager;
  source: TimelineSyncFileSource;
}

function runtime(opts: { file?: string; db?: string }): Runtime {
  const config = loadConfig(opts.db ? { dbPath: opts.db } : {});
  const logger = createLogger("timeline-mcp");
  const db = openIndexDb(config.dbPath);
  const source = new TimelineSyncFileSource({ dataDir: config.dataDir, file: opts.file });
  const index = new IndexManager({ db, source, logger, checkIntervalMs: config.reindexCheckMs });
  return { config, logger, db, index, source };
}

export async function main(argv: string[]): Promise<number> {
  loadEnv();
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.error(USAGE);
    return cmd ? 0 : 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      file: { type: "string" },
      db: { type: "string" },
      force: { type: "boolean", default: false },
      "allow-empty": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  switch (cmd) {
    case "index": {
      const rt = runtime(values);
      const r = await rt.index.reindex({ force: values.force, allowEmpty: values["allow-empty"] });
      // Summary only: counts, never place names or coordinates.
      console.log(JSON.stringify(r.status === "failed" ? { status: "failed", error: r.error } : r.result, null, 2));
      rt.db.close();
      return r.status === "failed" ? 1 : 0;
    }
    case "status": {
      const config = loadConfig(values.db ? { dbPath: values.db } : {});
      if (!existsSync(config.dbPath)) {
        // Do not create an empty index just to report on it.
        console.log(JSON.stringify({ health: "no_data", index: { present: false }, note: "no index database yet; run `timeline-mcp index`" }, null, 2));
        return 0;
      }
      const rt = runtime(values);
      console.log(JSON.stringify(buildStatus(rt.db, Date.now()), null, 2));
      rt.db.close();
      return 0;
    }
    case "stdio": {
      const rt = runtime(values);
      await rt.index.ensureFresh({ force: true }); // auto-reindex on start
      const server = buildServer({ db: rt.db, config: rt.config, logger: rt.logger, index: rt.index });
      await server.connect(new StdioServerTransport());
      rt.logger.info("stdio.ready", { note: "no OAuth; local process trust" });
      return -1; // keep running
    }
    case "serve": {
      const rt = runtime(values);
      const startup = await rt.index.ensureFresh({ force: true });
      rt.logger.info("index.startup", { status: startup.status });
      const { app, resource } = createTimelineHttpApp({ db: rt.db, config: rt.config, logger: rt.logger, index: rt.index });
      const servers = await listenLoopback(app, rt.config.port);
      rt.logger.info("http.listening", { port: rt.config.port, resource, max_precision: rt.config.maxPrecision });
      const stop = () => {
        for (const s of servers) s.close();
        rt.db.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return -1;
    }
    default:
      console.error(`unknown command: ${cmd}\n${USAGE}`);
      return 2;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) process.exit(code);
    },
    (e) => {
      console.error(`timeline-mcp: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
