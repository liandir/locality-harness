import { safeFetch } from "../../network/safeFetch.js";
import { searchDestination } from "./providers.js";
import { additionalPolicy } from "./networkPolicy.js";
import { DEFAULT_SEARCH_COUNT, DEFAULT_SEARCH_MAX_RESULTS, MAX_SEARCH_RESULTS, normalizeSearchMaxResults } from "./limits.js";

/** Messages from this class are safe to show in tool cards and settings. */
export class SearchError extends Error {}
export interface SearchOptions { apiKey?: string; signal?: AbortSignal }
export interface SearchRequest { query: string; count: number }
export interface SearchResult { title: string; url: string; snippet: string; published?: string }
export function searchRequest(args: Record<string, unknown>, maxResults = DEFAULT_SEARCH_MAX_RESULTS): SearchRequest {
  if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 500) throw new Error("Search query must contain 1–500 characters.");
  const count = args.count ?? DEFAULT_SEARCH_COUNT;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_SEARCH_RESULTS) throw new Error(`Search count must be 1–${MAX_SEARCH_RESULTS}.`);
  return { query: args.query.trim(), count: Math.min(count, normalizeSearchMaxResults(maxResults)) };
}
export async function searchUrl(endpoint: string): Promise<URL> {
  if (!endpoint.trim()) throw new SearchError("Configure the Web search endpoint in Settings first.");
  let base: URL;
  try { base = new URL(endpoint); }
  catch { throw new SearchError("Enter a valid Brave Web Search endpoint or SearXNG base URL in Settings."); }
  let url: URL;
  try {
    url = searchDestination(base).url;
    await additionalPolicy(base, url);
  }
  catch (error) { throw new SearchError((error as Error).message); }
  return url;
}
function plain(value: unknown, limit: number): string {
  // eslint-disable-next-line no-control-regex
  return typeof value === "string" ? value.replace(/<[^>]*>/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, limit) : "";
}
export async function searchWeb(endpoint: string, request: SearchRequest, { signal, apiKey = "" }: SearchOptions = {}): Promise<SearchResult[]> {
  const url = await searchUrl(endpoint);
  const brave = searchDestination(new URL(endpoint)).provider === "brave";
  const key = apiKey.trim();
  if (brave && !key) throw new SearchError("Brave Search requires an API-key. Enter your Brave Search API key in Settings.");
  if (brave && request.query.trim().split(/\s+/).length > 75) throw new SearchError("Brave Search queries must contain at most 75 words. Shorten the query and try again.");
  // Header values must be printable ASCII. Never echo malformed key material.
  if (key && !/^[\x21-\x7e]+$/.test(key)) throw new SearchError("The search API key must contain only printable characters without spaces.");
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "Locality (+https://github.com/liandir/locality)" };
  if (key) {
    if (brave) headers["X-Subscription-Token"] = key;
    else headers.Authorization = `Bearer ${key}`;
  }
  url.searchParams.set("q", request.query);
  if (brave) {
    url.searchParams.set("count", String(request.count));
    url.searchParams.set("result_filter", "web");
    url.searchParams.set("text_decorations", "false");
  } else url.searchParams.set("format", "json");
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 15000);
  try {
    const response = await safeFetch(endpoint, url.href, {
      headers, signal: controller.signal,
      additional: true, maxResponseBytes: 1024 * 1024
    });
    if (brave && (response.status === 401 || response.status === 403)) throw new SearchError(`Brave Search denied access (HTTP ${response.status}). Check the API-key and that its Search subscription is active.`);
    if (brave && response.status === 422) throw new SearchError("Brave Search rejected the request (HTTP 422). Check your API-key, Search subscription, and query.");
    if (brave && response.status === 429) throw new SearchError("Brave Search rate or quota limit reached (HTTP 429). Try again later or check your usage in the Brave API dashboard.");
    if (response.status === 401) throw new SearchError(key
      ? "Search authentication failed (HTTP 401). Check the API-key in Settings."
      : "Search service requires authentication (HTTP 401). Enter its API-key in Settings.");
    if (response.status === 403) throw new SearchError("Search service denied access (HTTP 403). Check the API-key and whether JSON search is enabled on this endpoint.");
    if (response.status === 429) throw new SearchError("Search service is rate limiting requests (HTTP 429). Try again later or change the Web search endpoint in Settings.");
    if (!response.ok) throw new SearchError(`Search service returned HTTP ${response.status}. Check the Web search endpoint in Settings or try again later.`);
    const body: unknown = await response.json();
    const payload = object(body);
    // Brave may omit its nullable web block for an empty search response.
    let rows = payload?.results;
    if (brave) {
      rows = payload?.type !== "search" ? undefined
        : payload.web == null ? [] : object(payload.web)?.results;
    }
    if (!Array.isArray(rows)) throw new SearchError(brave
      ? "Search service did not return Brave Web Search results. Check the Web search endpoint."
      : "Search service did not return SearXNG results. Check the Web search endpoint and enable its JSON search format.");
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row !== "object" || typeof row.url !== "string") continue;
      let target: URL;
      try { target = new URL(row.url); } catch { continue; }
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || seen.has(target.href)) continue;
      seen.add(target.href);
      results.push({ title: plain(row.title, 240), url: target.href, snippet: plain(brave ? row.description : row.content, 1600), published: plain(brave ? row.page_age : row.publishedDate, 100) || undefined });
      if (results.length === request.count) break;
    }
    return results;
  } catch (error) {
    if (controller.signal.aborted) throw new SearchError(signal?.aborted ? "Search cancelled." : "Search timed out. Check the Web search endpoint or try again later.");
    // Do not echo request URLs or provider bodies into the transcript.
    if (error instanceof SyntaxError) throw new SearchError(brave
      ? "Brave Search returned invalid JSON. Check the Web search endpoint or try again later."
      : "Search service returned invalid JSON; enable its JSON search format.");
    if (error instanceof SearchError) throw error;
    throw new SearchError("Could not connect to the search service or read its response. Check the Web search endpoint, network connection, and server availability.");
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
