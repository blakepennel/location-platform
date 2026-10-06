/**
 * Vitest setup shared by every package: make tests hermetic.
 *
 * Real deployments configure the servers through environment variables (TIMELINE_*, LIVE_*,
 * MCP_*, ...). When tests run inside a configured container or shell, those values would leak
 * into loadConfig()/authConfigFromEnv() and change defaults the tests assert on (for example a
 * default precision of "exact", or a JWKS URL pointing at another container). Clear them.
 */
const PLATFORM_ENV = /^(TIMELINE_|LIVE_|MCP_|DEV_AUTH_|LOCATION_|LOG_)/;

for (const key of Object.keys(process.env)) {
  if (PLATFORM_ENV.test(key)) delete process.env[key];
}
