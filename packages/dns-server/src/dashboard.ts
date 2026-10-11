import { readFile } from "node:fs/promises";
import { normalizeDomainList } from "@focus/site-blocker";
import Fastify from "fastify";
import { CATEGORIES, type Blocklists, type Category } from "./blocklists.js";
import type { QueryLog } from "./querylog.js";
import type { Stats } from "./resolver.js";
import type { UsageMeter } from "./usage.js";
import {
  blockingStatus,
  NEW_DOMAIN_MODES,
  setEnabled,
  startFocus,
  type BlockingState,
  type DomainLists,
  type NewDomainMode,
} from "./state.js";

export interface DashboardOptions {
  getState: () => BlockingState;
  setState: (state: BlockingState) => Promise<void>;
  stats: Stats;
  blocklists: Pick<Blocklists, "ensure" | "status">;
  /** The API key saved from the dashboard ("" = none). */
  getApiKey: () => string;
  setApiKey: (key: string) => Promise<void>;
  /** OPENROUTER_API_KEY from the environment, used when no key is saved. */
  envApiKey: string;
  getLists: () => DomainLists;
  setLists: (lists: DomainLists) => Promise<void>;
  /** FOCUS_ALLOWLIST / FOCUS_BLOCKLIST, shown read-only. */
  envLists: DomainLists;
  queryLog: Pick<QueryLog, "list">;
  usage: Pick<UsageMeter, "status">;
  info: { model: string; upstreams: string[]; waitTimeoutMs: number };
  now?: () => number;
  logger?: boolean;
}

const INDEX_HTML = new URL("../public/index.html", import.meta.url);

export function createDashboard(options: DashboardOptions) {
  const now = options.now ?? Date.now;
  const app = Fastify({ logger: options.logger ?? false });

  const status = () => {
    const state = options.getState();
    return {
      status: blockingStatus(state, now()),
      newDomainMode: state.newDomainMode,
      filters: Object.fromEntries(
        CATEGORIES.map((c) => [c, { enabled: state.filters[c], ...options.blocklists.status(c) }])
      ),
      stats: options.stats,
      apiKey: apiKeyStatus(),
      jevUsage: options.usage.status(),
      lists: { ...options.getLists(), env: options.envLists },
      ...options.info,
    };
  };
  // Never send the key itself: the dashboard has no login.
  const apiKeyStatus = () => {
    const saved = options.getApiKey();
    const key = saved || options.envApiKey;
    return { source: saved ? "dashboard" : key ? "env" : null, hint: key ? `…${key.slice(-4)}` : null };
  };
  const update = async (next: BlockingState) => {
    await options.setState(next);
    return status();
  };

  app.get("/", async (_req, reply) => reply.type("text/html").send(await readFile(INDEX_HTML)));

  app.get("/api/status", async () => status());

  app.put<{ Body: { enabled: boolean } }>(
    "/api/enabled",
    {
      schema: {
        body: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } },
      },
    },
    async (req) => update(setEnabled(options.getState(), req.body.enabled))
  );

  app.post<{ Body: { minutes: number } }>(
    "/api/focus",
    {
      schema: {
        body: {
          type: "object",
          required: ["minutes"],
          properties: { minutes: { type: "integer", minimum: 1, maximum: 24 * 60 } },
        },
      },
    },
    async (req) => update(startFocus(options.getState(), req.body.minutes, now()))
  );

  app.delete("/api/focus", async () => update(setEnabled(options.getState(), false)));

  app.put<{ Body: { newDomainMode: NewDomainMode } }>(
    "/api/mode",
    {
      schema: {
        body: {
          type: "object",
          required: ["newDomainMode"],
          properties: { newDomainMode: { type: "string", enum: [...NEW_DOMAIN_MODES] } },
        },
      },
    },
    async (req) => update({ ...options.getState(), newDomainMode: req.body.newDomainMode })
  );

  app.put<{ Body: Partial<Record<Category, boolean>> }>(
    "/api/filters",
    {
      schema: {
        body: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties: Object.fromEntries(CATEGORIES.map((c) => [c, { type: "boolean" }])),
        },
      },
    },
    async (req) => {
      const state = options.getState();
      const filters = { ...state.filters, ...req.body };
      // Download newly enabled lists in the background; the dashboard shows progress.
      for (const c of CATEGORIES) if (filters[c]) void options.blocklists.ensure(c);
      return update({ ...state, filters });
    }
  );

  app.put<{ Body: { key: string } }>(
    "/api/apikey",
    {
      schema: {
        body: {
          type: "object",
          required: ["key"],
          properties: { key: { type: "string", maxLength: 500, pattern: "^\\s*\\S*\\s*$" } },
        },
      },
    },
    async (req) => {
      // An empty key removes the saved one (falling back to OPENROUTER_API_KEY, if set).
      await options.setApiKey(req.body.key.trim());
      return status();
    }
  );

  app.get<{ Querystring: { limit?: number; action?: "allow" | "block"; search?: string; after?: number } }>(
    "/api/queries",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 2000, default: 200 },
            action: { type: "string", enum: ["allow", "block"] },
            search: { type: "string", maxLength: 253 },
            after: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    async (req) => ({ queries: options.queryLog.list(req.query) })
  );

  const LIST_NAMES = ["allow", "block"] as const;
  type ListName = (typeof LIST_NAMES)[number];
  const listParams = {
    type: "object",
    required: ["list", "domain"],
    properties: {
      list: { type: "string", enum: [...LIST_NAMES] },
      domain: { type: "string", minLength: 1, maxLength: 253, pattern: "^[A-Za-z0-9._-]+$" },
    },
  };
  const other = (list: ListName): ListName => (list === "allow" ? "block" : "allow");

  // Adding a domain to one list takes it off the other, so the latest choice wins.
  app.put<{ Params: { list: ListName; domain: string } }>(
    "/api/lists/:list/:domain",
    { schema: { params: listParams } },
    async (req, reply) => {
      const [domain] = normalizeDomainList([req.params.domain.replace(/\.$/, "")]);
      if (!domain?.includes(".")) return reply.code(400).send({ message: "Not a domain name" });
      const { list } = req.params;
      const next = { ...options.getLists() };
      next[list] = [...next[list].filter((d) => d !== domain), domain];
      next[other(list)] = next[other(list)].filter((d) => d !== domain);
      await options.setLists(next);
      return status();
    }
  );

  app.delete<{ Params: { list: ListName; domain: string } }>(
    "/api/lists/:list/:domain",
    { schema: { params: listParams } },
    async (req) => {
      const { list, domain } = req.params;
      const lists = options.getLists();
      await options.setLists({ ...lists, [list]: lists[list].filter((d) => d !== domain.toLowerCase()) });
      return status();
    }
  );

  return app;
}
