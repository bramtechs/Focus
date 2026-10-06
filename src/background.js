/* Focus — background service worker (Manifest V3)
 *
 * Browser glue around @focus/site-blocker, which owns classification (Jev via
 * OpenRouter's Decisions API), allow/block lists, caching and thresholds.
 * Docs: https://docs.typesafe.ai/concepts/system-one
 */

import {
  DEFAULT_MODEL,
  clampNumber,
  createSiteBlocker,
  getHostname,
  normalizeDomainList,
} from "@focus/site-blocker";

const DEFAULT_THRESHOLD = 0.6;

/* ---------------- storage adapters ---------------- */

async function getSettings() {
  const sync = await chrome.storage.sync.get({
    openrouterApiKey: "",
    enabled: true,
    threshold: DEFAULT_THRESHOLD,
    model: DEFAULT_MODEL,
    allowlist: [],
    blocklist: [],
    cacheEnabled: true,
  });
  sync.cacheEnabled = sync.cacheEnabled !== false;
  // Options page stores one domain per line; the library wants arrays.
  sync.allowlist = normalizeDomainList(sync.allowlist);
  sync.blocklist = normalizeDomainList(sync.blocklist);
  sync.threshold = clampNumber(Number(sync.threshold), 0.3, 0.9, DEFAULT_THRESHOLD);
  if (typeof sync.model !== "string" || !sync.model) sync.model = DEFAULT_MODEL;
  return sync;
}

async function getCache() {
  const { decisions = {} } = await chrome.storage.local.get({ decisions: {} });
  return decisions;
}

const cache = {
  async get(domain) {
    return (await getCache())[domain];
  },
  async set(domain, value) {
    const decisions = await getCache();
    decisions[domain] = value;
    await chrome.storage.local.set({ decisions });
  },
  async delete(domain) {
    const decisions = await getCache();
    delete decisions[domain];
    await chrome.storage.local.set({ decisions });
  },
};

async function bumpStat(key) {
  const stats = await chrome.storage.local.get({
    checkedCount: 0,
    blockedCount: 0,
  });
  stats[key] = (Number(stats[key]) || 0) + 1;
  await chrome.storage.local.set({
    checkedCount: stats.checkedCount,
    blockedCount: stats.blockedCount,
  });
}

const blocker = createSiteBlocker({
  getSettings,
  cache,
  headers: { "HTTP-Referer": "https://github.com/focus-extension", "X-Title": "Focus" },
});

/* ---------------- blocking ---------------- */

function isExtensionPage(url) {
  return url.startsWith(chrome.runtime.getURL(""));
}

function blockedPageUrl({ domain, pageUrl, probability, confidence, model, source }) {
  const params = new URLSearchParams({
    domain,
    url: pageUrl,
    p: String(probability?.toFixed?.(2) ?? probability ?? ""),
    c: String(confidence?.toFixed?.(2) ?? confidence ?? ""),
    m: model || "",
    s: source || "",
  });
  return chrome.runtime.getURL(`blocked.html?${params.toString()}`);
}

async function redirectTab(tabId, toUrl) {
  try {
    await chrome.tabs.update(tabId, { url: toUrl });
  } catch {
    // Tab may have closed already; ignore.
  }
}

async function handleNavigation({ tabId, url, title }) {
  if (tabId == null || tabId < 0) return;
  if (isExtensionPage(url)) return;

  const result = await blocker.check({
    url,
    title,
    // Enrich state with the live tab title (best effort).
    getTitle: async () => (await chrome.tabs.get(tabId)).title,
  });

  if (result.fresh) await bumpStat("checkedCount");
  if (result.classification?.error) {
    console.warn("[Focus] Jev classification failed, using fallback:", result.classification.error);
  }
  if (result.action !== "block") return;

  // A fresh classification is async; only redirect if the tab is still on the same host.
  if (result.fresh) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab?.url || getHostname(tab.url) !== getHostname(url)) return;
    } catch {
      return; // tab closed
    }
  }
  await bumpStat("blockedCount");
  await redirectTab(
    tabId,
    blockedPageUrl({ domain: result.domain, pageUrl: url, ...result.classification })
  );
}

/* ---------------- events ---------------- */

chrome.webNavigation.onBeforeNavigate.addListener(
  (details) => {
    if (details.frameId !== 0) return; // top frame only
    handleNavigation({ tabId: details.tabId, url: details.url }).catch((e) =>
      console.warn("[Focus]", e)
    );
  },
  { url: [{ schemes: ["http", "https"] }] }
);

// Fired for SPA navigations that don't trigger onBeforeNavigate reliably.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading" || !tab.url) return;
  handleNavigation({ tabId, url: tab.url, title: tab.title }).catch((e) =>
    console.warn("[Focus]", e)
  );
});

// Popup / blocked page / options ask the worker to do things.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "recheck") {
      await blocker.recheck(msg.domain);
      sendResponse({ ok: true });
    } else if (msg?.type === "allowOnce") {
      await blocker.allowOnce(msg.domain);
      sendResponse({ ok: true });
    } else if (msg?.type === "testApiKey") {
      try {
        const result = await blocker.testApiKey(msg.apiKey, msg.model);
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    } else {
      sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // keep channel open for async sendResponse
});
