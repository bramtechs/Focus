import { Packet } from "dns2";

export interface QueryLogEntry {
  /** Increasing id, so the dashboard can tell new entries apart. */
  id: number;
  time: number;
  client: string;
  name: string;
  type: string;
  action: "allow" | "block";
  reason: string;
  /** The domain the decision was about (registrable domain for Jev, listed host for filters). */
  domain?: string;
  /** P(distracting) when Jev or the offline list classified the domain. */
  score?: number;
  ms: number;
}

export interface QueryLogFilter {
  limit?: number;
  action?: "allow" | "block";
  /** Substring of the name or client. */
  search?: string;
  /** Only entries newer than this id, so the dashboard can fetch just what's new. */
  after?: number;
}

const TYPE_NAMES = new Map<number, string>([
  ...Object.entries(Packet.TYPE).map(([name, code]) => [code as number, name] as const),
  [64, "SVCB"],
  [65, "HTTPS"],
]);

export const typeName = (type: number) => TYPE_NAMES.get(type) ?? `TYPE${type}`;

/** The most recent `size` queries, in memory only. */
export function createQueryLog(size = 2000) {
  const entries: QueryLogEntry[] = [];
  let nextId = 1;

  return {
    add(entry: Omit<QueryLogEntry, "id">): void {
      entries.push({ id: nextId++, ...entry });
      if (entries.length > size) entries.splice(0, entries.length - size);
    },
    /** Newest first. */
    list({ limit = 200, action, search, after = 0 }: QueryLogFilter = {}): QueryLogEntry[] {
      const needle = search?.trim().toLowerCase();
      const out: QueryLogEntry[] = [];
      for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
        const e = entries[i];
        if (e.id <= after) break;
        if (action && e.action !== action) continue;
        if (needle && !e.name.includes(needle) && !e.client.includes(needle)) continue;
        out.push(e);
      }
      return out;
    },
  };
}

export type QueryLog = ReturnType<typeof createQueryLog>;
