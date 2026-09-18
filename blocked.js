/* Blocked interstitial page */
const params = new URLSearchParams(location.search);
const domain = (params.get("domain") || "").toLowerCase();
const originalUrl = params.get("url") || "";
const p = params.get("p") || "?";
const c = params.get("c") || "?";
const m = params.get("m") || "?";
const s = params.get("s") || "jev";

document.getElementById("domain").textContent = domain || "this site";
document.getElementById("detail").textContent =
  `P(distracting) = ${p} · confidence = ${c} · model = ${m} · source = ${s}` +
  (originalUrl ? ` · tried to visit ${originalUrl.slice(0, 120)}` : "");

document.getElementById("back").addEventListener("click", () => {
  if (history.length > 1) history.back();
  else window.close();
});

document.getElementById("proceed").addEventListener("click", async () => {
  if (domain) await chrome.runtime.sendMessage({ type: "allowOnce", domain });
  if (originalUrl) location.href = originalUrl;
});

document.getElementById("allow").addEventListener("click", async () => {
  if (!domain) return;
  const cur = await chrome.storage.sync.get({ allowlist: [], blocklist: [] });
  const allowlist = new Set((cur.allowlist || []).map((d) => String(d).toLowerCase()));
  allowlist.add(domain);
  await chrome.storage.sync.set({
    allowlist: [...allowlist],
    blocklist: (cur.blocklist || []).filter((d) => d !== domain),
  });
  if (originalUrl) location.href = originalUrl;
});

document.getElementById("settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
