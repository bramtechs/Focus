import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CachedClassification, CacheStore } from "@focus/site-blocker";
import { JSONFilePreset } from "lowdb/node";
import type { JevUsage } from "./usage.js";
import { DEFAULT_STATE, NEW_DOMAIN_MODES, type BlockingState, type DomainLists } from "./state.js";

interface Data {
  state: BlockingState;
  decisions: Record<string, CachedClassification>;
  /** OpenRouter API key set from the dashboard; overrides OPENROUTER_API_KEY when non-empty. */
  openrouterApiKey: string;
  lists: DomainLists;
  jevUsage: JevUsage;
}

export interface Store {
  getState(): BlockingState;
  setState(state: BlockingState): Promise<void>;
  getApiKey(): string;
  setApiKey(key: string): Promise<void>;
  getLists(): DomainLists;
  setLists(lists: DomainLists): Promise<void>;
  getUsage(): JevUsage;
  setUsage(usage: JevUsage): Promise<void>;
  /** Persistent Jev verdict cache for @focus/site-blocker. */
  cache: CacheStore;
}

/** Persist dashboard state and Jev verdicts to `<dataDir>/focus-dns.json`. */
export async function openStore(dataDir: string): Promise<Store> {
  await mkdir(dataDir, { recursive: true });
  const db = await JSONFilePreset<Data>(join(dataDir, "focus-dns.json"), {
    state: DEFAULT_STATE,
    decisions: {},
    openrouterApiKey: "",
    lists: { allow: [], block: [] },
    jevUsage: { calls: 0, cost: 0, since: Date.now() },
  });
  // Tolerate hand-edited or older files.
  db.data.state = { ...DEFAULT_STATE, ...db.data.state };
  if (!NEW_DOMAIN_MODES.includes(db.data.state.newDomainMode)) {
    db.data.state.newDomainMode = DEFAULT_STATE.newDomainMode;
  }
  db.data.state.filters = { ...DEFAULT_STATE.filters, ...db.data.state.filters };
  db.data.decisions ??= {};
  db.data.openrouterApiKey ??= "";
  const lists: Partial<DomainLists> = db.data.lists ?? {};
  db.data.lists = { allow: lists.allow ?? [], block: lists.block ?? [] };
  db.data.jevUsage ??= { calls: 0, cost: 0, since: Date.now() };

  return {
    getState: () => db.data.state,
    setState: (state) => db.update((d) => void (d.state = state)),
    getApiKey: () => db.data.openrouterApiKey,
    setApiKey: (key) => db.update((d) => void (d.openrouterApiKey = key)),
    getLists: () => db.data.lists,
    setLists: (lists) => db.update((d) => void (d.lists = lists)),
    getUsage: () => db.data.jevUsage,
    setUsage: (usage) => db.update((d) => void (d.jevUsage = usage)),
    cache: {
      get: async (domain) => db.data.decisions[domain],
      set: (domain, value) => db.update((d) => void (d.decisions[domain] = value)),
      delete: (domain) => db.update((d) => void delete d.decisions[domain]),
    },
  };
}
