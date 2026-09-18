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
