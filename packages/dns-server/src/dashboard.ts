import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { CATEGORIES, type Blocklists, type Category } from "./blocklists.js";
import type { Stats } from "./resolver.js";
import {
  blockingStatus,
  NEW_DOMAIN_MODES,
  setEnabled,
  startFocus,
  type BlockingState,
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

  return app;
}
