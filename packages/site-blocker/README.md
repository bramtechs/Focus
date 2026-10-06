# @focus/site-blocker

Platform-agnostic site-blocking core extracted from the Focus extension: Jev
(via OpenRouter Decisions API) classification, offline fallback heuristic,
allow/block lists, per-domain caching and threshold logic. No `chrome.*` calls —
you provide settings and a cache store.

```ts
import { createSiteBlocker } from "@focus/site-blocker";

const blocker = createSiteBlocker({
  getSettings: () => ({ enabled: true, openrouterApiKey, threshold: 0.6,
    model: "typesafe/jev-1.13", allowlist: [], blocklist: [] }),
  cache: { get, set, delete }, // async Map-like store keyed by domain
});

const r = await blocker.check({ url: "https://youtube.com/" });
if (r.action === "block") redirectToBlockedPage(r.domain, r.classification);
```

Also exposes `recheck(domain)`, `allowOnce(domain)` and `testApiKey(key)`.
Optional `fetch` and `now` can be injected (useful for tests).

Build: `npm run build` · Test: `npm test` (from the repo root).
