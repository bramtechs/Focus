/* Focus options page — OpenRouter API key + Jev settings */
const $ = (id) => document.getElementById(id);

function listToText(list) {
  return (Array.isArray(list) ? list : []).join("\n");
}
function textToList(text) {
  return [
    ...new Set(
      String(text || "")
        .split(/[\n,]+/)
        .map((d) => d.trim().toLowerCase().replace(/^www\./, ""))
        .filter(Boolean)
    ),
  ];
}

async function load() {
  const s = await chrome.storage.sync.get({
    openrouterApiKey: "",
    model: "typesafe/jev-1.13",
    threshold: 0.6,
    allowlist: [],
    blocklist: [],
  });
  $("apiKey").value = s.openrouterApiKey || "";
  $("model").value = s.model || "typesafe/jev-1.13";
  $("threshold").value = s.threshold ?? 0.6;
  $("thresholdVal").textContent = Number($("threshold").value).toFixed(2);
  $("allowlist").value = listToText(s.allowlist);
  $("blocklist").value = listToText(s.blocklist);

  const stats = await chrome.storage.local.get({ checkedCount: 0, blockedCount: 0 });
  $("stats").textContent = `${stats.checkedCount} domains checked · ${stats.blockedCount} blocked`;
}

document.addEventListener("DOMContentLoaded", () => {
  load();

  $("threshold").addEventListener("input", (e) => {
    $("thresholdVal").textContent = Number(e.target.value).toFixed(2);
  });

  $("toggleKey").addEventListener("click", () => {
    const input = $("apiKey");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("toggleKey").textContent = show ? "Hide" : "Show";
  });

  $("save").addEventListener("click", async () => {
    await chrome.storage.sync.set({
      openrouterApiKey: $("apiKey").value.trim(),
      model: $("model").value,
      threshold: Number($("threshold").value),
    });
    $("saveStatus").textContent = "✓ Saved";
    setTimeout(() => ($("saveStatus").textContent = ""), 2000);
    load();
  });

  $("saveLists").addEventListener("click", async () => {
    await chrome.storage.sync.set({
      allowlist: textToList($("allowlist").value),
      blocklist: textToList($("blocklist").value),
    });
    $("listsStatus").textContent = "✓ Lists saved";
    setTimeout(() => ($("listsStatus").textContent = ""), 2000);
  });

  $("clearCache").addEventListener("click", async () => {
    await chrome.storage.local.set({ decisions: {} });
    $("listsStatus").textContent = "✓ Cache cleared";
    setTimeout(() => ($("listsStatus").textContent = ""), 2000);
    load();
  });

  $("test").addEventListener("click", async () => {
    const btn = $("test");
    btn.disabled = true;
    $("testResult").textContent = "testing…";
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "testApiKey",
        apiKey: $("apiKey").value.trim(),
        model: $("model").value,
      });
      if (resp?.ok) {
        const r = resp.result;
        $("testResult").textContent =
          `✓ Jev answered: ${r.verdict} (P(distracting)=${Number(r.distractingProbability).toFixed(2)}, conf=${Number(r.confidence).toFixed(2)}, model=${r.model})`;
      } else {
        $("testResult").textContent = `✗ ${resp?.error || "failed"}`;
      }
    } catch (e) {
      $("testResult").textContent = `✗ ${e.message}`;
    } finally {
      btn.disabled = false;
    }
  });
});
