import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/network/safeFetch.js", () => ({ safeFetch: mocks.fetch }));
import { searchRequest, searchUrl, searchWeb } from "../src/features/webSearch/search.js";
import { BRAVE_SEARCH_ENDPOINT, searchDestination } from "../src/features/webSearch/providers.js";
import { additionalPolicy } from "../src/features/webSearch/networkPolicy.js";

const query = searchRequest({ query: "TypeScript release notes", count: 2 });
const result = (body: unknown) => new Response(JSON.stringify(body));
beforeEach(() => { mocks.fetch.mockReset(); });

describe("Brave Web Search adapter", () => {
  it.each([BRAVE_SEARCH_ENDPOINT, BRAVE_SEARCH_ENDPOINT + "/", "https://api.search.brave.com", "https://api.search.brave.com/"])("recognizes official endpoint %s without appending /search", async endpoint => {
    expect((await searchUrl(endpoint)).href).toBe(BRAVE_SEARCH_ENDPOINT);
  });

  it("uses Brave authentication and parameters and normalizes web.results", async () => {
    mocks.fetch.mockResolvedValue(result({ type: "search", web: { type: "search", results: [
      { title: "<b>Docs</b>", url: "https://example.org/docs", description: "<em>Snippet</em>", page_age: "2026-09-01T12:00:00" },
      { title: "duplicate", url: "https://example.org/docs", description: "duplicate" },
      { title: "unsafe", url: "javascript:alert(1)" },
      { title: "credentials", url: "https://user:password@example.org" },
      { title: "Other", url: "https://example.org/other", description: "x".repeat(1700) },
      { title: "Over limit", url: "https://example.org/extra" }
    ] } }));
    const results = await searchWeb(BRAVE_SEARCH_ENDPOINT, query, { apiKey: " private-brave-key " });
    expect(results).toEqual([
      { title: "Docs", url: "https://example.org/docs", snippet: "Snippet", published: "2026-09-01T12:00:00" },
      { title: "Other", url: "https://example.org/other", snippet: "x".repeat(1600), published: undefined }
    ]);
    const [endpoint, request, options] = mocks.fetch.mock.calls[0];
    const url = new URL(request);
    expect(endpoint).toBe(BRAVE_SEARCH_ENDPOINT);
    expect(url.pathname).toBe("/res/v1/web/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: query.query, count: "2", result_filter: "web", text_decorations: "false" });
    expect(options).toMatchObject({ additional: true, maxResponseBytes: 1048576, headers: { Accept: "application/json", "X-Subscription-Token": "private-brave-key" } });
    expect(options.headers).not.toHaveProperty("Authorization");
    expect(options.headers).not.toHaveProperty("Cookie");
    expect(options.body).toBeUndefined();
    expect(endpoint + request + JSON.stringify(results)).not.toContain("private-brave-key");
  });

  it.each([3, 20])("sends the configured %s-result limit to Brave and bounds its response", async maximum => {
    mocks.fetch.mockResolvedValue(result({ type: "search", web: { results: Array.from({ length: 25 }, (_, i) => ({
      title: `Result ${i}`, url: `https://example.org/page${i}`
    })) } }));
    const results = await searchWeb(BRAVE_SEARCH_ENDPOINT, searchRequest({ query: "docs", count: 20 }, maximum), { apiKey: "key" });
    expect(new URL(mocks.fetch.mock.calls[0][1]).searchParams.get("count")).toBe(String(maximum));
    expect(results).toHaveLength(maximum);
  });

  it.each([{ type: "search", web: { results: [] } }, { type: "search", web: null }, { type: "search", query: { original: query.query } }])("accepts empty Brave search responses", async body => {
    mocks.fetch.mockResolvedValue(result(body));
    expect(await searchWeb(BRAVE_SEARCH_ENDPOINT, query, { apiKey: "key" })).toEqual([]);
  });

  it.each([{}, { results: [] }, { web: { results: [] } }, { type: "ErrorResponse", web: { results: [] } }, { type: "search", web: { results: null } }, { type: "ErrorResponse", error: { detail: "secret message" } }])("rejects malformed or foreign result formats", async body => {
    mocks.fetch.mockResolvedValue(result(body));
    await expect(searchWeb(BRAVE_SEARCH_ENDPOINT, query, { apiKey: "key" })).rejects.toThrow("did not return Brave Web Search results");
  });

  it("rejects a missing key and excessive word count before sending", async () => {
    await expect(searchWeb(BRAVE_SEARCH_ENDPOINT, query)).rejects.toThrow("requires an API-key");
    await expect(searchWeb(BRAVE_SEARCH_ENDPOINT, searchRequest({ query: Array(76).fill("a").join(" ") }), { apiKey: "key" })).rejects.toThrow("75 words");
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.fetch.mockResolvedValue(result({ type: "search", web: { results: [] } }));
    await searchWeb(BRAVE_SEARCH_ENDPOINT, searchRequest({ query: Array(75).fill("a").join(" ") }), { apiKey: "key" });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 422, 429, 500])("reports HTTP %s without leaking keys or provider bodies", async status => {
    mocks.fetch.mockResolvedValue(new Response("private-brave-key sensitive provider body", { status }));
    const error = await searchWeb(BRAVE_SEARCH_ENDPOINT, query, { apiKey: "private-brave-key" }).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`HTTP ${status}`);
    expect((error as Error).message).not.toMatch(/private-brave-key|sensitive provider body|JSON search is enabled/);
    if (status === 429) expect((error as Error).message).toContain("rate or quota");
    if (status === 401 || status === 403 || status === 422) expect((error as Error).message).toContain("API-key");
  });

  it.each([
    "http://api.search.brave.com/res/v1/web/search",
    "https://api.search.brave.com:8443/res/v1/web/search",
    "https://api.search.brave.com/res/v1/images/search",
    "https://api.search.brave.com/res/v1/web/search?api_key=private",
    "https://user:private@api.search.brave.com/res/v1/web/search",
    "https://api.search.brave.com/res/v1/web/search#fragment"
  ])("rejects unsupported or unsafe Brave endpoint %s", async endpoint => {
    await expect(searchWeb(endpoint, query, { apiKey: "key" })).rejects.toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not recognize lookalike hosts and confines requests to the selected path", async () => {
    expect(searchDestination(new URL("https://api.search.brave.com.evil.example")).provider).toBe("searxng");
    await expect(additionalPolicy(new URL(BRAVE_SEARCH_ENDPOINT), new URL(BRAVE_SEARCH_ENDPOINT))).resolves.toBeUndefined();
    await expect(additionalPolicy(new URL(BRAVE_SEARCH_ENDPOINT), new URL(BRAVE_SEARCH_ENDPOINT + "/search"))).rejects.toThrow("Only the configured search endpoint");
    await expect(additionalPolicy(new URL(BRAVE_SEARCH_ENDPOINT), new URL("https://evil.example/res/v1/web/search"))).rejects.toThrow("origin differs");
  });

  it("keeps SearXNG authentication separate when switching providers", async () => {
    mocks.fetch.mockResolvedValueOnce(result({ type: "search", web: { results: [] } })).mockResolvedValueOnce(result({ results: [] }));
    await searchWeb(BRAVE_SEARCH_ENDPOINT, query, { apiKey: "brave-key" });
    await searchWeb("https://searx.example", query, { apiKey: "searx-key" });
    expect(mocks.fetch.mock.calls[0][2].headers).not.toHaveProperty("Authorization");
    expect(mocks.fetch.mock.calls[1][2].headers).toHaveProperty("Authorization", "Bearer searx-key");
    expect(mocks.fetch.mock.calls[1][2].headers).not.toHaveProperty("X-Subscription-Token");
  });
});
