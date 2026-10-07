import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), settings: vi.fn() }));
vi.mock("../src/network/safeFetch.js", () => ({ safeFetch: mocks.fetch }));
vi.mock("../src/config/settings.js", () => ({ readSettings: mocks.settings }));
import type { HarnessSettings } from "../src/config/settings.js";
import { createSearchFeature } from "../src/features/webSearch/runtime.js";
import { searchRequest, searchWeb, searchUrl } from "../src/features/webSearch/search.js";
import { additionalPolicy } from "../src/features/webSearch/networkPolicy.js";
import { chatFeature } from "../src/features/advanced/chat.js";

beforeEach(() => { mocks.fetch.mockReset(); mocks.settings.mockReset(); });
describe("SearXNG search", () => {
  it("sends only query/options and normalizes bounded safe results", async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ results: [
      { title: "<b>Title</b>", url: "https://example.org/page", content: "<img src=x>Snippet", publishedDate: "2026-01-02" },
      { title: "duplicate", url: "https://example.org/page" },
      { title: "bad", url: "javascript:alert(1)" },
      { title: "credentials", url: "https://user:password@example.org/" }
    ] })));
    expect(await searchWeb("http://localhost:8888", searchRequest({ query: "reference docs" }))).toEqual([
      { title: "Title", url: "https://example.org/page", snippet: "Snippet", published: "2026-01-02" }
    ]);
    const [endpoint, request, options] = mocks.fetch.mock.calls[0];
    expect(endpoint).toBe("http://localhost:8888");
    expect(new URL(request).searchParams.get("q")).toBe("reference docs");
    expect(new URL(request).searchParams.get("format")).toBe("json");
    expect(options).toMatchObject({ additional: true, maxResponseBytes: 1048576, headers: { Accept: "application/json", "User-Agent": "Locality (+https://github.com/liandir/locality)" } });
    expect(options.body).toBeUndefined();
    expect(options.headers).not.toHaveProperty("Authorization");
  });

  it.each(["", "ftp://example.org", "http://example.org", "https://user:pass@example.org", "https://example.org/?token=x"])("rejects invalid endpoint %s", async endpoint => {
    await expect(searchUrl(endpoint)).rejects.toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("confines requests to the exact configured search origin and path", async () => {
    await expect(additionalPolicy(new URL("https://search.example"), new URL("https://evil.example/search"))).rejects.toThrow();
    await expect(additionalPolicy(new URL("https://search.example"), new URL("https://search.example/private"))).rejects.toThrow();
    expect((await searchUrl("https://search.example/subpath")).pathname).toBe("/subpath/search");
  });

  it("returns helpful errors without provider response bodies", async () => {
    mocks.fetch.mockResolvedValue(new Response("secret provider body", { status: 403 }));
    await expect(searchWeb("https://search.example", { query: "docs", count: 5 })).rejects.toThrow("HTTP 403");
    mocks.fetch.mockResolvedValue(new Response("private rate-limit body", { status: 429 }));
    await expect(searchWeb("https://search.example", { query: "docs", count: 5 })).rejects.toThrow("rate limiting requests (HTTP 429)");
    mocks.fetch.mockResolvedValue(new Response("not json"));
    await expect(searchWeb("https://search.example", { query: "docs", count: 5 })).rejects.toThrow("invalid JSON");
  });

  it.each([{ query: "" }, { query: "x".repeat(501) }, { query: "x", count: 0 }, { query: "x", count: 21 }, { query: "x", count: 1.5 }])("rejects invalid arguments", args => {
    expect(() => searchRequest(args)).toThrow();
  });

  it.each([
    [undefined, undefined, 5],
    [20, undefined, 10],
    [undefined, 2, 2],
    [20, 12, 12],
    [3, 20, 3],
    [20, 20, 20]
  ])("caps requested count %s with setting %s at %s", (count, maximum, expected) => {
    expect(searchRequest({ query: "docs", count }, maximum).count).toBe(expected);
  });

  it.each([3, 20])("enforces the current %s-result limit after approval and displays every result", async maximum => {
    const feature = createSearchFeature();
    const args = { query: "docs", count: 20 };
    const settings = { webSearchEndpoint: "https://search.example", webToolsEnabled: true, webSearchMaxResults: 20 } as HarnessSettings;
    await feature.prepare("web_search", args, settings);
    mocks.settings.mockReturnValue({ ...settings, webSearchMaxResults: maximum });
    mocks.fetch.mockImplementation((_endpoint, url: string) => Promise.resolve(
      new URL(url).hostname === "search.example"
        ? new Response(JSON.stringify({ results: Array.from({ length: 25 }, (_, i) => ({
          title: `Result ${i}`, url: `https://example.org/page${i}`, content: "Snippet"
        })) }))
        : new Response("", { status: 404 })
    ));
    const result = await feature.execute("web_search", args, "limit");
    expect(JSON.parse(result.result).results).toHaveLength(maximum);
    const html = chatFeature.renderResult!({ toolId: "limit", toolName: "web_search", status: "executed", resultPreview: result.result }, value => value, "<hr>");
    expect(html?.match(/class="tool-filelist-item"/g)).toHaveLength(maximum);
  });

  it("renders escaped clickable sources, never active provider HTML", () => {
    const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
    const html = chatFeature.renderResult!({ toolId: "a", toolName: "web_search", status: "executed", resultPreview: JSON.stringify({ query: "<query>", results: [
      { title: "<img src=x>", snippet: "<script>x</script>", url: "https://example.org/" },
      { title: "bad", url: "javascript:alert(1)" }
    ] }) }, escape, "<hr>");
    expect(html).toContain('href="https://example.org/"');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("&lt;img");
    expect(html).not.toContain("&lt;script");
    expect(html).not.toContain("&lt;query");
    expect(html).toContain('>https://example.org/</a>');
  });

  it("keeps the query and linked page URL in the tool label, including failed calls", () => {
    const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
    for (const status of ["executed", "failed", "pending"] as const) {
      const card = { toolId: "label", toolName: "web_search", status };
      expect(chatFeature.renderLabel!(card, { query: '<query "quoted">' }, escape)).toContain('for &lt;query &quot;quoted&quot;>');
      const page = { ...card, toolName: "read_webpage" };
      expect(chatFeature.renderLabel!(page, { url: "https://example.org/?a=1&b=2" }, escape)).toContain('href="https://example.org/?a=1&amp;b=2"');
      expect(chatFeature.renderLabel!(page, { url: "javascript:alert(1)" }, escape)).toBe("");
      expect(chatFeature.renderLabel!(page, { url: "https://user:secret@example.org" }, escape)).toBe("");
    }
    expect(chatFeature.icons?.web_search).toContain("<circle");
    expect(chatFeature.icons?.read_webpage).toBe(chatFeature.icons?.web_search);
  });

  it("keeps downloaded favicons in the display payload, not model results", async () => {
    const feature = createSearchFeature();
    const args = { query: "docs" };
    const settings = { webSearchEndpoint: "https://search.example", webToolsEnabled: true } as HarnessSettings;
    mocks.settings.mockReturnValue(settings);
    await feature.prepare("web_search", args, settings);
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ url: "https://example.org/docs", title: "Documentation", content: "Full model snippet" }] })))
      .mockResolvedValueOnce(new Response(new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0])));
    const result = await feature.execute("web_search", args, "call");
    expect(JSON.parse(result.result).results[0]).toMatchObject({ title: "Documentation", snippet: "Full model snippet" });
    expect(result.result).not.toContain("base64");
    expect(JSON.parse(result.displayResult!).results[0]).toMatchObject({ url: "https://example.org/docs", favicon: expect.stringContaining("data:image/png;base64,") });
  });

  it("accepts only embedded raster icons in result markup", () => {
    for (const icon of ["https://tracker.example/favicon.ico", "data:image/svg+xml;base64,PHN2Zz4=", 'x" onerror="bad()']) {
      const html = chatFeature.renderResult!({ toolId: "icon", toolName: "web_search", status: "executed", resultPreview: JSON.stringify({ results: [{ url: "https://example.org", favicon: icon }] }) }, v => v, "<hr>");
      expect(html).not.toContain("<img");
    }
  });

  it.each([undefined, false, "true", 1])("requires approval unless search auto-approval is explicitly true (%s)", value => {
    const feature = createSearchFeature();
    const settings = { autoapproveWebSearch: value, autoapproveCommands: true, autoapproveReads: true } as unknown as HarnessSettings;
    expect(feature.needsApproval(settings)).toBe(true);
  });

  it.each([false, true])("refuses changed destinations with auto-approval %s", async autoapproveWebSearch => {
    const feature = createSearchFeature();
    const args = { query: "docs" };
    const settings = { webSearchEndpoint: "https://search.example", webToolsEnabled: true, autoapproveWebSearch } as HarnessSettings;
    expect(feature.needsApproval(settings)).toBe(!autoapproveWebSearch);
    await feature.prepare("web_search", args, settings);
    const changed = { ...settings, webSearchEndpoint: "https://another.example" };
    await expect(feature.prepare("web_search", args, changed)).rejects.toThrow("destination changed");
    mocks.settings.mockReturnValue(changed);
    await expect(feature.execute("web_search", args, "call-1")).rejects.toThrow("no longer approved");
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.settings.mockReturnValue(settings);
    mocks.fetch.mockResolvedValue(new Response('{"results":[]}'));
    expect(await feature.execute("web_search", args, "call-1")).toEqual({ result: '{"query":"docs","results":[]}' });
  });
  it("sends an optional key only in the authorization header", async () => {
    mocks.fetch.mockResolvedValue(new Response('{"results":[]}'));
    await searchWeb("https://search.example", { query: "docs", count: 1 }, { apiKey: " test-secret " });
    const [endpoint, url, options] = mocks.fetch.mock.calls[0];
    expect(options.headers.Authorization).toBe("Bearer test-secret");
    expect(endpoint + url).not.toContain("test-secret");
    expect(options.body).toBeUndefined();
  });

  it.each(["", "wrong-key"])("explains HTTP 401 with key %s", async apiKey => {
    mocks.fetch.mockResolvedValue(new Response("private response", { status: 401 }));
    await expect(searchWeb("https://search.example", { query: "docs", count: 1 }, { apiKey }))
      .rejects.toThrow(apiKey ? "authentication failed (HTTP 401)" : "requires authentication (HTTP 401)");
  });

  it("sanitizes transport errors and rejects malformed keys before sending", async () => {
    mocks.fetch.mockRejectedValue(new TypeError("fetch failed with secret-key"));
    await expect(searchWeb("https://search.example", { query: "docs", count: 1 }, { apiKey: "secret-key" }))
      .rejects.toThrow("Could not connect to the search service");
    mocks.fetch.mockClear();
    await expect(searchWeb("https://search.example", { query: "docs", count: 1 }, { apiKey: "secret\nInjected: value" }))
      .rejects.toThrow("printable characters");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("leaves failed search results to the common red error-card renderer", () => {
    expect(chatFeature.renderResult!({ toolId: "error", toolName: "web_search", status: "failed", resultPreview: "error: Search service requires authentication (HTTP 401)." }, value => value, "<hr>"))
      .toBeUndefined();
  });

});
