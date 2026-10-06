import { matchesList, registrableDomain } from "./domain.js";
import type { Classification } from "./types.js";

// Offline heuristic used when no API key is set or the API is unreachable.
// Jev remains the source of truth whenever a key is configured.
export const FALLBACK_DISTRACTING: readonly string[] = [
  "youtube.com",
  "tiktok.com",
  "instagram.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "reddit.com",
  "netflix.com",
  "hulu.com",
  "disneyplus.com",
  "twitch.tv",
  "discord.com",
  "pinterest.com",
  "tumblr.com",
  "snapchat.com",
  "roblox.com",
  "epicgames.com",
  "steamcommunity.com",
  "store.steampowered.com",
  "9gag.com",
  "buzzfeed.com",
  "dailymail.co.uk",
  "theonion.com",
];

export function fallbackClassify(domain: string): Classification {
  const distracting = matchesList(registrableDomain(domain), FALLBACK_DISTRACTING);
  return {
    verdict: distracting ? "distracting" : "productive",
    probability: 0.8,
    distractingProbability: distracting ? 0.8 : 0.2,
    confidence: 0.5,
    model: "fallback-heuristic",
    source: "fallback",
  };
}
