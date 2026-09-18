/* Focus popup: current-site status + quick allow/block + API key status */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function refresh() {
  const tab = await getActiveTab();
  const domainEl = document.getElementById("domain");
  const verdictEl = document.getElementById("verdict");
  const detailEl = document.getElementById("detail");
  const keyStatusEl = document.getElementById("keyStatus");
  const enabledEl = document.getElementById("enabled");

  const settings = await chrome.storage.sync.get({
    openrouterApiKey: "",
    enabled: true,
    threshold: 0.6,
    model: "typesafe/jev-1.13",
    allowlist: [],
    blocklist: [],
  });
  enabledEl.checked = settings.enabled !== false;

  const domain = tab?.url ? hostnameOf(tab.url) : "";
  domainEl.textContent = domain || "(not a web page)";

  const hasKey = Boolean(settings.openrouterApiKey);
  keyStatusEl.textContent = hasKey
    ? `✓ OpenRouter API key set · model ${settings.model}`
    : "⚠ No OpenRouter API key — using offline fallback. Open Settings to add one.";

  if (!domain) {
    verdictEl.textContent = "n/a";
    verdictEl.className = "pill warn";
    detailEl.textContent = "";
    return;
  }

  const inAllow = (settings.allowlist || []).some(
    (d) => domain === d || domain.endsWith("." + d)
  );
  const inBlock = (settings.blocklist || []).some(
    (d) => domain === d || domain.endsWith("." + d)
  );

  const { decisions = {} } = await chrome.storage.local.get({ decisions: {} });
  const cached = decisions[domain];

  if (inAllow) {
    verdictEl.textContent = "allowed (allowlist)";
    verdictEl.className = "pill good";
  } else if (inBlock) {
    verdictEl.textContent = "blocked (blocklist)";
    verdictEl.className = "pill bad";
  } else if (cached) {
    const p = Number(cached.distractingProbability ?? cached.probability ?? 0);
    const isBad = cached.verdict === "distracting" && p >= settings.threshold;
    verdictEl.textContent = isBad
      ? `distracting (${Math.round(p * 100)}%)`
      : `productive (${Math.round((1 - p) * 100)}%)`;
    verdictEl.className = "pill " + (isBad ? "bad" : "good");
    detailEl.textContent =
      `via ${cached.model || "?"} · confidence ${cached.confidence ?? "?"} · ` +
      `source: ${cached.source || "jev"}`;
  } else {
    verdictEl.textContent = hasKey ? "not checked yet" : "fallback only";
    verdictEl.className = "pill warn";
    detailEl.textContent = "Visit stays loaded; Jev classifies in the background.";
  }
}

async function modifyList(listName, domain, add) {
  const cur = await chrome.storage.sync.get({ [listName]: [] });
  let list = Array.isArray(cur[listName]) ? cur[listName] : [];
  list = list.map((d) => String(d).toLowerCase());
  if (add && !list.includes(domain)) list.push(domain);
  if (!add) list = list.filter((d) => d !== domain);
  await chrome.storage.sync.set({ [listName]: list });
}

document.addEventListener("DOMContentLoaded", () => {
  refresh();

  document.getElementById("enabled").addEventListener("change", async (e) => {
    await chrome.storage.sync.set({ enabled: e.target.checked });
    refresh();
  });

  document.getElementById("allow").addEventListener("click", async () => {
    const tab = await getActiveTab();
    const domain = hostnameOf(tab?.url || "");
    if (!domain) return;
    await modifyList("allowlist", domain, true);
    await modifyList("blocklist", domain, false);
    refresh();
  });

  document.getElementById("block").addEventListener("click", async () => {
    const tab = await getActiveTab();
    const domain = hostnameOf(tab?.url || "");
    if (!domain) return;
    await modifyList("blocklist", domain, true);
    await modifyList("allowlist", domain, false);
    refresh();
  });

  document.getElementById("recheck").addEventListener("click", async (e) => {
    const tab = await getActiveTab();
    const domain = hostnameOf(tab?.url || "");
    if (!domain) return;
    e.target.disabled = true;
    await chrome.runtime.sendMessage({ type: "recheck", domain });
    // Trigger an immediate re-navigation check by re-invoking classification
    // on next load; for now just reload the tab.
    if (tab?.id != null) chrome.tabs.reload(tab.id).catch(() => {});
    setTimeout(() => {
      e.target.disabled = false;
      refresh();
    }, 800);
  });

  document.getElementById("options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
});
