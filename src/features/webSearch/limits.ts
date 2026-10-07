export const DEFAULT_SEARCH_COUNT = 5;
export const DEFAULT_SEARCH_MAX_RESULTS = 10;
// Brave Web Search supports at most 20 web results per request.
export const MAX_SEARCH_RESULTS = 20;

export function normalizeSearchMaxResults(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(value)))
    : DEFAULT_SEARCH_MAX_RESULTS;
}
