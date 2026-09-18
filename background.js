/* Focus — background service worker (Manifest V3)
 *
 * Uses TypeSafe's Jev System One classification model through OpenRouter's
 * Decisions API to decide whether a domain is distracting, then blocks it.
 *
 * Docs: https://docs.typesafe.ai/concepts/system-one
 * Decisions endpoint (OpenRouter): POST https://openrouter.ai/api/alpha/decisions
 * Request shape mirrors the TypeSafe API: { model, state, questions }
 * with a Choice classification question (productive vs distracting).
 */

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const DEFAULT_MODEL = "typesafe/jev-1.13"; // pinned; alt: "~typesafe/jev-latest"
const DEFAULT_THRESHOLD = 0.6;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days per domain

const QUESTION_ID = "site_category";
const QUESTION = {
  type: "choice",
  instructions:
    "Is visiting this website productive for focused work, or is it distracting?",
  criteria: {
    productive:
      "Work, study, documentation, coding, email, calendar, maps, banking, task-driven search, productivity tools, or news directly needed for work",
    distracting:
      "Social media feeds, short-video doomscrolling, entertainment, gaming, gambling, viral videos, memes, celebrity gossip, aimless browsing, adult content, or shopping for fun",
  },
};

// Fallback heuristic when no API key is set or the API is unreachable,
// so the extension is still useful offline. Jev remains the source of
// truth whenever a key is configured.
const FALLBACK_DISTRACTING = new Set([
  "youtube.com",
  "tiktok.com",
  "instagram.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "reddit.com",
  "netflix.com",
  "hulu.com",
  "disneyplus.com",
  "twitch.tv",
  "discord.com",
  "pinterest.com",
  "tumblr.com",
  "snapchat.com",
  "roblox.com",
  "epicgames.com",
  "steamcommunity.com",
  "store.steampowered.com",
  "9gag.com",
  "buzzfeed.com",
  "dailymail.co.uk",
  "theonion.com",
]);

/* ---------------- storage helpers ---------------- */

