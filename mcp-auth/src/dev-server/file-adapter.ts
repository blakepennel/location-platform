/**
 * Minimal file-backed adapter for oidc-provider (DEV ONLY).
 * Persists dynamically registered clients, grants and refresh tokens across restarts so an
 * MCP client (Claude, Inspector) does not have to re-register after every dev restart.
 * Production deployments should use a real IdP instead of this server.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Payload = Record<string, any>;
interface Entry { payload: Payload; exp?: number }
type Store = Record<string, Record<string, Entry>>;

export function createFileAdapterFactory(file: string | null) {
  let store: Store = {};
  if (file && existsSync(file)) {
    try { store = JSON.parse(readFileSync(file, "utf8")); } catch { store = {}; }
  }
  // Only these models are worth persisting; sessions/interactions are short-lived.
  const PERSIST = new Set(["Client", "Grant", "RefreshToken", "__grants"]);
  let timer: NodeJS.Timeout | undefined;
  const save = () => {
    if (!file) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const out: Store = {};
      const now = Date.now() / 1000;
      for (const [model, entries] of Object.entries(store)) {
        if (!PERSIST.has(model)) continue;
        out[model] = Object.fromEntries(Object.entries(entries).filter(([, e]) => !e.exp || e.exp > now));
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file + ".tmp", JSON.stringify(out), { mode: 0o600 });
      renameSync(file + ".tmp", file);
    }, 50);
    timer.unref?.();
  };

  return class FileAdapter {
    name: string;
    constructor(name: string) {
      this.name = name;
      store[name] ??= {};
    }
    private get m() { return store[this.name]; }
    private live(e: Entry | undefined): Payload | undefined {
      if (!e) return undefined;
      if (e.exp && e.exp < Date.now() / 1000) return undefined;
      return e.payload;
    }
    async upsert(id: string, payload: Payload, expiresIn?: number) {
      this.m[id] = { payload, exp: expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : undefined };
      if (payload.grantId && this.name !== "Grant") {
        const g = (store.__grants ??= {});
        const list = (g[payload.grantId]?.payload?.ids as string[]) ?? [];
        g[payload.grantId] = { payload: { ids: [...list, `${this.name}:${id}`] } };
      }
      if (PERSIST.has(this.name)) save();
    }
    async find(id: string) { return this.live(this.m[id]); }
    async findByUid(uid: string) {
      for (const e of Object.values(this.m)) if (e.payload.uid === uid) return this.live(e);
      return undefined;
    }
    async findByUserCode(userCode: string) {
      for (const e of Object.values(this.m)) if (e.payload.userCode === userCode) return this.live(e);
      return undefined;
    }
    async consume(id: string) {
      const e = this.m[id];
      if (e) e.payload.consumed = Math.floor(Date.now() / 1000);
      if (PERSIST.has(this.name)) save();
    }
    async destroy(id: string) {
      delete this.m[id];
      if (PERSIST.has(this.name)) save();
    }
    async revokeByGrantId(grantId: string) {
      const ids = (store.__grants?.[grantId]?.payload?.ids as string[]) ?? [];
      for (const ref of ids) {
        const i = ref.indexOf(":"); const model = ref.slice(0, i); const id = ref.slice(i + 1);
        if (store[model]) delete store[model][id];
      }
      if (store.Grant) delete store.Grant[grantId];
      if (store.__grants) delete store.__grants[grantId];
      save();
    }
  };
}
