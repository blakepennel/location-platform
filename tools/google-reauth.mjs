#!/usr/bin/env node
/**
 * Re-mint the Timeline master token from the persistent Google browser (docker service
 * `google-browser`), so a revoked token doesn't need a human.
 *
 * Drives the already-running Chromium over its local DevTools port (no puppeteer, no
 * --enable-automation, no stealth tricks): opens accounts.google.com/EmbeddedSetup, and
 *   - if the Google session is still alive, picks the account / clicks "I agree";
 *   - if not, types the (non-secret) email, then the password: Chromium's autofill when it
 *     offers it, otherwise the TPM-encrypted copy from `google-password-set` (decrypted in
 *     memory only for this step; never logged or written in plaintext), then clicks Next.
 *   - waits for a phone approval prompt if Google shows one;
 *   - stops on anything else (CAPTCHA, codes, "browser may not be secure") and asks for a human.
 * On success the single-use `oauth_token` cookie is written to STDOUT only (pipe it straight
 * into `timeline-sync auth --oauth-token-stdin`). Progress goes to stderr; no secrets are logged.
 *
 * Exit: 0 token written, 1 failed, 2 needs a human.
 * Env: TIMELINE_GOOGLE_EMAIL (required), CDP_URL (default http://127.0.0.1:9222), REAUTH_TIMEOUT_S (360)
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
const execFileP = promisify(execFile);

const CDP = process.env.CDP_URL ?? "http://127.0.0.1:9222";
const EMAIL = (process.env.TIMELINE_GOOGLE_EMAIL ?? "").trim();
const TIMEOUT_MS = Number(process.env.REAUTH_TIMEOUT_S ?? 360) * 1000;
const START = "https://accounts.google.com/EmbeddedSetup";

const PASSWORD_CRED = process.env.GOOGLE_PASSWORD_CRED ?? "/data/secrets/google-password.cred";

async function decryptPassword() {
  try {
    const { stdout } = await execFileP("systemd-creds", ["decrypt", "--name=google-password", PASSWORD_CRED, "-"], { maxBuffer: 4096 });
    return stdout;
  } catch {
    log("could not decrypt the TPM-stored password (run google-password-set --check)");
    return null;
  }
}

const log = (m) => process.stderr.write(`[google-reauth] ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const targets = await (await fetch(`${CDP}/json/list`)).json();
  let page = targets.find((t) => t.type === "page");
  if (!page) page = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("DevTools connection failed")); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(`${msg.error.message}`)) : res(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, close: () => ws.close() };
}

export async function main() {
  if (!EMAIL.includes("@")) { log("TIMELINE_GOOGLE_EMAIL is not set"); return 1; }
  const c = await connect();
  const js = async (expr) => (await c.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
  // A real (trusted) click at the element's centre; selector-or-text lookup happens in the page.
  const click = async (finder) => {
    const box = await js(`(() => { const e = (${finder})(); if (!e) return null; e.scrollIntoView({block:'center'});
      const r = e.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()`);
    if (!box) return false;
    for (const type of ["mousePressed", "mouseReleased"]) {
      await c.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    return true;
  };
  const byText = (re) => `() => [...document.querySelectorAll('button, [role=button], a, div[role=link]')]
      .find(e => e.offsetParent !== null && ${re}.test((e.innerText || e.getAttribute('aria-label') || '').trim()))`;
  const token = async () => {
    const { cookies } = await c.send("Storage.getCookies", {});
    return cookies.find((k) => k.name === "oauth_token" && k.domain.endsWith("google.com"))?.value;
  };

  try {
    // oauth_token is single-use: drop any leftover one so we only ever return a fresh token.
    const { cookies: existing } = await c.send("Storage.getCookies", {});
    for (const k of existing.filter((k) => k.name === "oauth_token")) {
      await c.send("Network.deleteCookies", { name: k.name, domain: k.domain, path: k.path });
    }
    await c.send("Page.enable");
    await c.send("Page.navigate", { url: START });
    let passwordTried = false, phoneLogged = false;
    const end = Date.now() + TIMEOUT_MS;
    while (Date.now() < end) {
      await sleep(2500);
      const t = await token();
      if (t) { process.stdout.write(t); log("got oauth_token from EmbeddedSetup"); return 0; }

      const s = await js(`(() => {
        const vis = (q) => { const e = document.querySelector(q); return !!(e && e.offsetParent !== null); };
        const text = (document.body?.innerText || '').slice(0, 4000);
        return { url: location.href, email: vis('#identifierId, input[name=identifier], input[type=email]'), password: vis('input[type=password]'),
                 chooser: !!document.querySelector('[data-identifier="${EMAIL}"]'),
                 insecure: /browser or app may not be secure|couldn.t sign you in/i.test(text),
                 // only a CAPTCHA the user would actually see (sign-in pages carry hidden placeholders)
                 captcha: [...document.querySelectorAll('iframe[src*="recaptcha"], img#captchaimg')]
                   .some((e) => e.offsetParent !== null && e.offsetWidth > 40 && e.offsetHeight > 20),
                 phonePrompt: /check your phone|tap yes on|open the gmail app|google sent a notification/i.test(text) };
      })()`);
      if (!s) { if (process.env.REAUTH_DEBUG) log("page state unavailable (script error or navigation)"); continue; }
      const path = new URL(s.url).pathname;
      if (process.env.REAUTH_DEBUG) log(`state ${new URL(s.url).host}${path} ${JSON.stringify({ ...s, url: undefined })}`);

      if (s.insecure) { log("Google refused this browser ('may not be secure'); sign in over noVNC instead"); return 2; }
      if (s.captcha) { log("Google shows a CAPTCHA; a human has to sign in over noVNC"); return 2; }
      if (s.chooser) { log("choosing the account"); await click(`() => document.querySelector('[data-identifier="${EMAIL}"]')`); continue; }
      if (s.email) {
        log("entering the account email");
        await click(`() => document.querySelector('#identifierId, input[name=identifier], input[type=email]')`);
        await js(`(() => { const e = document.querySelector('#identifierId, input[name=identifier], input[type=email]'); e.select(); })()`);
        await c.send("Input.insertText", { text: EMAIL });
        await click(`() => document.querySelector('#identifierNext button, #identifierNext') || (${byText("/^next$/i")})()`);
        continue;
      }
      if (s.password) {
        if (passwordTried) { log("password step came back; the saved password is probably wrong. Not retrying."); return 1; }
        // The click is a user gesture, which lets Chromium's password manager fill the saved password.
        await click(`() => document.querySelector('input[type=password]')`);
        await sleep(1500);
        const isFilled = () => js(`(() => { const e = document.querySelector('input[type=password]');
          return e.matches(':-webkit-autofill') || e.matches(':autofill') || e.value.length > 0; })()`);
        let how = (await isFilled()) ? "Chromium autofilled" : null;
        if (!how && existsSync(PASSWORD_CRED)) {
          // Chromium won't offer saved passwords on Google's device-setup sign-in, so use the
          // TPM-encrypted copy: decrypted in memory, typed, then dropped. Never logged.
          let pw = await decryptPassword();
          if (pw) {
            await js(`(() => { const e = document.querySelector('input[type=password]'); e.focus(); e.select(); })()`);
            await c.send("Input.insertText", { text: pw });
            pw = null;
            how = "the TPM-stored password";
          }
        }
        if (!how) {
          log("no password available (Chromium didn't autofill and no TPM-stored password; run google-password-set)");
          return 2;
        }
        passwordTried = true;
        log(`submitting ${how}`);
        await click(`() => document.querySelector('#passwordNext button, #passwordNext') || (${byText("/^next$/i")})()`);
        continue;
      }
      if (path.includes("/challenge/")) {
        if (s.phonePrompt) {
          if (!phoneLogged) { log("Google is asking for approval on your phone; approve it (waiting)"); phoneLogged = true; }
          continue;
        }
        log(`Google wants a verification step this script won't do (${path}); sign in over noVNC`);
        return 2;
      }
      // Consent / terms pages of EmbeddedSetup
      if (await click(byText("/^(i agree|accept|agree|continue)$/i"))) { log("accepted the setup consent"); continue; }
    }
    log("timed out without an oauth_token");
    return 1;
  } finally {
    c.close();
  }
}

main().then((code) => process.exit(code), (e) => { log(`error: ${e.message}`); process.exit(1); });
