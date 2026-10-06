/**
 * Headless OAuth 2.1 Authorization Code + PKCE client for the LOCAL dev authorization server.
 *
 * It performs the real protocol — dynamic client registration, /auth redirect, the login and
 * consent interaction pages (by submitting their forms like a browser would), code exchange
 * with the PKCE verifier, and refresh — so automated tests exercise the genuine flow.
 * Only usable against the dev server's interaction pages; real IdPs need a human.
 */
import { createHash, randomBytes } from "node:crypto";

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

const b64url = (b: Buffer) => b.toString("base64url");

export function pkcePair() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export async function discover(issuer: string) {
  const r = await fetch(`${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`);
  if (!r.ok) throw new Error(`AS metadata HTTP ${r.status}`);
  return (await r.json()) as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
    revocation_endpoint?: string;
  };
}

export async function registerPublicClient(issuer: string, redirectUri: string, name = "automated test client"): Promise<string> {
  const meta = await discover(issuer);
  if (!meta.registration_endpoint) throw new Error("AS does not support dynamic client registration");
  const r = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (r.status !== 201) throw new Error(`DCR failed HTTP ${r.status}`);
  return ((await r.json()) as { client_id: string }).client_id;
}

class Jar {
  private c = new Map<string, string>();
  take(res: Response) {
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (/expires=Thu, 01 Jan 1970/i.test(sc) || value === "") this.c.delete(name);
      else this.c.set(name, value);
    }
  }
  header() {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export interface DevLoginOptions {
  issuer: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: string;
  /** "deny" clicks the Deny link on the consent page (negative tests). */
  decision?: "allow" | "deny";
}

/** Drive the dev AS login + consent pages and return the authorization-code redirect. */
export async function authorizeViaDevLogin(o: DevLoginOptions): Promise<{ code?: string; error?: string; verifier: string }> {
  const meta = await discover(o.issuer);
  const { verifier, challenge } = pkcePair();
  const state = b64url(randomBytes(12));
  const u = new URL(meta.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    scope: o.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: o.resource,
  }).toString();

  const jar = new Jar();
  let url = u.toString();
  let method = "GET";
  for (let hop = 0; hop < 15; hop++) {
    const res = await fetch(url, {
      method,
      redirect: "manual",
      headers: { cookie: jar.header(), ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: method === "POST" ? "" : undefined,
    });
    jar.take(res);
    method = "GET";
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      const next = new URL(loc, url);
      if (next.toString().startsWith(o.redirectUri)) {
        if (next.searchParams.get("state") !== state) throw new Error("state mismatch");
        return { code: next.searchParams.get("code") ?? undefined, error: next.searchParams.get("error") ?? undefined, verifier };
      }
      url = next.toString();
      continue;
    }
    const html = await res.text();
    if (res.status !== 200) throw new Error(`unexpected HTTP ${res.status} at ${new URL(url).pathname}: ${html.slice(0, 200)}`);
    const action = /<form method="post" action="([^"]+)"/.exec(html)?.[1];
    const abort = /<a href="([^"]+\/abort)"/.exec(html)?.[1];
    if (!action) throw new Error(`no form on interaction page ${new URL(url).pathname}`);
    if (o.decision === "deny" && action.endsWith("/confirm") && abort) {
      url = new URL(abort, url).toString();
      continue;
    }
    url = new URL(action, url).toString();
    method = "POST";
  }
  throw new Error("too many redirects");
}

export async function exchangeCode(issuer: string, o: { clientId: string; redirectUri: string; code: string; verifier: string; resource?: string }): Promise<TokenSet> {
  const meta = await discover(issuer);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: o.code,
    redirect_uri: o.redirectUri,
    client_id: o.clientId,
    code_verifier: o.verifier,
    ...(o.resource ? { resource: o.resource } : {}),
  });
  const r = await fetch(meta.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const j = (await r.json()) as TokenSet & { error?: string; error_description?: string };
  if (!r.ok) throw new Error(`token endpoint: ${j.error ?? r.status} ${j.error_description ?? ""}`.trim());
  return j;
}

export async function refresh(issuer: string, o: { clientId: string; refreshToken: string; resource?: string }): Promise<TokenSet> {
  const meta = await discover(issuer);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: o.refreshToken,
    client_id: o.clientId,
    ...(o.resource ? { resource: o.resource } : {}),
  });
  const r = await fetch(meta.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const j = (await r.json()) as TokenSet & { error?: string; error_description?: string };
  if (!r.ok) throw new Error(`refresh: ${j.error ?? r.status} ${j.error_description ?? ""}`.trim());
  return j;
}

/** Full flow: (optional DCR) → authorize via dev login → exchange code. */
export async function obtainDevToken(o: Omit<DevLoginOptions, "clientId"> & { clientId?: string }): Promise<TokenSet & { client_id: string }> {
  const clientId = o.clientId ?? (await registerPublicClient(o.issuer, o.redirectUri));
  const { code, error, verifier } = await authorizeViaDevLogin({ ...o, clientId });
  if (!code) throw new Error(`authorization failed: ${error ?? "no code"}`);
  const tokens = await exchangeCode(o.issuer, { clientId, redirectUri: o.redirectUri, code, verifier });
  return { ...tokens, client_id: clientId };
}
