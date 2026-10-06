export function normalizeDomainList(list: unknown): string[] {
  let items: unknown[];
  if (Array.isArray(list)) items = list;
  else if (typeof list === "string") items = list.split(/[\n,]+/);
  else return [];
  return [
    ...new Set(
      items
        .map((d) => String(d).trim().toLowerCase().replace(/^www\./, ""))
        .filter(Boolean)
    ),
  ];
}

export function clampNumber(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function getHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function registrableDomain(hostname: string): string {
  return hostname.replace(/^www\./, "");
}

export function matchesList(domain: string, list: readonly string[]): boolean {
  return list.some((entry) => domain === entry || domain.endsWith("." + entry));
}

export function isNavigable(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}
