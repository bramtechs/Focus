import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Optional category filters that block independently of the Focus on/off switch. */
export type Category = "ads" | "adult";
export const CATEGORIES: readonly Category[] = ["ads", "adult"];

/** Wildcard domain lists: an entry also blocks all of its subdomains. */
export const DEFAULT_LIST_URLS: Record<Category, string[]> = {
  ads: ["https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/multi-onlydomains.txt"],
  adult: ["https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/nsfw-onlydomains.txt"],
};

export interface ListStatus {
  domains: number;
  /** Epoch ms the lists were last downloaded, or null if never. */
  updatedAt: number | null;
  loading: boolean;
  error: string | null;
}

const IGNORED_HOSTS = new Set(["localhost", "localhost.localdomain", "local", "broadcasthost", "0.0.0.0"]);

/**
 * Parse a domain list in plain ("example.com"), hosts ("0.0.0.0 example.com") or
 * adblock ("||example.com^") format. Comments, IPs and local names are skipped.
 */
export function parseDomainList(text: string, into = new Set<string>()): Set<string> {
  for (let line of text.split("\n")) {
    line = line.replace(/[#!].*$/, "").trim().toLowerCase();
    if (!line) continue;
    const parts = line.split(/\s+/);
    let domain = parts.length > 1 ? parts[1] : parts[0];
    domain = domain.replace(/^\|\|/, "").replace(/\^.*$/, "").replace(/^\*\./, "").replace(/\.$/, "");
    if (IGNORED_HOSTS.has(domain) || !domain.includes(".") || /^[\d.]+$/.test(domain) || domain.includes(":")) continue;
    into.add(domain);
  }
  return into;
}

/** True if `host` or any parent domain of it is in `domains`. */
export function matchesSet(host: string, domains: ReadonlySet<string>): boolean {
  if (!domains.size) return false;
  for (let d = host; ; ) {
    if (domains.has(d)) return true;
    const dot = d.indexOf(".");
    if (dot < 0) return false;
    d = d.slice(dot + 1);
  }
}

export interface BlocklistOptions {
  urls: Record<Category, string[]>;
  /** Directory the downloaded lists are cached in, so restarts don't need the network. */
  dir: string;
  /** Re-download lists older than this. */
  refreshMs: number;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
}

export function createBlocklists(options: BlocklistOptions) {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const lists = Object.fromEntries(
    CATEGORIES.map((c) => [c, { domains: new Set<string>(), updatedAt: null, loading: null, error: null }])
  ) as Record<Category, { domains: Set<string>; updatedAt: number | null; loading: Promise<void> | null; error: string | null }>;

  const file = (c: Category) => join(options.dir, `${c}.txt`);

  async function download(category: Category): Promise<void> {
    const texts = await Promise.all(
      options.urls[category].map(async (url) => {
        const res = await doFetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        return res.text();
      })
    );
    const text = texts.join("\n");
    const domains = parseDomainList(text);
    if (!domains.size) throw new Error("downloaded list is empty");
    await mkdir(options.dir, { recursive: true });
    await writeFile(file(category), text);
    Object.assign(lists[category], { domains, updatedAt: now(), error: null });
    log(`${category} list: ${domains.size.toLocaleString()} domains`);
  }

  async function load(category: Category): Promise<void> {
    const list = lists[category];
    // Use the cached copy first so blocking works straight away, even offline.
    if (list.updatedAt === null) {
      try {
        const [text, info] = await Promise.all([readFile(file(category), "utf8"), stat(file(category))]);
        Object.assign(list, { domains: parseDomainList(text), updatedAt: info.mtimeMs });
      } catch {
        // No cached copy yet.
      }
    }
    if (list.updatedAt !== null && now() - list.updatedAt < options.refreshMs) return;
    await download(category).catch((err) => {
      list.error = (err as Error)?.message ?? String(err);
      log(`couldn't update ${category} list: ${list.error}`);
    });
  }

  return {
    /** Load (or refresh, if stale) a category's list. Concurrent calls share one download. */
    ensure(category: Category): Promise<void> {
      const list = lists[category];
      list.loading ??= load(category).finally(() => (list.loading = null));
      return list.loading;
    },
    /** The category blocking `host`, if any of the given categories' lists contain it. */
    match(host: string, categories: readonly Category[]): Category | undefined {
      return categories.find((c) => matchesSet(host, lists[c].domains));
    },
    status(category: Category): ListStatus {
      const { domains, updatedAt, loading, error } = lists[category];
      return { domains: domains.size, updatedAt, loading: loading !== null, error };
    },
  };
}

export type Blocklists = ReturnType<typeof createBlocklists>;
