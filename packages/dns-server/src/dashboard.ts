import { readFile } from "node:fs/promises";
import Fastify from "fastify";
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
  info: { model: string; hasApiKey: boolean; upstreams: string[]; waitTimeoutMs: number };
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
      stats: options.stats,
      ...options.info,
    };
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

  return app;
}
