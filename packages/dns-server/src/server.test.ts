import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import { createSiteBlocker, type CachedClassification, type CacheStore } from "@focus/site-blocker";
import dns2, { Packet } from "dns2";
import { createDashboard } from "./dashboard.js";
import { createResolver } from "./resolver.js";
import { DEFAULT_STATE, type BlockingState } from "./state.js";
import { capTtl, createForwarder, type Forwarder } from "./upstream.js";

const config = { allowlist: ["music.youtube.com"], blocklist: ["bad.example"], waitTimeoutMs: 50, maxTtl: 60, blockTtl: 10 };

function memCache(): CacheStore & { map: Map<string, CachedClassification> } {
  const map = new Map<string, CachedClassification>();
  return { map, get: async (d) => map.get(d), set: async (d, v) => void map.set(d, v), delete: async (d) => void map.delete(d) };
}

/** Real @focus/site-blocker with a fake Jev that calls everything distracting after `latencyMs`. */
function setup(state: Partial<BlockingState> = {}, latencyMs = 0, forward?: Forwarder) {
  const calls: string[] = [];
  const cache = memCache();
  const blocker = createSiteBlocker({
    getSettings: () => ({ enabled: true, openrouterApiKey: "k", threshold: 0.6, model: "jev", allowlist: [], blocklist: [] }),
    cache,
    fetch: async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)).state.match(/Domain: (.*)/)[1]);
      await new Promise((r) => setTimeout(r, latencyMs));
      return new Response(JSON.stringify({
        answers: { site_category: { type: "choice", choice: "distracting", probabilities: { distracting: 0.9 }, confidence: 0.9 } },
      }));
    },
  });
  let current: BlockingState = { ...DEFAULT_STATE, ...state };
  const resolver = createResolver({
    config,
    blocker,
    getState: () => current,
    forward: forward ?? (async () => { throw new Error("no upstream in this test"); }),
  });
  return { resolver, calls, cache, setState: (s: Partial<BlockingState>) => void (current = { ...current, ...s }) };
}

test("blocking off, local names and non-web query types are never classified", async () => {
  const { resolver, calls } = setup({ enabled: false });
  assert.equal((await resolver.decide("youtube.com", Packet.TYPE.A)).reason, "disabled");
  const on = setup();
  assert.equal((await on.resolver.decide("printer.lan", Packet.TYPE.A)).reason, "local");
  assert.equal((await on.resolver.decide("4.3.2.1.in-addr.arpa", Packet.TYPE.PTR)).reason, "type");
  assert.equal((await on.resolver.decide("1.2.3.4", Packet.TYPE.A)).reason, "local");
  assert.equal((await on.resolver.decide("youtube.com", Packet.TYPE.MX)).reason, "type");
  assert.deepEqual([...calls, ...on.calls], []);
});

test("lists match exact hosts; Jev classifies the registrable domain once", async () => {
  const { resolver, calls } = setup();
  assert.equal((await resolver.decide("music.youtube.com.", Packet.TYPE.A)).action, "allow");
  assert.equal((await resolver.decide("www.bad.example", Packet.TYPE.AAAA)).reason, "blocklist");
  const a = await resolver.decide("rr3---sn-abc.googlevideo.com", Packet.TYPE.A);
  const b = await resolver.decide("rr5---sn-xyz.googlevideo.com", 65);
  assert.deepEqual([a.action, a.domain, b.action], ["block", "googlevideo.com", "block"]);
  assert.deepEqual(calls, ["googlevideo.com"]);
  assert.equal(resolver.stats.classified, 1);
});

test("wait mode allows when Jev is slower than the timeout, then uses the verdict", async () => {
  const { resolver, cache } = setup({}, 150);
  assert.equal((await resolver.decide("slow.example.org", Packet.TYPE.A)).reason, "pending");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(cache.map.get("example.org")?.verdict, "distracting");
  assert.equal((await resolver.decide("slow.example.org", Packet.TYPE.A)).action, "block");
});

test("background mode answers immediately; offline mode never calls Jev", async () => {
  const bg = setup({ newDomainMode: "background" }, 20);
  assert.equal((await bg.resolver.decide("example.org", Packet.TYPE.A)).reason, "pending");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await bg.resolver.decide("example.org", Packet.TYPE.A)).action, "block");

  const off = setup({ newDomainMode: "offline" });
  assert.equal((await off.resolver.decide("example.org", Packet.TYPE.A)).action, "allow");
  assert.equal((await off.resolver.decide("www.reddit.com", Packet.TYPE.A)).action, "block"); // built-in list
  assert.deepEqual(off.calls, []);
});

test("focus session blocks until it ends", async () => {
  const { resolver, setState } = setup({ enabled: false, focusUntil: Date.now() + 60_000 });
  assert.equal((await resolver.decide("bad.example", Packet.TYPE.A)).action, "block");
  setState({ focusUntil: Date.now() - 1 });
  assert.equal((await resolver.decide("bad.example", Packet.TYPE.A)).action, "allow");
});

function query(name: string, type: number, id = 1234): Buffer {
  const p = new Packet();
  p.header.id = id;
  p.header.rd = 1;
  p.questions.push({ name, type, class: Packet.CLASS.IN } as any);
  return p.toBuffer();
}

function answer(req: Packet, ttl: number, count = 1) {
  const res = Packet.createResponseFromRequest(req);
  for (let i = 0; i < count; i++) {
    res.answers.push({ name: req.questions[0].name, type: Packet.TYPE.A, class: Packet.CLASS.IN, ttl, address: `10.0.${i >> 8}.${i & 255}` } as any);
  }
  return res;
}

