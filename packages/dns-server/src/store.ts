import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CachedClassification, CacheStore } from "@focus/site-blocker";
import { JSONFilePreset } from "lowdb/node";
import { DEFAULT_STATE, NEW_DOMAIN_MODES, type BlockingState } from "./state.js";

interface Data {
  state: BlockingState;
  decisions: Record<string, CachedClassification>;
}

export interface Store {
  getState(): BlockingState;
  setState(state: BlockingState): Promise<void>;
  /** Persistent Jev verdict cache for @focus/site-blocker. */
  cache: CacheStore;
}

/** Persist dashboard state and Jev verdicts to `<dataDir>/focus-dns.json`. */
export async function openStore(dataDir: string): Promise<Store> {
  await mkdir(dataDir, { recursive: true });
  const db = await JSONFilePreset<Data>(join(dataDir, "focus-dns.json"), {
    state: DEFAULT_STATE,
    decisions: {},
  });
  // Tolerate hand-edited or older files.
  db.data.state = { ...DEFAULT_STATE, ...db.data.state };
  if (!NEW_DOMAIN_MODES.includes(db.data.state.newDomainMode)) {
    db.data.state.newDomainMode = DEFAULT_STATE.newDomainMode;
  }
  db.data.decisions ??= {};

  return {
    getState: () => db.data.state,
    setState: (state) => db.update((d) => void (d.state = state)),
    cache: {
      get: async (domain) => db.data.decisions[domain],
      set: (domain, value) => db.update((d) => void (d.decisions[domain] = value)),
      delete: (domain) => db.update((d) => void delete d.decisions[domain]),
    },
  };
}
