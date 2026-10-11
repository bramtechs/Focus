import { DECISIONS_URL, type FetchLike } from "@focus/site-blocker";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Jev spend, persisted across restarts. */
export interface JevUsage {
  calls: number;
  /** USD, as reported by OpenRouter in each Decisions response. */
  cost: number;
  /** Epoch ms counting started. */
  since: number;
}

export interface UsageMeterOptions {
  load: () => JevUsage;
  save: (usage: JevUsage) => Promise<void>;
  now?: () => number;
}

export function createUsageMeter(options: UsageMeterOptions) {
  const now = options.now ?? Date.now;
  const started = now();
  // Calls in the last 24 h, for the projection.
  const recent: { time: number; cost: number }[] = [];

  function record(cost: number) {
    const time = now();
    recent.push({ time, cost });
    while (recent.length && recent[0].time < time - DAY_MS) recent.shift();
    const total = options.load();
    void options.save({ ...total, calls: total.calls + 1, cost: total.cost + cost });
  }

  return {
    record,
    /** Wrap `fetch` so every Jev call made through it is metered. */
    meter(doFetch: FetchLike): FetchLike {
      return async (input, init) => {
        const res = await doFetch(input, init);
        if (res.ok && input.startsWith(DECISIONS_URL)) {
          res
            .clone()
            .json()
            .then((data: any) => record(Number(data?.usage?.cost) || 0))
            .catch(() => {});
        }
        return res;
      };
    },
    status() {
      const time = now();
      const window = recent.filter((c) => c.time >= time - DAY_MS);
      const windowCost = window.reduce((sum, c) => sum + c.cost, 0);
      // Average over the last 24 h, or since startup if that's shorter. Early on this
      // overestimates: a fresh cache sees mostly new domains.
      const windowMs = Math.min(DAY_MS, time - started);
      return {
        total: options.load(),
        last24h: { calls: window.length, cost: windowCost },
        windowMs,
        // Shorter windows are dominated by first-time domains and wildly overestimate.
        perMonth: windowMs >= 60 * 60_000 ? (windowCost / windowMs) * 30 * DAY_MS : null,
      };
    },
  };
}

export type UsageMeter = ReturnType<typeof createUsageMeter>;
