export type Verdict = "productive" | "distracting";
export type DecisionSource = "jev" | "fallback" | "blocklist" | "allow-once";

/** A classification of one domain. */
export interface Classification {
  verdict: Verdict;
  /** Probability of `verdict`. */
  probability: number;
  distractingProbability: number;
  confidence: number;
  model: string;
  source: DecisionSource;
  /** Set when Jev failed and the offline fallback was used instead. */
  error?: string;
}

export interface CachedClassification extends Classification {
  timestamp: number;
}

export interface Settings {
  enabled: boolean;
  openrouterApiKey: string;
  /** Block when P(distracting) >= threshold. */
  threshold: number;
  model: string;
  allowlist: string[];
  blocklist: string[];
}

export interface CacheStore {
  get(domain: string): Promise<CachedClassification | undefined>;
  set(domain: string, value: CachedClassification): Promise<void>;
  delete(domain: string): Promise<void>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
