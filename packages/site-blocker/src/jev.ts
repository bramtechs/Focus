import type { Classification, FetchLike } from "./types.js";

export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const DEFAULT_MODEL = "typesafe/jev-1.13"; // pinned; alt: "~typesafe/jev-latest"

const QUESTION_ID = "site_category";
const QUESTION = {
  type: "choice",
  instructions:
    "Is visiting this website productive for focused work, or is it distracting?",
  criteria: {
    productive:
      "Work, study, documentation, coding, email, calendar, maps, banking, task-driven search, productivity tools, or news directly needed for work",
    distracting:
      "Social media feeds, short-video doomscrolling, entertainment, gaming, gambling, viral videos, memes, celebrity gossip, aimless browsing, adult content, or shopping for fun",
  },
};

export function buildState(domain: string, pageUrl: string, title?: string): string {
  return (
    `Decide whether visiting this website supports focused, productive work.\n` +
    `Domain: ${domain}\n` +
    `Full URL: ${pageUrl}\n` +
    `Page title: ${title || "(unknown)"}\n` +
    `User goal: stay productive while using a web browser. Block the domain only if it is distracting.`
  );
}

export interface JevOptions {
  domain: string;
  pageUrl: string;
  title?: string;
  apiKey: string;
  model: string;
  fetch?: FetchLike;
  /** Extra request headers, e.g. OpenRouter's HTTP-Referer / X-Title. */
  headers?: Record<string, string>;
}

/** Classify a domain with Jev through OpenRouter's Decisions API. */
export async function classifyWithJev(opts: JevOptions): Promise<Classification> {
  const doFetch: FetchLike = opts.fetch ?? ((i, init) => fetch(i, init));
  const res = await doFetch(DECISIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      ...opts.headers,
    },
    body: JSON.stringify({
      model: opts.model,
      state: buildState(opts.domain, opts.pageUrl, opts.title),
      questions: { [QUESTION_ID]: QUESTION },
    }),
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error("Invalid OpenRouter API key (401/403). Check Options.");
  }
  if (res.status === 429) {
    throw new Error("Rate limited (429). Retrying later.");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Decisions API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data: any = await res.json();
  const answer = data?.answers?.[QUESTION_ID];
  if (!answer || answer.type !== "choice" || typeof answer.choice !== "string") {
    throw new Error("Unexpected Decisions API response shape.");
  }

  const choice = answer.choice.toLowerCase();
  const probs = answer.probabilities || {};
  // Probabilities keys mirror our criteria keys; be case-tolerant.
  const pDistracting =
    Number(probs.distracting ?? probs.Distracting ?? probs.DISTRACTING) || 0;

  return {
    verdict: choice === "distracting" ? "distracting" : "productive",
    probability: choice === "distracting" ? pDistracting : 1 - pDistracting,
    distractingProbability: pDistracting,
    confidence: Number(answer.confidence) || 0,
    model: data?.model || opts.model,
    source: "jev",
  };
}
