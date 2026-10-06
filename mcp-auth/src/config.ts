import type { ResourceServerAuthConfig } from "./verifier.ts";

/** Parse a comma/space separated env list. */
export function envList(v: string | undefined): string[] {
  return (v ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Build resource-server auth config from the environment. Shared variables:
 *   MCP_AUTH_ISSUER         e.g. http://localhost:8700  (the IdP / authorization server)
 *   MCP_AUTH_JWKS_URI       optional override; otherwise discovered from issuer metadata
 *   MCP_ALLOWED_SUBJECTS    comma-separated OAuth `sub` values allowed to use the servers
 *   MCP_ALLOW_ANY_SUBJECT   "true" to deliberately disable the single-user check (not recommended)
 */
export function authConfigFromEnv(opts: {
  resource: string;
  requiredScopes: string[];
  env?: NodeJS.ProcessEnv;
}): ResourceServerAuthConfig {
  const env = opts.env ?? process.env;
  return {
    issuer: env.MCP_AUTH_ISSUER ?? "http://localhost:8700",
    jwksUri: env.MCP_AUTH_JWKS_URI || undefined,
    resource: opts.resource,
    requiredScopes: opts.requiredScopes,
    allowedSubjects: envList(env.MCP_ALLOWED_SUBJECTS),
    allowAnySubject: env.MCP_ALLOW_ANY_SUBJECT === "true",
  };
}
