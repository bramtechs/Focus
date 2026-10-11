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

## Docker

The `Dockerfile` and `docker-compose.yml` live in the repo root (the image builds the
whole workspace). The compose file publishes DNS on `53/udp` + `53/tcp` and the dashboard
on `8080`, and keeps `DATA_DIR` (`/data`) in the `focus-data` volume.

```sh
OPENROUTER_API_KEY=sk-or-... docker compose up -d --build
```

`OPENROUTER_API_KEY`, `FOCUS_ALLOWLIST`, `FOCUS_BLOCKLIST` and `UPSTREAM_DNS` are read
from your shell or a `.env` file next to `docker-compose.yml`; add any other variable
from the table below to `environment:`. Without Compose:

```sh
docker build -t focus-dns .
docker run -d --name focus-dns --restart unless-stopped \
  -p 53:53/udp -p 53:53/tcp -p 8080:8080 -v focus-data:/data \
  -e OPENROUTER_API_KEY=sk-or-... focus-dns
```

The container runs as the unprivileged `node` user; Docker still lets it bind port 53
inside the container.

### Windows: start at sign-in and open the firewall

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and enable
   *Settings → General → Start Docker Desktop when you sign in*.
2. Set the OpenRouter API key in the dashboard once it's running (or put
   `OPENROUTER_API_KEY=sk-or-...` in a `.env` file next to `docker-compose.yml`; git ignores it).
3. In an elevated PowerShell, from the repo root:
   `powershell -ExecutionPolicy Bypass -File scripts\windows\install-focus-dns.ps1`
   This opens ports 53 (UDP/TCP) and 8080 to private LAN addresses only (all RFC 1918
   ranges, so devices on another subnet behind a second router work too), and registers a
   "Focus DNS" task that runs `scripts\windows\start-focus-dns.ps1` at sign-in.
4. Start it now with `Start-ScheduledTask -TaskName 'Focus DNS'`.
5. Give this PC a fixed LAN address (a DHCP reservation in the router), then set the
   router's DHCP DNS server to that address.

The task runs at sign-in, not before it, so the DNS server is down until you log on.

**Port 53 already in use?** On Ubuntu/Debian, `systemd-resolved` listens on
`127.0.0.53:53`, so publishing `53:53` fails with "address already in use". Either:

- publish on the host's LAN address only, e.g. `"192.168.1.10:53:53/udp"` and
  `"192.168.1.10:53:53/tcp"` in `docker-compose.yml`, or
- turn off the stub listener: set `DNSStubListener=no` in `/etc/systemd/resolved.conf`,
  point `/etc/resolv.conf` at the real resolver
  (`sudo ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf`) and
  `sudo systemctl restart systemd-resolved`.

## Dashboard

- **Turn on / Turn off** — global override. Either one ends a running focus session.
- **Focus session** — block for 15 min, 30 min, 1 h or 2 h, then switch blocking off.
- **New domains** — what to do the first time a domain without a cached verdict is looked up:
  - **Wait for Jev** — hold the DNS reply up to `WAIT_TIMEOUT_MS` for a verdict; if Jev
    is slower, allow this once and apply the verdict next time.
  - **Allow now, classify in background** — never delays lookups; a distracting site
    loads once, then is blocked.
  - **Lists only** — never calls Jev: allow/block lists, the built-in list and earlier verdicts.
- **OpenRouter API key** — save or remove the key Jev uses. A saved key overrides
  `OPENROUTER_API_KEY`; the dashboard only ever shows its last four characters.
- **Filters** — optional, off by default:
  - **Block ads & trackers** — [HaGeZi Multi Normal](https://github.com/hagezi/dns-blocklists)
  - **Block adult content** — [HaGeZi NSFW](https://github.com/hagezi/dns-blocklists)

  Filters block the listed domains and all their subdomains, and stay on even while Focus
  blocking is off. `FOCUS_ALLOWLIST` still overrides them. A list is downloaded when its
  filter is first turned on, cached in `DATA_DIR/blocklists/`, and refreshed every
  `BLOCKLIST_REFRESH_HOURS`.

- **Your lists** — always allow or always block a domain (and its subdomains), on top of
  `FOCUS_ALLOWLIST` / `FOCUS_BLOCKLIST`. They're checked before the filters and Jev, so they
  also fix false positives.
- **Query log** — the last 2,000 lookups (in memory): device, name, record type, whether it was
  allowed or blocked and why (Jev with its P(distracting), a filter, your lists, …). Each
  overridable row has an **Allow** / **Block** button that adds the domain to your lists.
  Under Docker Desktop the device column shows Docker's gateway address, because its port
  forwarding hides the real client IP.

State, verdicts, your lists and the saved API key persist in `DATA_DIR/focus-dns.json`.

## Configuration (environment)

| Variable | Default | |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Used unless a key is saved in the dashboard. Without any key, only the offline heuristic list is used |
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
| `AD_BLOCKLIST_URLS` / `ADULT_BLOCKLIST_URLS` | HaGeZi lists | Comma-separated URLs for the filters; plain-domain, hosts or `\|\|domain^` format |
| `BLOCKLIST_REFRESH_HOURS` | `24` | How often enabled filter lists are re-downloaded |

## How it differs from the extension

- Only `A`, `AAAA`, `HTTPS` and `SVCB` lookups of public domains are checked. Other
  record types, IP addresses, reverse lookups and local names (`.lan`, `.local`, …) pass through.
- Cloud and CDN endpoints (`*.amazonaws.com`, `*.googleapis.com`, Akamai, Azure, Fastly, …;
  see `src/infra.ts`) skip Jev and are allowed. They're app/API hosts, not sites, so Jev
  could only guess from a machine-made name, and many are on the Public Suffix List, which
  would make every hostname a separate paid classification. Your lists and the filters still
  apply to them.
- Allow/block lists match the exact hostname, but Jev classifies the **registrable
  domain** (`rr3---sn-x.googlevideo.com` → `googlevideo.com`), so CDN hostnames share
  one verdict and one API call. There is no page title, so Jev sees the domain only.
- Blocked sites fail to connect rather than showing a "blocked" page (HTTPS makes a
  DNS-level block page impossible without certificate errors).
- Devices and browsers cache DNS, and already-open connections stay open, so a
  change can take up to `MAX_TTL` seconds (plus the browser's own cache) to apply.
  Browsers using DNS-over-HTTPS (e.g. Firefox's "secure DNS") bypass this server.