test("capTtl caps every record but leaves the message otherwise intact", () => {
  const req = Packet.parse(query("example.org", Packet.TYPE.A));
  const raw = answer(req, 3600, 3).toBuffer();
  const capped = Packet.parse(capTtl(raw, 60));
  assert.deepEqual(capped.answers.map((a) => a.ttl), [60, 60, 60]);
  assert.deepEqual(capped.answers.map((a: any) => a.address), ["10.0.0.0", "10.0.0.1", "10.0.0.2"]);
  assert.equal(capTtl(raw.subarray(0, raw.length - 3), 60).length, raw.length - 3); // malformed: unchanged
});

async function fakeUpstream(answers: number) {
  // dns2 truncates oversized UDP replies itself (TC=1), so a big answer exercises the TCP retry.
  const handle = (req: Packet, send: (r: Packet) => Promise<Buffer>) => void send(answer(req, 3600, answers));
  const udp = dns2.createUDPServer(handle);
  await udp.listen(0, "127.0.0.1");
  const { port } = udp.address();
  const tcp = dns2.createTCPServer(handle);
  await new Promise<void>((resolve) => tcp.listen(port, "127.0.0.1", resolve));
  const upstream = { close: () => Promise.all([new Promise<void>((r) => udp.close(() => r())), new Promise<void>((r) => tcp.close(() => r()))]) };
  return { upstream, port };
}

test("forwarder relays raw replies and retries over TCP when truncated", async () => {
  const { upstream, port } = await fakeUpstream(100); // 100 A records > 512 bytes
  try {
    const reply = Packet.parse(await createForwarder([`127.0.0.1:${port}`])(query("example.org", Packet.TYPE.A, 7)));
    assert.equal(reply.header.id, 7);
    assert.equal(reply.header.tc, 0);
    assert.equal(reply.answers.length, 100);
  } finally {
    await upstream.close();
  }
});

test("forwarder falls through to the next upstream", async () => {
  const { upstream, port } = await fakeUpstream(1);
  try {
    const forward = createForwarder(["127.0.0.1:9", `127.0.0.1:${port}`], 200);
    assert.equal(Packet.parse(await forward(query("example.org", Packet.TYPE.A))).answers.length, 1);
  } finally {
    await upstream.close();
  }
});

test("end to end: allowed names are forwarded with capped TTLs; blocked names get 0.0.0.0", async () => {
  const { upstream, port } = await fakeUpstream(1);
  const { resolver } = setup({ newDomainMode: "offline" }, 0, createForwarder([`127.0.0.1:${port}`]));
  const server = dns2.createServer({ udp: true, handle: (req, send) => void resolver.handle(req, send) });
  const { udp } = await server.listen({ udp: { port: 0, address: "127.0.0.1" } });
  try {
    const blocked = await ask(udp!, query("www.bad.example", Packet.TYPE.A));
    assert.deepEqual([(blocked.answers[0] as any).address, blocked.answers[0].ttl], ["0.0.0.0", 10]);
    const blocked6 = await ask(udp!, query("bad.example", Packet.TYPE.AAAA));
    assert.equal((blocked6.answers[0] as any).address, "::");

    const allowed = await ask(udp!, query("example.org", Packet.TYPE.A, 99));
    assert.equal(allowed.header.id, 99);
    assert.deepEqual([(allowed.answers[0] as any).address, allowed.answers[0].ttl], ["10.0.0.0", 60]);
    assert.deepEqual([resolver.stats.queries, resolver.stats.blocked], [3, 2]);
  } finally {
    await Promise.all([server.close(), upstream.close()]);
  }
});

function ask(addr: AddressInfo, q: Buffer): Promise<Packet> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket("udp4");
    const t = setTimeout(() => (s.close(), reject(new Error("timeout"))), 2000);
    s.on("message", (m) => (clearTimeout(t), s.close(), resolve(Packet.parse(m))));
    s.send(q, addr.port, addr.address);
  });
}

test("dashboard API toggles blocking, runs focus sessions and switches modes", async () => {
  let state: BlockingState = { ...DEFAULT_STATE };
  let t = 1_000_000;
  const app = createDashboard({
    getState: () => state,
    setState: async (s) => void (state = s),
    stats: { queries: 0, blocked: 0, classified: 0, since: 0 },
    info: { model: "jev", hasApiKey: true, upstreams: ["1.1.1.1"], waitTimeoutMs: 1500 },
    now: () => t,
  });
  const call = async (method: any, url: string, payload?: object) => {
    const res = await app.inject({ method, url, payload });
    return { code: res.statusCode, body: res.json() };
  };

  assert.equal((await call("GET", "/api/status")).body.status.kind, "on");
  assert.equal((await call("PUT", "/api/enabled", { enabled: false })).body.status.kind, "off");

  const focus = (await call("POST", "/api/focus", { minutes: 30 })).body.status;
  assert.deepEqual([focus.kind, focus.remainingMs], ["focus", 30 * 60_000]);
  t += 31 * 60_000;
  assert.equal((await call("GET", "/api/status")).body.status.kind, "off");

  await call("POST", "/api/focus", { minutes: 15 });
  assert.equal((await call("DELETE", "/api/focus")).body.status.kind, "off");

  assert.equal((await call("PUT", "/api/mode", { newDomainMode: "offline" })).body.newDomainMode, "offline");
  assert.equal((await call("PUT", "/api/mode", { newDomainMode: "nope" })).code, 400);
  assert.equal((await call("POST", "/api/focus", { minutes: 0 })).code, 400);

  const page = await app.inject({ method: "GET", url: "/" });
  assert.match(page.body, /Focus DNS/);
  await app.close();
});
