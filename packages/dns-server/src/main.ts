#!/usr/bin/env node
import { join } from "node:path";
import { createSiteBlocker } from "@focus/site-blocker";
import dns2 from "dns2";
import { createBlocklists } from "./blocklists.js";
import { loadConfig } from "./config.js";
import { createDashboard } from "./dashboard.js";
import { createQueryLog } from "./querylog.js";
import { createResolver } from "./resolver.js";
import { enabledFilters } from "./state.js";
import { openStore } from "./store.js";
import { createForwarder } from "./upstream.js";

const config = loadConfig();
const store = await openStore(config.dataDir);
const log = (msg: string) => console.log(`[focus-dns] ${msg}`);

const apiKey = () => store.getApiKey() || config.openrouterApiKey;

const blocker = createSiteBlocker({
  // Global on/off and focus sessions are handled by the resolver, so the library is always "enabled".
  getSettings: () => ({
    enabled: true,
    openrouterApiKey: apiKey(),
    threshold: config.threshold,
    model: config.model,
    allowlist: config.allowlist,
    blocklist: config.blocklist,
  }),
  cache: store.cache,
  headers: { "HTTP-Referer": "https://github.com/bramtechs/Focus", "X-Title": "Focus DNS" },
});

const blocklists = createBlocklists({
  urls: config.filterLists,
  dir: join(config.dataDir, "blocklists"),
  refreshMs: config.filterRefreshMs,
  log,
});
const refreshFilters = () => enabledFilters(store.getState()).forEach((c) => void blocklists.ensure(c));
refreshFilters();
setInterval(refreshFilters, 3_600_000).unref();

const queryLog = createQueryLog();

const resolver = createResolver({
  config,
  blocker,
  blocklists,
  getState: store.getState,
  getLists: store.getLists,
  queryLog,
  forward: createForwarder(config.upstreams),
  log,
});

const server = dns2.createServer({
  udp: true,
  tcp: true,
  handle: (request, send, client) => void resolver.handle(request, send, client),
});
server.on("error", (err, transport) => log(`${transport} error: ${err.message}`));
server.on("requestError", (err) => log(`bad request: ${err.message}`));
const listen = { port: config.dnsPort, address: config.dnsHost };
const addresses = await server.listen({ udp: listen, tcp: listen });
log(`DNS on ${config.dnsHost}:${addresses.udp?.port} (udp+tcp) → ${config.upstreams.join(", ")}`);
if (!apiKey()) log("No OpenRouter API key: using the offline heuristic list until one is set in the dashboard");

const dashboard = createDashboard({
  getState: store.getState,
  setState: store.setState,
  stats: resolver.stats,
  blocklists,
  getApiKey: store.getApiKey,
  setApiKey: store.setApiKey,
  envApiKey: config.openrouterApiKey,
  getLists: store.getLists,
  setLists: store.setLists,
  envLists: { allow: config.allowlist, block: config.blocklist },
  queryLog,
  info: {
    model: config.model,
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
