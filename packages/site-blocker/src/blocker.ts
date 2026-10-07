import { getHostname, isNavigable, matchesList, registrableDomain } from "./domain.js";
import { fallbackClassify } from "./fallback.js";
import { classifyWithJev, DEFAULT_MODEL } from "./jev.js";
import type {
  CachedClassification,
  CacheStore,
  Classification,
  FetchLike,
  Settings,
} from "./types.js";

export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days per domain
const ALLOW_ONCE_MS = 60 * 60 * 1000; // 1 hour
/** After a failed Jev call, reuse the fallback verdict this long instead of retrying every navigation. */
export const ERROR_TTL_MS = 5 * 60 * 1000;
/** With caching off, still merge the duplicate events one navigation fires (e.g. onBeforeNavigate + tabs.onUpdated). */
const BURST_DEDUPE_MS = 3000;

export interface SiteBlockerOptions {
  /** Current settings; called on every check so changes apply immediately. */
  getSettings: () => Settings | Promise<Settings>;
  cache: CacheStore;
  fetch?: FetchLike;
  now?: () => number;
  /** Extra headers for the OpenRouter request. */
  headers?: Record<string, string>;
}

export interface CheckInput {
  url: string;
  title?: string;
  /** Resolve a fresher page title lazily (only called when Jev is queried). */
  getTitle?: () => Promise<string | undefined> | string | undefined;
}

/**
 * What to do when a domain has no usable cached verdict:
 * - "classify" (default): classify now (Jev, or the offline heuristic without a key) and wait.
 * - "background": start classifying for next time, but allow this check ("pending").
 * - "fallback": never call Jev; decide with the offline heuristic (not cached).
 */
export type MissPolicy = "classify" | "background" | "fallback";

export interface CheckOptions {
  onMiss?: MissPolicy;
}

export type CheckResult =
  | {
      action: "allow";
      reason: "disabled" | "ignored" | "allowlist" | "classified" | "pending";
      /** Present when reason is "classified" or "pending". */
      domain?: string;
      classification?: Classification;
      fresh?: boolean;
    }
  | {
      action: "block";
      domain: string;
      classification: Classification;
      /** True when this call performed a fresh classification (not cache/list). */
      fresh: boolean;
    };

export interface SiteBlocker {
  check(input: CheckInput, options?: CheckOptions): Promise<CheckResult>;
  /** Drop the cached verdict for a domain so it's re-classified next time. */
  recheck(domain: string): Promise<void>;
  /** Temporarily mark a domain productive (1h). */
  allowOnce(domain: string): Promise<void>;
  /** Validate an API key with a known-distracting domain. */
  testApiKey(apiKey: string, model?: string): Promise<Classification>;
}