async function getSettings() {
  const sync = await chrome.storage.sync.get({
    openrouterApiKey: "",
    enabled: true,
    threshold: DEFAULT_THRESHOLD,
    model: DEFAULT_MODEL,
    allowlist: [],
    blocklist: [],
  });
  // Normalize lists (options page stores one domain per line, we store arrays)
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

async function setCachedDecision(domain, decision) {
  const decisions = await getCache();
  decisions[domain] = { ...decision, timestamp: Date.now() };
  await chrome.storage.local.set({ decisions });
}

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

function normalizeDomainList(list) {
  if (!Array.isArray(list)) {
    if (typeof list === "string") list = list.split(/[\n,]+/);
    else return [];
  }
  return [
    ...new Set(
      list
        .map((d) => String(d).trim().toLowerCase().replace(/^www\./, ""))
        .filter(Boolean)
    ),
  ];
}

function clampNumber(n, min, max, fallback) {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* ---------------- domain helpers ---------------- */

function getHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function registrableDomain(hostname) {
  const host = hostname.replace(/^www\./, "");
  return host;
}

function matchesList(domain, list) {
  return list.some((entry) => domain === entry || domain.endsWith("." + entry));
}

function isExtensionPage(url) {
  return url.startsWith(chrome.runtime.getURL(""));
}

function isNavigable(url) {
  return url.startsWith("http://") || url.startsWith("https://");
}

/* ---------------- Jev via OpenRouter ---------------- */

function buildState(domain, pageUrl, title) {
  return (
    `Decide whether visiting this website supports focused, productive work.\n` +
    `Domain: ${domain}\n` +
    `Full URL: ${pageUrl}\n` +
    `Page title: ${title || "(unknown)"}\n` +
    `User goal: stay productive while using a web browser. Block the domain only if it is distracting.`
  );
}

/**
 * Call Jev through OpenRouter Decisions API.
 * Returns { verdict: 'productive'|'distracting', probability, confidence, model }
 */
async function classifyWithJev({ domain, pageUrl, title, apiKey, model }) {
  const res = await fetch(DECISIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/focus-extension",
      "X-Title": "Focus",
    },
    body: JSON.stringify({
      model,
      state: buildState(domain, pageUrl, title),
      questions: { [QUESTION_ID]: QUESTION },
    }),
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error("Invalid OpenRouter API key (401/403). Check Options.");
  }
  if (res.status === 429) {
    throw new Error("Rate limited (429). Retrying later.");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Decisions API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const answer = data?.answers?.[QUESTION_ID];
  if (!answer || answer.type !== "choice" || typeof answer.choice !== "string") {
    throw new Error("Unexpected Decisions API response shape.");
  }

  const choice = answer.choice.toLowerCase();
  const probs = answer.probabilities || {};
  // Probabilities keys mirror our criteria keys; be case-tolerant.
  const pDistracting =
    Number(probs.distracting ?? probs.Distracting ?? probs.DISTRACTING) || 0;
  const confidence = Number(answer.confidence) || 0;

  return {
    verdict: choice === "distracting" ? "distracting" : "productive",
    probability: choice === "distracting" ? pDistracting : 1 - pDistracting,
    distractingProbability: pDistracting,
    confidence,
    model: data?.model || model,
    source: "jev",
  };
}

function fallbackClassify(domain) {
  const base = registrableDomain(domain);
  const distracting =
    FALLBACK_DISTRACTING.has(base) || matchesList(base, [...FALLBACK_DISTRACTING]);
  return {
    verdict: distracting ? "distracting" : "productive",
    probability: distracting ? 0.8 : 0.8,
    distractingProbability: distracting ? 0.8 : 0.2,
    confidence: 0.5,
    model: "fallback-heuristic",
    source: "fallback",
  };
}

/* ---------------- blocking ---------------- */

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

const inflight = new Map(); // domain -> Promise (dedupe rapid navigations)

async function handleNavigation({ tabId, url, title }) {
  if (tabId == null || tabId < 0) return;
  if (!isNavigable(url) || isExtensionPage(url)) return;

  const settings = await getSettings();
  if (!settings.enabled) return;

  const hostname = getHostname(url);
  if (!hostname) return;
  const domain = registrableDomain(hostname);

  // User overrides win over everything.
  if (matchesList(domain, settings.allowlist)) return;
  if (matchesList(domain, settings.blocklist)) {
    await bumpStat("blockedCount");
    await redirectTab(
      tabId,
      blockedPageUrl({
        domain,
        pageUrl: url,
        probability: 1,
        confidence: 1,
        model: "user-blocklist",
        source: "blocklist",
      })
    );
    return;
  }

  // Fresh cache hit?
  const decisions = await getCache();
  const cached = decisions[domain];
  if (cached && Date.now() - (cached.timestamp || 0) < CACHE_TTL_MS) {
    if (
      cached.verdict === "distracting" &&
      Number(cached.distractingProbability ?? cached.probability ?? 0) >=
        settings.threshold
    ) {
      await bumpStat("blockedCount");
      await redirectTab(tabId, blockedPageUrl({ domain, pageUrl: url, ...cached }));
    }
    return;
  }

  // Dedupe concurrent checks for the same domain.
  if (inflight.has(domain)) return;
  const task = (async () => {
    let result;
    if (!settings.openrouterApiKey) {
      result = fallbackClassify(domain);
    } else {
      try {
        // Try to enrich state with the tab title (best effort).
        let enrichedTitle = title || "";
        try {
          const tab = await chrome.tabs.get(tabId);
          enrichedTitle = tab.title || enrichedTitle;
        } catch {
          /* ignore */
        }
        result = await classifyWithJev({
          domain,
          pageUrl: url,
          title: enrichedTitle,
          apiKey: settings.openrouterApiKey,
          model: settings.model,
        });
      } catch (err) {
        console.warn("[Focus] Jev classification failed, using fallback:", err);
        result = { ...fallbackClassify(domain), error: String(err?.message || err) };
      }
    }

    await setCachedDecision(domain, result);
    await bumpStat("checkedCount");

    const score = Number(result.distractingProbability ?? 0);
    if (result.verdict === "distracting" && score >= settings.threshold) {
      // Only redirect if the tab is still on the same domain.
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.url && getHostname(tab.url) === hostname) {
          await bumpStat("blockedCount");
          await redirectTab(tabId, blockedPageUrl({ domain, pageUrl: url, ...result }));
        }
      } catch {
        /* tab closed */
      }
    }
  })().finally(() => inflight.delete(domain));

  inflight.set(domain, task);
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
      const decisions = await getCache();
      delete decisions[msg.domain];
      await chrome.storage.local.set({ decisions });
      sendResponse({ ok: true });
    } else if (msg?.type === "allowOnce") {
      // Cache a temporary productive verdict (1h) so the user can proceed.
      await setCachedDecision(msg.domain, {
        verdict: "productive",
        probability: 1,
        distractingProbability: 0,
        confidence: 1,
        model: "allow-once",
        source: "allow-once",
        timestamp: Date.now() - CACHE_TTL_MS + 60 * 60 * 1000,
      });
      sendResponse({ ok: true });
    } else if (msg?.type === "testApiKey") {
      try {
        const result = await classifyWithJev({
          domain: "youtube.com",
          pageUrl: "https://www.youtube.com/",
          title: "YouTube",
          apiKey: msg.apiKey,
          model: msg.model || DEFAULT_MODEL,
        });
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
