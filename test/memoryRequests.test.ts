import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchServerContextSize, tokenize } from "../src/llm/client.js";
import { countTokens } from "../src/chat/contextTracker.js";

afterEach(() => vi.unstubAllGlobals());

describe("memory request prerequisites", () => {
  it("does not reuse a token estimate as an authoritative count", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokens: [1, 2, 3, 4, 5, 6, 7] })));
    vi.stubGlobal("fetch", fetch);
    const endpoint = "http://127.0.0.1:8411";
    expect(await countTokens(endpoint, "漢字abcdef", "exact-cache")).toBe(2);
    expect(await countTokens(endpoint, "漢字abcdef", "exact-cache", { exact: true })).toBe(7);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await countTokens(endpoint, "漢字abcdef", "exact-cache", { exact: true })).toBe(7);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([{ missing: [] }, { tokens: ["bad"] }, { tokens: null }, { tokens: [] }, null])("rejects malformed exact tokenizer output %j", async body => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    await expect(tokenize("http://127.0.0.1:8412", "text", undefined, { exact: true })).rejects.toMatchObject({ diagnostics: { cause: "protocol_error" } });
  });

  it("preserves the HTTP status for retry classification", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret body", { status: 503 })));
    await expect(fetchServerContextSize("http://127.0.0.1:8413", "missing", { strict: true })).rejects.toMatchObject({ diagnostics: { cause: "server_error", httpStatus: 503 } });
  });

  it.each(["metadata", "tokenization"])("cancels an in-flight %s request", async stage => {
    let seen!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      seen = init.signal!;
      seen.addEventListener("abort", () => reject(seen.reason), { once: true });
    })));
    const controller = new AbortController();
    const pending = stage === "metadata"
      ? fetchServerContextSize("http://127.0.0.1:8414", "abort", { signal: controller.signal, strict: true })
      : tokenize("http://127.0.0.1:8414", "text", "abort", { signal: controller.signal, exact: true });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(seen).toBeDefined());
    controller.abort(); await rejected;
    expect(seen.aborted).toBe(true);
  });

  it("does not treat cancellation as permission to return a cached count", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ tokens: [1] }))));
    await countTokens("http://127.0.0.1:8415", "cache", "model", { exact: true });
    const signal = AbortSignal.abort();
    await expect(countTokens("http://127.0.0.1:8415", "cache", "model", { exact: true, signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
