#!/usr/bin/env node
/**
 * live-location CLI. `auth` is the ONLY command that may talk to Google (besides a `daemon`/`poll`
 * running with the real source). Output never contains coordinates, addresses or cookies.
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLogger, loadEnv } from "@location/shared";
import { loadConfig } from "./config.ts";
import { LiveDb } from "./db.ts";
import { GoogleLocationSharingSource, cookiesFilePermissionWarning, secureCookiesFile } from "./google.ts";
import { assertSyntheticSafe, createPollerHooks, createSource, exportFromProfile, prune, refreshFromBrowser, simulate } from "./ops.ts";
import { BrowserSessionError, DEFAULT_LOGIN_TIMEOUT_MS, ensureProfileDir, findChrome, loginInteractive } from "./browser-session.ts";
import { Poller, runDaemon } from "./poller.ts";
import { SourceError } from "./source.ts";
import { serve } from "./http.ts";
import { getStatus } from "./status.ts";
import { buildServer } from "./tools.ts";

const USAGE = `live-location <command>

  auth                  validate cookies + ONE live fetch; prints sharer ids (never coordinates)
  poll                  one poll (LIVE_SOURCE=synthetic for the generator)
  daemon                poll forever (never prunes)
  simulate [--count N]  insert N synthetic observations (dev)
  status                print pipeline status (no coordinates)
  prune [--yes]         retention: dry-run by default; --yes (or LIVE_PRUNE_CONFIRM=true) deletes
  login [--timeout MIN] HUMAN sign-in to the recipient account in a persistent browser profile, then export cookies
  refresh-browser       re-export cookies.txt from the persistent browser profile (L4 keepalive)
  serve                 OAuth-protected Streamable HTTP MCP server
  stdio                 MCP over stdio
`;

const out = (o: unknown) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");

export async function main(argv: string[]): Promise<number> {
  loadEnv();
  const [cmd, ...rest] = argv;
  const log = createLogger("live-location-mcp");
  if (!cmd || cmd === "help" || cmd === "--help") {
    process.stderr.write(USAGE);
    return cmd ? 0 : 1;
  }
  const config = loadConfig();
  const flag = (name: string) => rest.includes(name);
  const opt = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  switch (cmd) {
    case "auth": {
      if (process.env.VITEST || process.env.NODE_ENV === "test") {
        process.stderr.write("refusing to contact Google from a test environment\n");
        return 2;
      }
      if (config.source === "synthetic") {
        process.stderr.write("LIVE_SOURCE=synthetic: nothing to authenticate\n");
        return 2;
      }
      if (!existsSync(config.cookiesFile)) {
        process.stderr.write(`cookies file not found: ${config.cookiesFile}\nExport a Netscape cookies.txt for the DEDICATED recipient account (see README).\n`);
        return 1;
      }
      if (!secureCookiesFile(config.cookiesFile)) process.stderr.write("warning: could not restrict cookies file permissions\n");
      const warn = cookiesFilePermissionWarning(config.cookiesFile);
      if (warn) process.stderr.write(`warning: ${warn}\n`);
      const src = new GoogleLocationSharingSource({ cookiesFile: config.cookiesFile, sharerId: config.sharerId, pb: config.pb });
      try {
        const r = await src.probe();
        out({
          authenticated: true,
          sharers_visible: r.sharerIds.length,
          sharers_with_location: r.withLocation,
          sharer_ids: r.sharerIds,
          hint: config.sharerId ? undefined : r.sharerIds.length > 1 ? "set LIVE_SHARER_ID to one of these ids" : "single sharer: LIVE_SHARER_ID optional",
        });
        return 0;
      } catch (e) {
        if (e instanceof SourceError) {
          out({ authenticated: e.kind !== "auth" ? null : false, error_kind: e.kind, message: e.message });
          return 1;
        }
        throw e;
      }
    }

    case "login": {
      if (process.env.VITEST || process.env.NODE_ENV === "test") {
        process.stderr.write("refusing to launch a browser from a test environment\n");
        return 2;
      }
      const chrome = findChrome();
      ensureProfileDir(config.browserProfile);
      const minutes = Number(opt("--timeout") ?? DEFAULT_LOGIN_TIMEOUT_MS / 60_000);
      process.stderr.write(
        "Sign in to the DEDICATED recipient account in the browser window (in Docker: open http://localhost:6082/vnc.html),\n" +
          "then close the browser window. Do not use your main Google account. This tool never sees your password.\n",
      );
      try {
        const r = await loginInteractive({ profileDir: config.browserProfile, chromePath: chrome, timeoutMs: Math.max(1, minutes) * 60_000, logger: log });
        if (r.timedOut) process.stderr.write("timed out waiting for the browser to close; exporting whatever was signed in\n");
        const res = await exportFromProfile(config, log);
        out({ signed_in: true, cookies_exported: res.cookieCount, cookies_file_updated: res.wrote });
        return 0;
      } catch (e) {
        if (e instanceof BrowserSessionError) {
          out({ signed_in: false, error: e.code, message: e.message });
          return 1;
        }
        throw e;
      }
    }

    case "refresh-browser": {
      if (process.env.VITEST || process.env.NODE_ENV === "test") {
        process.stderr.write("refusing to launch a browser from a test environment\n");
        return 2;
      }
      try {
        const res = await refreshFromBrowser(config, log);
        out({ ok: true, cookies_exported: res.cookieCount, cookies_file_updated: res.wrote });
        return 0;
      } catch (e) {
        if (e instanceof BrowserSessionError) {
          out({ ok: false, error: e.code, message: e.message });
          return 1;
        }
        throw e;
      }
    }

    case "poll": {
      const db = new LiveDb(config.dbPath);
      try {
        if (config.source === "synthetic") assertSyntheticSafe(db);
        const res = await new Poller(db, createSource(config, log), config, log, Date.now, createPollerHooks(config, db, log)).pollOnce();
        out(res);
        return res.ok ? 0 : 1;
      } finally {
        db.close();
      }
    }

    case "daemon": {
      const db = new LiveDb(config.dbPath);
      if (config.source === "synthetic") assertSyntheticSafe(db);
      const ac = new AbortController();
      const stop = () => ac.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      log.info("daemon.start", { source: config.source, interval_s: config.pollIntervalMs / 1000, retention_days: config.retentionDays, auto_prune: false });
      try {
        await runDaemon(new Poller(db, createSource(config, log), config, log, Date.now, createPollerHooks(config, db, log)), ac.signal, log);
      } finally {
        db.close();
      }
      return 0;
    }

    case "simulate": {
      const db = new LiveDb(config.dbPath);
      try {
        out(simulate(db, config, Number(opt("--count") ?? 20)));
      } finally {
        db.close();
      }
      return 0;
    }

    case "status": {
      const db = new LiveDb(config.dbPath);
      try {
        out({ source: createSource(config).describe().kind, ...getStatus(db, config, Date.now(), config.sharerId) });
      } finally {
        db.close();
      }
      return 0;
    }

    case "prune": {
      const db = new LiveDb(config.dbPath);
      try {
        const r = prune(db, config, { yes: flag("--yes") });
        out(r);
        if (r.dry_run) process.stderr.write(`dry run: ${r.would_delete} observation(s) older than ${r.retention_days} d would be deleted. Re-run with --yes to delete.\n`);
      } finally {
        db.close();
      }
      return 0;
    }

    case "serve": {
      const db = new LiveDb(config.dbPath);
      const servers = await serve(db, config, log);
      const shutdown = () => {
        for (const s of servers) s.close();
        db.close();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      return -1; // keep running
    }

    case "stdio": {
      const db = new LiveDb(config.dbPath);
      const server = buildServer({ db, config, logger: log });
      await server.connect(new StdioServerTransport());
      log.info("stdio.ready");
      return -1;
    }

    default:
      process.stderr.write(`unknown command: ${cmd}\n${USAGE}`);
      return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Set exitCode and let the event loop drain instead of calling process.exit() right away:
  // exiting while fetch's keep-alive sockets are closing trips a libuv assertion on Windows.
  // The unref'd timer only forces the exit if something keeps the loop alive.
  const finish = (code: number) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 5000).unref();
  };
  main(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) finish(code);
    },
    (e) => {
      process.stderr.write(`error: ${(e as Error).message}\n`);
      finish(1);
    },
  );
}
