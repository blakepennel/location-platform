#!/usr/bin/env node
/**
 * Start the local development authorization server.
 *   npm run dev -w @location/mcp-auth
 * Env: DEV_AUTH_PORT (8700), MCP_AUTH_ISSUER (http://localhost:8700), DEV_AUTH_SUBJECT,
 *      TIMELINE_MCP_PUBLIC_URL, LIVE_MCP_PUBLIC_URL, LOCATION_PLATFORM_HOME
 */
import { join } from "node:path";
import { createLogger, envBool, envInt, listenLoopback, loadEnv, platformHome } from "@location/shared";
import { createDevAuthServer } from "./server.ts";

loadEnv();
const log = createLogger("mcp-dev-auth");
const port = envInt("DEV_AUTH_PORT", 8700);
const issuer = (process.env.MCP_AUTH_ISSUER ?? `http://localhost:${port}`).replace(/\/+$/, "");
const subject = process.env.DEV_AUTH_SUBJECT ?? "local-dev-user";
const timelineUrl = (process.env.TIMELINE_MCP_PUBLIC_URL ?? "http://localhost:8701").replace(/\/+$/, "");
const liveUrl = (process.env.LIVE_MCP_PUBLIC_URL ?? "http://localhost:8702").replace(/\/+$/, "");

const { app } = await createDevAuthServer({
  issuer,
  subject,
  resources: [
    { resource: `${timelineUrl}/mcp`, scopes: ["timeline:read"], name: "Historical Timeline MCP" },
    { resource: `${liveUrl}/mcp`, scopes: ["location:read"], name: "Live Location MCP" },
  ],
  stateDir: process.env.DEV_AUTH_STATE_DIR ?? join(platformHome(), "secrets", "dev-auth"),
  accessTokenTtlSec: envInt("DEV_AUTH_ACCESS_TOKEN_TTL", 600),
  refreshTokenTtlSec: envInt("DEV_AUTH_REFRESH_TOKEN_TTL", 14 * 86400),
  enableCimd: envBool("DEV_AUTH_ENABLE_CIMD", true),
  devClient: {
    clientId: "location-dev-cli",
    redirectUris: ["http://127.0.0.1:8799/callback", "http://localhost:8799/callback"],
  },
  trustProxy: envBool("DEV_AUTH_TRUST_PROXY", false),
  log: (event, fields) => log.info(event, fields),
});

await listenLoopback(app, port);
log.info("dev_auth.listening", { issuer, port, subject_configured: true });
