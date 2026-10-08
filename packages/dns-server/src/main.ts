#!/usr/bin/env node
import { createSiteBlocker } from "@focus/site-blocker";
import dns2 from "dns2";
import { loadConfig } from "./config.js";
import { createDashboard } from "./dashboard.js";
import { createResolver } from "./resolver.js";
import { openStore } from "./store.js";
import { createForwarder } from "./upstream.js";

const config = loadConfig();
const store = await openStore(config.dataDir);
const log = (msg: string) => console.log(`[focus-dns] ${msg}`);

const blocker = createSiteBlocker({
  // Global on/off and focus sessions are handled by the resolver, so the library is always "enabled".
  getSettings: () => ({
    enabled: true,
    openrouterApiKey: config.openrouterApiKey,
    threshold: config.threshold,
    model: config.model,
    allowlist: config.allowlist,
    blocklist: config.blocklist,
  }),
  cache: store.cache,
  headers: { "HTTP-Referer": "https://github.com/bramtechs/Focus", "X-Title": "Focus DNS" },
});

const resolver = createResolver({
  config,
  blocker,
  getState: store.getState,
  forward: createForwarder(config.upstreams),
  log,
});

const server = dns2.createServer({
  udp: true,
  tcp: true,
  handle: (request, send) => void resolver.handle(request, send),
});
server.on("error", (err, transport) => log(`${transport} error: ${err.message}`));
server.on("requestError", (err) => log(`bad request: ${err.message}`));
const listen = { port: config.dnsPort, address: config.dnsHost };
const addresses = await server.listen({ udp: listen, tcp: listen });
log(`DNS on ${config.dnsHost}:${addresses.udp?.port} (udp+tcp) → ${config.upstreams.join(", ")}`);
if (!config.openrouterApiKey) log("OPENROUTER_API_KEY not set: using the offline heuristic list only");

const dashboard = createDashboard({
  getState: store.getState,
  setState: store.setState,
  stats: resolver.stats,
  info: {
    model: config.model,
    hasApiKey: Boolean(config.openrouterApiKey),
    upstreams: config.upstreams,
    waitTimeoutMs: config.waitTimeoutMs,
  },
});
const url = await dashboard.listen({ host: config.dashboardHost, port: config.dashboardPort });
log(`dashboard on ${url}`);

const shutdown = async () => {
  await Promise.allSettled([server.close(), dashboard.close()]);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
