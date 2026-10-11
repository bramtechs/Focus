import type { CheckResult, MissPolicy, SiteBlocker } from "@focus/site-blocker";
import { matchesList, registrableDomain } from "@focus/site-blocker";
import { Packet } from "dns2";
import { parse as parseDomain } from "tldts";
import type { Blocklists, Category } from "./blocklists.js";
import type { Config } from "./config.js";
import { typeName, type QueryLog } from "./querylog.js";
import { blockingStatus, enabledFilters, type BlockingState, type DomainLists, type NewDomainMode } from "./state.js";
import { capTtl, type Forwarder } from "./upstream.js";

const TYPE_SVCB = 64;
const TYPE_HTTPS = 65;
/** Query types a browser uses to reach a site; everything else is forwarded unchecked. */
const FILTERED_TYPES = new Set<number>([Packet.TYPE.A, Packet.TYPE.AAAA, TYPE_SVCB, TYPE_HTTPS]);

const MISS_POLICY: Record<NewDomainMode, MissPolicy> = {
  wait: "classify",
  background: "background",
  offline: "fallback",
};

export interface Decision {
  action: "allow" | "block";
  /** The domain that was classified (registrable domain), when one was. */
  domain?: string;
  reason: string;
  /** P(distracting), when the domain was classified. */
  score?: number;
}

export interface Stats {
  queries: number;
  blocked: number;
  classified: number;
  /** Blocked by each category filter (also counted in `blocked`). */
  filtered: Record<Category, number>;
  since: number;
}

export interface ResolverOptions {
  config: Pick<Config, "allowlist" | "blocklist" | "waitTimeoutMs" | "maxTtl" | "blockTtl">;
  blocker: SiteBlocker;
  blocklists?: Pick<Blocklists, "match">;
  getState: () => BlockingState;
  /** Allow/block lists edited in the dashboard, on top of the configured ones. */
  getLists?: () => DomainLists;
  queryLog?: Pick<QueryLog, "add">;
  forward: Forwarder;
  now?: () => number;
  log?: (msg: string) => void;
}

type Send = (response: Packet | Buffer) => Promise<Buffer>;

export function createResolver(options: ResolverOptions) {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const { config, blocker } = options;
  const stats: Stats = { queries: 0, blocked: 0, classified: 0, filtered: { ads: 0, adult: 0 }, since: now() };

  async function decide(name: string, type: number): Promise<Decision> {
    if (!FILTERED_TYPES.has(type)) return { action: "allow", reason: "type" };

    const state = options.getState();
    const fqdn = name.toLowerCase().replace(/\.$/, "");
    const host = registrableDomain(fqdn);
    const lists = options.getLists?.() ?? { allow: [], block: [] };
    // User lists win first and match the exact host (so "music.youtube.com" can be listed on its own)...
    if (matchesList(host, config.allowlist) || matchesList(host, lists.allow)) {
      return { action: "allow", domain: host, reason: "allowlist" };
    }

    // Ad and adult-content filters apply even while Focus blocking is off.
    const category = options.blocklists?.match(fqdn, enabledFilters(state));
    if (category) {
      stats.filtered[category]++;
      return { action: "block", domain: fqdn, reason: category };
    }

    if (!blockingStatus(state, now()).active) return { action: "allow", reason: "disabled" };
    if (matchesList(host, config.blocklist) || matchesList(host, lists.block)) {
      return { action: "block", domain: host, reason: "blocklist" };
    }

    // Only classify public internet names: skip IPs, reverse lookups, .local/.lan and other private names.
    const parsed = parseDomain(host, { allowPrivateDomains: true });
    if (parsed.isIp || !parsed.domain || !(parsed.isIcann || parsed.isPrivate) || host.endsWith(".arpa")) {
      return { action: "allow", reason: "local" };
    }

    // ...but Jev classifies the registrable domain, so CDN/API hostnames like
    // rr3---sn-x.googlevideo.com share one verdict (and one API call).
    const domain = parsed.domain;
    const mode = state.newDomainMode;
    const check = blocker.check({ url: `https://${domain}/` }, { onMiss: MISS_POLICY[mode] });
    check.catch((err) => log(`classification failed for ${domain}: ${err}`));

    const result: CheckResult | "timeout" = await (mode === "wait"
      ? Promise.race([check, delay(config.waitTimeoutMs).then(() => "timeout" as const)])
      : check);
    if (result === "timeout") return { action: "allow", domain, reason: "pending" };

    if (result.fresh && result.classification?.source === "jev") stats.classified++;
    const score = result.classification?.distractingProbability;
    if (result.action === "block") {
      return { action: "block", domain, reason: result.classification.source, score };
    }
    // Name who classified it ("jev", "fallback") rather than the generic "classified".
    const reason = result.reason === "classified" && result.classification ? result.classification.source : result.reason;
    return { action: "allow", domain, reason, score };
  }

  function blockedResponse(request: Packet): Packet {
    // NOERROR with an unroutable address (like Pi-hole / AdGuard Home's default),
    // plus an Extended DNS Error "Blocked" for EDNS-aware clients.
    const response = Packet.createErrorResponseFromRequest(request, Packet.RCODE.NOERROR, {
      infoCode: Packet.EDE.BLOCKED,
      extraText: "Blocked by Focus",
    });
    response.header.ra = 1;
    const [q] = request.questions;
    const base = { name: q.name, class: Packet.CLASS.IN, ttl: config.blockTtl };
    if (q.type === Packet.TYPE.A) response.answers.push({ ...base, type: Packet.TYPE.A, address: "0.0.0.0" } as any);
    if (q.type === Packet.TYPE.AAAA) response.answers.push({ ...base, type: Packet.TYPE.AAAA, address: "::" } as any);
    return response;
  }

  async function handle(request: Packet, send: Send, client?: unknown): Promise<void> {
    stats.queries++;
    const started = now();
    const [q] = request.questions;
    try {
      const decision: Decision = q ? await decide(q.name, q.type) : { action: "allow", reason: "empty" };
      if (q) {
        options.queryLog?.add({
          time: started,
          client: clientAddress(client),
          name: q.name.toLowerCase().replace(/\.$/, ""),
          type: typeName(q.type),
          ...decision,
          ms: now() - started,
        });
      }
      if (decision.action === "block") {
        stats.blocked++;
        // Ad blocks are too frequent to log one by one; the dashboard counts them.
        if (!(decision.reason in stats.filtered)) log(`blocked ${q.name} (${decision.domain}, ${decision.reason})`);
        await send(blockedResponse(request));
        return;
      }
      const reply = await options.forward(request.toBuffer());
      await send(capTtl(reply, config.maxTtl));
    } catch (err) {
      log(`failed to answer ${q?.name ?? "(no question)"}: ${(err as Error)?.message ?? err}`);
      await send(Packet.createErrorResponseFromRequest(request, Packet.RCODE.SERVFAIL)).catch(() => {});
    }
  }

  return { decide, handle, stats };
}

/** dns2 passes RemoteInfo for UDP and the socket for TCP. */
function clientAddress(client: unknown): string {
  const c = client as { address?: unknown; remoteAddress?: unknown } | undefined;
  const address = typeof c?.address === "string" ? c.address : typeof c?.remoteAddress === "string" ? c.remoteAddress : "";
  return address.replace(/^::ffff:/, "");
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
