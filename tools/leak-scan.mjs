#!/usr/bin/env node
/**
 * Repository secret / real-location leak scanner.
 *
 *   node tools/leak-scan.mjs            scan tracked + untracked (non-ignored) files
 *   node tools/leak-scan.mjs --staged   scan only git-staged content (pre-commit)
 *
 * Exits non-zero if anything credential-shaped or real-coordinate-shaped is found.
 * A git-ignored `.private-denylist` (one lowercase term per line) adds your own terms
 * (real town, street, device names) so they can never be committed.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const staged = process.argv.includes("--staged");

const RULES = [
  ["Google master token", /aas_et\/[A-Za-z0-9_\-.]{10,}/],
  ["Google OAuth token cookie", /oauth2_4\/[A-Za-z0-9_\-.]{20,}/],
  ["Google access token", /ya29\.[A-Za-z0-9_\-.]{20,}/],
  ["Google API key", /AIza[0-9A-Za-z_\-]{30,}/],
  ["Google session cookie value", /(__Secure-[13]PSID|SAPISID|__Secure-3PAPISID)=[A-Za-z0-9_\-./]{10,}/],
  ["JWT", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/],
  ["PEM private key", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["Google Maps placeId", /ChIJ[A-Za-z0-9_-]{20,}/],
  ["Google featureId", /0x[0-9a-f]{16}:0x[0-9a-f]{16}/],
];
// Real-ish coordinate pair with high precision (fixtures use lat 10.x/20.x — allowlisted below).
const COORD = /(-?\d{1,3}\.\d{5,})\s*°?\s*,\s*(-?\d{1,3}\.\d{5,})/g;

// Files that legitimately contain the *documented* prefixes / synthetic coords.
const ALLOW_FILE = /(^|[\\/])(package-lock\.json|leak-scan\.mjs|SECURITY\.md|THREAT_MODEL\.md|AUTH\.md|.*\.test\.ts)$/;
const ALLOW_DIR = /([\\/]|^)(node_modules|\.git|dist|coverage|upstream|_upstream)([\\/]|$)|test[\\/]fixtures[\\/]|test[\\/]helpers[\\/]/;
// Synthetic coordinates used across the project (deliberately fake).
const SYNTHETIC_COORD = /^-?(1[0-3]|2[0-3]|98)\./;

function gitFiles() {
  const cmd = staged
    ? "git diff --cached --name-only --diff-filter=ACM"
    : "git ls-files --cached --others --exclude-standard";
  try {
    return execSync(cmd, { cwd: root, encoding: "utf8" }).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function content(file) {
  if (staged) {
    try {
      return execSync(`git show :${file}`, { cwd: root, encoding: "utf8" });
    } catch {
      return "";
    }
  }
  return readFileSync(join(root, file), "utf8");
}

let findings = 0;
const denylist = existsSync(join(root, ".private-denylist"))
  ? readFileSync(join(root, ".private-denylist"), "utf8").split("\n").map((s) => s.trim().toLowerCase()).filter(Boolean)
  : [];

for (const file of gitFiles()) {
  if (ALLOW_DIR.test(file) || ALLOW_FILE.test(file)) continue;
  let full;
  try {
    full = join(root, file);
    if (!staged && statSync(full).size > 4_000_000) continue;
  } catch {
    continue;
  }
  let text;
  try {
    text = content(file);
  } catch {
    continue;
  }
  if (text.includes("\u0000")) continue; // binary

  for (const [name, re] of RULES) {
    const m = re.exec(text);
    // Synthetic test fixtures label their placeholders FAKE/EXAMPLE/PLACEHOLDER/TEST.
    if (m && !/FAKE|EXAMPLE|PLACEHOLDER|DUMMY|SAMPLE|_TEST_/i.test(m[0])) {
      const line = text.slice(0, m.index).split("\n").length;
      console.error(`  !! ${name} in ${file}:${line}`);
      findings++;
    }
  }
  for (const m of text.matchAll(COORD)) {
    if (SYNTHETIC_COORD.test(m[1]) && SYNTHETIC_COORD.test(m[2])) continue;
    const line = text.slice(0, m.index).split("\n").length;
    console.error(`  !! high-precision coordinate in ${file}:${line} (use synthetic coords, keep real data outside the repo)`);
    findings++;
  }
  const lower = text.toLowerCase();
  for (const term of denylist) {
    if (lower.includes(term)) {
      console.error(`  !! private denylist term matched in ${file}`);
      findings++;
      break;
    }
  }
}

if (findings) {
  console.error(`\nLEAKS FOUND (${findings}). Nothing committed. Secrets and real location data must live outside the repo (see SECURITY.md).`);
  process.exit(1);
}
console.log(`leak-scan: clean${denylist.length ? "" : " (tip: create .private-denylist with your real town/street/device names for a stronger check)"}`);
