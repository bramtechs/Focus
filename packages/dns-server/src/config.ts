import { clampNumber, DEFAULT_MODEL, normalizeDomainList } from "@focus/site-blocker";

export interface Config {
  dnsHost: string;
  dnsPort: number;
  dashboardHost: string;
  dashboardPort: number;
  /** Upstream resolvers ("ip" or "ip:port", IPv6 as "[ip]:port"), tried in order. */
  upstreams: string[];
  /** Directory for the persisted state and verdict cache. */
  dataDir: string;
  /** "wait" mode: how long a DNS reply may be held for a fresh Jev verdict. */
  waitTimeoutMs: number;
  /** Cap on TTLs of forwarded answers so enabling blocking takes effect quickly (0 = no cap). */
  maxTtl: number;
  /** TTL of blocked answers, so they clear quickly once blocking is turned off. */
  blockTtl: number;
  openrouterApiKey: string;
  model: string;
  threshold: number;
  allowlist: string[];
  blocklist: string[];
}

const int = (v: string | undefined, fallback: number, min: number, max: number) =>
  v === undefined || v === "" ? fallback : clampNumber(Number(v), min, max, fallback);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    dnsHost: env.DNS_HOST || "0.0.0.0",
    dnsPort: int(env.DNS_PORT, 53, 0, 65535),
    dashboardHost: env.DASHBOARD_HOST || "0.0.0.0",
    dashboardPort: int(env.DASHBOARD_PORT, 8080, 0, 65535),
    upstreams: (env.UPSTREAM_DNS || "1.1.1.1,8.8.8.8")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    dataDir: env.DATA_DIR || "./data",
    waitTimeoutMs: int(env.WAIT_TIMEOUT_MS, 1500, 0, 10_000),
    maxTtl: int(env.MAX_TTL, 60, 0, 86_400),
    blockTtl: int(env.BLOCK_TTL, 10, 0, 86_400),
    openrouterApiKey: env.OPENROUTER_API_KEY || "",
    model: env.FOCUS_MODEL || DEFAULT_MODEL,
    threshold: clampNumber(Number(env.FOCUS_THRESHOLD || 0.6), 0.3, 0.9, 0.6),
    allowlist: normalizeDomainList(env.FOCUS_ALLOWLIST || ""),
    blocklist: normalizeDomainList(env.FOCUS_BLOCKLIST || ""),
  };
}
