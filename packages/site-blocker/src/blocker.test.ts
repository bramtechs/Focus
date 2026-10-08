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

test("key-less fallback blocks distracting domains and is not cached", async () => {
  const { blocker, cache } = mk();
  const r = await blocker.check({ url: "https://www.youtube.com/watch" });
  assert.equal(r.action, "block");
  assert.equal(cache.map.size, 0);
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

const jevBody = { model: "jev", answers: { site_category: { type: "choice", choice: "distracting", probabilities: { distracting: 0.9 }, confidence: 0.7 } } };

test("caching is on by default: repeat visits don't call Jev", async () => {
  let calls = 0;
  const { blocker } = mk({ openrouterApiKey: "k" }, { fetch: async () => (calls++, new Response(JSON.stringify(jevBody))) });
  await blocker.check({ url: "https://a.example/1" });
  await blocker.check({ url: "https://a.example/2" });
  assert.equal(calls, 1);
});

test("cacheEnabled=false stores nothing (only same-burst duplicates are merged)", async () => {
  let calls = 0;
  const { blocker, cache } = mk({ openrouterApiKey: "k", cacheEnabled: false }, { fetch: async () => (calls++, new Response(JSON.stringify(jevBody))) });
  await blocker.check({ url: "https://a.example/" });
  assert.equal(calls, 1); // same-burst duplicate events still share one call
  assert.equal(cache.map.size, 0);
});

test("custom cacheTtlMs expires entries", async () => {
  let calls = 0, t = 1_000_000;
  const { blocker } = mk({ openrouterApiKey: "k", cacheTtlMs: 1000 }, { now: () => t, fetch: async () => (calls++, new Response(JSON.stringify(jevBody))) });
  await blocker.check({ url: "https://a.example/" });
  t += 500; await blocker.check({ url: "https://a.example/" });
  t += 600; await blocker.check({ url: "https://a.example/" });
  assert.equal(calls, 2);
});

test("API failures are cached briefly, not retried every navigation", async () => {
  let calls = 0, t = 1_000_000;
  const { blocker } = mk({ openrouterApiKey: "k" }, { now: () => t, fetch: async () => (calls++, new Response("x", { status: 500 })) });
  await blocker.check({ url: "https://a.example/" });
  await blocker.check({ url: "https://a.example/" });
  assert.equal(calls, 1);
  t += 6 * 60 * 1000;
  await blocker.check({ url: "https://a.example/" });
  assert.equal(calls, 2);
});

test("stale key-less fallback entries are ignored once a key is set", async () => {
  let calls = 0;
  const { blocker, cache } = mk({ openrouterApiKey: "k" }, { fetch: async () => (calls++, new Response(JSON.stringify(jevBody))) });
  cache.map.set("a.example", { verdict: "productive", probability: 0.8, distractingProbability: 0.2, confidence: 0.5, model: "fallback-heuristic", source: "fallback", timestamp: Date.now() });
  await blocker.check({ url: "https://a.example/" });
  assert.equal(calls, 1);
});

test("allowOnce works even with caching disabled", async () => {
  const { blocker } = mk({ cacheEnabled: false });
  await blocker.allowOnce("youtube.com");
  assert.equal((await blocker.check({ url: "https://youtube.com" })).action, "allow");
});

test("onMiss=background allows now and classifies for next time", async () => {
  let calls = 0;
  const body = {
    model: "jev",
    answers: { site_category: { type: "choice", choice: "distracting", probabilities: { distracting: 0.9 }, confidence: 0.7 } },
  };
  const { blocker, cache } = mk(
    { openrouterApiKey: "k" },
    { fetch: async () => (calls++, new Response(JSON.stringify(body))) }
  );
  const first = await blocker.check({ url: "https://example.org/" }, { onMiss: "background" });
  assert.equal(first.action === "allow" && first.reason, "pending");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cache.map.get("example.org")?.source, "jev");
  const second = await blocker.check({ url: "https://example.org/" }, { onMiss: "background" });
  assert.equal(second.action, "block");
  assert.equal(calls, 1);
});

test("onMiss=fallback never calls Jev but still uses cached verdicts", async () => {
  let calls = 0;
  const { blocker, cache } = mk({ openrouterApiKey: "k" }, { fetch: async () => (calls++, new Response("")) });
  assert.equal((await blocker.check({ url: "https://youtube.com/" }, { onMiss: "fallback" })).action, "block");
  assert.equal((await blocker.check({ url: "https://example.org/" }, { onMiss: "fallback" })).action, "allow");
  await cache.set("example.org", {
    verdict: "distracting", probability: 0.9, distractingProbability: 0.9, confidence: 1,
    model: "jev", source: "jev", timestamp: Date.now(),
  });
  assert.equal((await blocker.check({ url: "https://example.org/" }, { onMiss: "fallback" })).action, "block");
  assert.equal(calls, 0);
  assert.equal(cache.map.size, 1);
});

test("onMiss=background without a key decides immediately with the offline heuristic", async () => {
  const { blocker } = mk();
  assert.equal((await blocker.check({ url: "https://youtube.com/" }, { onMiss: "background" })).action, "block");
});
