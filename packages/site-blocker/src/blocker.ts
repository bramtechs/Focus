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

export type CheckResult =
  | {
      action: "allow";
      reason: "disabled" | "ignored" | "allowlist" | "classified";
      /** Present when reason is "classified". */
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
  check(input: CheckInput): Promise<CheckResult>;
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

  const isBlocking = (c: Classification, threshold: number) =>
    c.verdict === "distracting" &&
    Number(c.distractingProbability ?? c.probability ?? 0) >= threshold;

  return {
    async check(input) {
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

      // Fresh cache hit?
      const cached = await options.cache.get(domain);
      if (cached && now() - (cached.timestamp || 0) < CACHE_TTL_MS) {
        return isBlocking(cached, settings.threshold)
          ? { action: "block", domain, classification: cached, fresh: false }
          : { action: "allow", reason: "classified", domain, classification: cached, fresh: false };
      }

      // Share one classification between concurrent checks of the same domain.
      let task = inflight.get(domain);
      let fresh = false;
      if (!task) {
        fresh = true;
        task = (async () => {
          const result = await classify(domain, input, settings);
          const entry: CachedClassification = { ...result, timestamp: now() };
          await options.cache.set(domain, entry);
          return { result, fresh: true };
        })().finally(() => inflight.delete(domain));
        inflight.set(domain, task);
      }
      const { result } = await task;
      return isBlocking(result, settings.threshold)
        ? { action: "block", domain, classification: result, fresh }
        : { action: "allow", reason: "classified", domain, classification: result, fresh };
    },

    async recheck(domain) {
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
        // Back-date so the entry expires ALLOW_ONCE_MS from now.
        timestamp: now() - CACHE_TTL_MS + ALLOW_ONCE_MS,
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
