/** Streamable HTTP host (OAuth-protected) for the live-location tools. */
import { authConfigFromEnv } from "@location/mcp-auth";
import { createLogger, createMcpHttpApp, listenLoopback, mcpResourceUrl, type Logger, type McpHttpOptions } from "@location/shared";
import type { LiveConfig } from "./config.ts";
import type { LiveDb } from "./db.ts";
import { healthPayload } from "./status.ts";
import { buildServer } from "./tools.ts";

export const REQUIRED_SCOPES = ["location:read"];

export function createLiveHttpApp(
  db: LiveDb,
  config: LiveConfig,
  overrides: Partial<Pick<McpHttpOptions, "auth" | "verifier" | "rateLimitPerMinute">> = {},
  logger: Logger = createLogger("live-location-mcp"),
) {
  const resource = mcpResourceUrl(config.publicUrl);
  return createMcpHttpApp({
    name: "live-location-mcp",
    publicUrl: config.publicUrl,
    auth: overrides.auth ?? authConfigFromEnv({ resource, requiredScopes: REQUIRED_SCOPES }),
    verifier: overrides.verifier,
    rateLimitPerMinute: overrides.rateLimitPerMinute,
    buildServer: () => buildServer({ db, config, logger }),
    health: () => healthPayload(db, config),
    logger,
  });
}

export async function serve(db: LiveDb, config: LiveConfig, logger: Logger = createLogger("live-location-mcp")) {
  const { app, resource } = createLiveHttpApp(db, config, {}, logger);
  const servers = await listenLoopback(app, config.port);
  logger.info("http.listening", { resource, port: config.port });
  return servers;
}