export function createSiteBlocker(options: SiteBlockerOptions): SiteBlocker {
  const now = options.now ?? Date.now;
  const inflight = new Map<string, Promise<{ result: Classification; fresh: boolean }>>();

  const jev = (args: {
    domain: string;
    pageUrl: string;
    title?: string;
    apiKey: string;
    model: string;
  }) => classifyWithJev({ ...args, fetch: options.fetch, headers: options.headers });

  async function classify(
    domain: string,
    input: CheckInput,
    settings: Settings
  ): Promise<Classification> {
    if (!settings.openrouterApiKey) return fallbackClassify(domain);
    try {
      let title = input.title || "";
      try {
        title = (await input.getTitle?.()) || title;
      } catch {
        /* best effort */
      }
      return await jev({
        domain,
        pageUrl: input.url,
        title,
        apiKey: settings.openrouterApiKey,
        model: settings.model,
      });
    } catch (err) {
      return {
        ...fallbackClassify(domain),
        error: String((err as Error)?.message || err),
      };
    }
  }

  function isUsable(c: CachedClassification, settings: Settings): boolean {
    if (c.source === "allow-once") return now() < (c.expiresAt ?? 0);
    if (settings.cacheEnabled === false) return false;
    // A fallback verdict is only a stand-in until a key is set; never prefer it over Jev.
    if (c.source === "fallback" && settings.openrouterApiKey && !c.error) return false;
    return now() < (c.expiresAt ?? (c.timestamp || 0) + CACHE_TTL_MS);
  }

  function toCacheEntry(r: Classification, settings: Settings): CachedClassification | null {
    if (settings.cacheEnabled === false) return null;
    // The free offline heuristic has nothing to save, so don't cache it.
    if (r.source === "fallback" && !r.error) return null;
    const ttl = r.error ? ERROR_TTL_MS : settings.cacheTtlMs ?? CACHE_TTL_MS;
    const t = now();
    return { ...r, timestamp: t, expiresAt: t + ttl };
  }

  const isBlocking = (c: Classification, threshold: number) =>
    c.verdict === "distracting" &&
    Number(c.distractingProbability ?? c.probability ?? 0) >= threshold;

  return {
    async check(input, checkOptions = {}) {
      if (!isNavigable(input.url)) return { action: "allow", reason: "ignored" };
      const settings = await options.getSettings();
      if (!settings.enabled) return { action: "allow", reason: "disabled" };

      const hostname = getHostname(input.url);
      if (!hostname) return { action: "allow", reason: "ignored" };
      const domain = registrableDomain(hostname);

      // User overrides win over everything.
      if (matchesList(domain, settings.allowlist)) {
        return { action: "allow", reason: "allowlist" };
      }
      if (matchesList(domain, settings.blocklist)) {
        return {
          action: "block",
          domain,
          fresh: false,
          classification: {
            verdict: "distracting",
            probability: 1,
            distractingProbability: 1,
            confidence: 1,
            model: "user-blocklist",
            source: "blocklist",
          },
        };
      }

      // Fresh cache hit? (Caching is on by default; allow-once always applies.)
      const cached = await options.cache.get(domain);
      if (cached && isUsable(cached, settings)) {
        return isBlocking(cached, settings.threshold)
          ? { action: "block", domain, classification: cached, fresh: false }
          : { action: "allow", reason: "classified", domain, classification: cached, fresh: false };
      }

      const onMiss = checkOptions.onMiss ?? "classify";
      // Without a key the offline heuristic is instant, so "background" has nothing to defer.
      if (onMiss === "fallback" || (onMiss === "background" && !settings.openrouterApiKey)) {
        const result = fallbackClassify(domain);
        return isBlocking(result, settings.threshold)
          ? { action: "block", domain, classification: result, fresh: false }
          : { action: "allow", reason: "classified", domain, classification: result, fresh: false };
      }

      // Share one classification between concurrent checks of the same domain.
      let task = inflight.get(domain);
      let fresh = false;
      if (!task) {
        fresh = true;
        task = (async () => {
          const result = await classify(domain, input, settings);
          const entry = toCacheEntry(result, settings);
          if (entry) await options.cache.set(domain, entry);
          return { result, fresh: true };
        })().finally(() => {
          if (settings.cacheEnabled === false) {
            const timer: any = setTimeout(() => inflight.delete(domain), BURST_DEDUPE_MS);
            timer.unref?.();
          } else {
            inflight.delete(domain);
          }
        });
        inflight.set(domain, task);
      }
      if (onMiss === "background") {
        task.catch(() => {}); // nobody awaits it here; failures just mean "try again later"
        return { action: "allow", reason: "pending", domain, fresh };
      }
      const { result } = await task;
      return isBlocking(result, settings.threshold)
        ? { action: "block", domain, classification: result, fresh }
        : { action: "allow", reason: "classified", domain, classification: result, fresh };
    },

    async recheck(domain) {
      inflight.delete(domain);
      await options.cache.delete(domain);
    },

    async allowOnce(domain) {
      await options.cache.set(domain, {
        verdict: "productive",
        probability: 1,
        distractingProbability: 0,
        confidence: 1,
        model: "allow-once",
        source: "allow-once",
        timestamp: now(),
        expiresAt: now() + ALLOW_ONCE_MS,
      });
    },

    testApiKey(apiKey, model) {
      return jev({
        domain: "youtube.com",
        pageUrl: "https://www.youtube.com/",
        title: "YouTube",
        apiKey,
        model: model || DEFAULT_MODEL,
      });
    },
  };
}
