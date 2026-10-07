# @focus/dns-server — network-wide Focus

A DNS server that brings the Focus extension's site blocking to every device on
your network. Point your router's (or a device's) DNS at it: distracting domains
resolve to `0.0.0.0` / `::`, everything else is forwarded to a normal upstream
resolver. Classification is the same `@focus/site-blocker` library the extension
uses (Jev via OpenRouter, offline fallback list, allow/block lists, verdict cache).

Built on [`dns2`](https://github.com/lsongdev/node-dns) (DNS protocol),
[Fastify](https://fastify.dev) (dashboard API), [lowdb](https://github.com/typicode/lowdb)
(persistence) and [tldts](https://github.com/remusao/tldts) (public suffix list).

## Run

```sh
npm install
npm run build:dns
sudo OPENROUTER_API_KEY=sk-or-... npm run start:dns   # port 53 needs root or CAP_NET_BIND_SERVICE
```

Open the dashboard at `http://<server>:8080`, then set the server's IP as the DNS
server in your router's DHCP settings (network-wide) or on individual devices.

On Ubuntu/Debian, `systemd-resolved` already listens on `127.0.0.53:53`; either bind
Focus to the LAN address (`DNS_HOST=192.168.1.10`) or disable the stub listener.

## Dashboard

- **Turn on / Turn off** — global override. Either one ends a running focus session.
- **Focus session** — block for 15 min, 30 min, 1 h or 2 h, then switch blocking off.
- **New domains** — what to do the first time a domain without a cached verdict is looked up:
  - **Wait for Jev** — hold the DNS reply up to `WAIT_TIMEOUT_MS` for a verdict; if Jev
    is slower, allow this once and apply the verdict next time.
  - **Allow now, classify in background** — never delays lookups; a distracting site
    loads once, then is blocked.
  - **Lists only** — never calls Jev: allow/block lists, the built-in list and earlier verdicts.

State and verdicts persist in `DATA_DIR/focus-dns.json`.

## Configuration (environment)

| Variable | Default | |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Without it, only the offline heuristic list is used |
| `FOCUS_MODEL` | `typesafe/jev-1.13` | |
| `FOCUS_THRESHOLD` | `0.6` | Block when P(distracting) ≥ threshold (0.3–0.9) |
| `FOCUS_ALLOWLIST` / `FOCUS_BLOCKLIST` | — | Comma-separated domains; subdomains match |
| `UPSTREAM_DNS` | `1.1.1.1,8.8.8.8` | Tried in order; `ip`, `ip:port` or `[ipv6]:port` |
| `DNS_HOST` / `DNS_PORT` | `0.0.0.0` / `53` | UDP and TCP |
| `DASHBOARD_HOST` / `DASHBOARD_PORT` | `0.0.0.0` / `8080` | The dashboard has no login; keep it on your LAN |
| `DATA_DIR` | `./data` | |
| `WAIT_TIMEOUT_MS` | `1500` | "Wait for Jev" limit |
| `MAX_TTL` | `60` | Cap on forwarded answers' TTL so turning blocking on bites quickly (`0` = off) |
| `BLOCK_TTL` | `10` | TTL of blocked answers so turning blocking off bites quickly |

## How it differs from the extension

- Only `A`, `AAAA`, `HTTPS` and `SVCB` lookups of public domains are checked. Other
  record types, IP addresses, reverse lookups and local names (`.lan`, `.local`, …) pass through.
- Allow/block lists match the exact hostname, but Jev classifies the **registrable
  domain** (`rr3---sn-x.googlevideo.com` → `googlevideo.com`), so CDN hostnames share
  one verdict and one API call. There is no page title, so Jev sees the domain only.
- Blocked sites fail to connect rather than showing a "blocked" page (HTTPS makes a
  DNS-level block page impossible without certificate errors).
- Devices and browsers cache DNS, and already-open connections stay open, so a
  change can take up to `MAX_TTL` seconds (plus the browser's own cache) to apply.
  Browsers using DNS-over-HTTPS (e.g. Firefox's "secure DNS") bypass this server.
