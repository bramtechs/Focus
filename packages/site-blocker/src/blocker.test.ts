import { test } from "node:test";
import assert from "node:assert/strict";
import { createSiteBlocker } from "./blocker.js";
import type { CachedClassification, CacheStore, Settings } from "./types.js";

const settings: Settings = {
  enabled: true,
  openrouterApiKey: "",
  threshold: 0.6,
  model: "m",
  allowlist: ["docs.example.com"],
  blocklist: ["bad.example"],
};

function memCache(): CacheStore & { map: Map<string, CachedClassification> } {
  const map = new Map<string, CachedClassification>();
  return {
    map,
    get: async (d) => map.get(d),
    set: async (d, v) => void map.set(d, v),
    delete: async (d) => void map.delete(d),
  };
}

const mk = (over: Partial<Settings> = {}, extra = {}) => {
  const cache = memCache();
  return {
    cache,
    blocker: createSiteBlocker({ getSettings: () => ({ ...settings, ...over }), cache, ...extra }),
  };
};

test("ignores non-http and honours enabled flag", async () => {
  const { blocker } = mk({ enabled: false });
  assert.equal((await blocker.check({ url: "chrome://x" })).action, "allow");
  assert.deepEqual(await blocker.check({ url: "https://youtube.com" }), {
    action: "allow",
    reason: "disabled",
  });
});

test("allowlist and blocklist overrides", async () => {
  const { blocker } = mk();
  const allow = await blocker.check({ url: "https://docs.example.com/a" });
  assert.equal(allow.action === "allow" && allow.reason, "allowlist");
  const block = await blocker.check({ url: "https://www.bad.example/" });
  assert.equal(block.action, "block");
  if (block.action === "block") assert.equal(block.classification.source, "blocklist");
});

test("fallback blocks distracting domains and caches", async () => {
  const { blocker, cache } = mk();
  const r = await blocker.check({ url: "https://www.youtube.com/watch" });
  assert.equal(r.action, "block");
  if (r.action === "block") assert.equal(r.fresh, true);
  assert.ok(cache.map.has("youtube.com"));
  const again = await blocker.check({ url: "https://youtube.com/" });
  if (again.action === "block") assert.equal(again.fresh, false);
  else assert.fail("expected block");
});

test("uses Jev when key set, falls back on error", async () => {
  const body = {
    model: "jev",
    answers: { site_category: { type: "choice", choice: "distracting", probabilities: { distracting: 0.9 }, confidence: 0.7 } },
  };
  const ok = mk({ openrouterApiKey: "k" }, { fetch: async () => new Response(JSON.stringify(body)) });
  const r = await ok.blocker.check({ url: "https://example.org/" });
  assert.equal(r.action, "block");
  if (r.action === "block") assert.equal(r.classification.source, "jev");

  const bad = mk({ openrouterApiKey: "k" }, { fetch: async () => new Response("no", { status: 500 }) });
  const r2 = await bad.blocker.check({ url: "https://example.org/" });
  assert.equal(r2.action, "allow");
  if (r2.action === "allow") assert.match(r2.classification?.error ?? "", /500/);
});

test("allowOnce expires after an hour; recheck clears cache", async () => {
  let t = 1_000_000_000_000;
  const { blocker, cache } = mk({}, { now: () => t });
  await blocker.allowOnce("youtube.com");
  assert.equal((await blocker.check({ url: "https://youtube.com" })).action, "allow");
  t += 61 * 60 * 1000;
  assert.equal((await blocker.check({ url: "https://youtube.com" })).action, "block");
  await blocker.recheck("youtube.com");
  assert.ok(!cache.map.has("youtube.com"));
});

test("concurrent checks share one classification", async () => {
  let calls = 0;
  const body = { answers: { site_category: { type: "choice", choice: "productive", probabilities: { distracting: 0.1 } } } };
  const { blocker } = mk({ openrouterApiKey: "k" }, { fetch: async () => (calls++, new Response(JSON.stringify(body))) });
  await Promise.all([blocker.check({ url: "https://a.com" }), blocker.check({ url: "https://a.com" })]);
  assert.equal(calls, 1);
});
