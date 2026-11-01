import { inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureServerConnections, withConnectionDraft } from "../src/llm/connection.js";
import { clearServerCaches, fetchServerMetadata, onServerCapabilitiesChange } from "../src/llm/server.js";
import type { ServerBackend } from "../src/llm/serverTypes.js";

const endpoint = "http://127.0.0.1:8000/proxy/v1";
const tokenizer = () => Response.json({ count: 2, tokens: [1, 2], max_model_len: 8192 });
const completion = () => Response.json({ choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }] });
let backend: ServerBackend;
let probe: () => Response | Promise<Response>;
let probes: { url: string; body: Record<string, unknown>; headers: Headers }[];

function connect(model = "test-model", apiKey?: string, force = false) {
  return withConnectionDraft({ endpoint, model }, apiKey, () => fetchServerMetadata(endpoint, { model, force, probeImages: true }));
}

beforeEach(() => {
  clearServerCaches(); configureServerConnections();
  backend = "vllm"; probes = []; probe = tokenizer;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.includes("/props")) return backend === "llama.cpp"
      ? Response.json({ model_alias: "test-model", default_generation_settings: { n_ctx: 8192 }, modalities: { vision: false } })
      : new Response("Not found", { status: 404 });
    if (url.endsWith("/v1/models")) return Response.json({ data: ["test-model", "other-model"].map(id => ({ id, owned_by: "vllm", max_model_len: 8192 })) });
    if (body.messages) {
      probes.push({ url, body, headers: new Headers(init.headers) });
      return probe();
    }
    if (url.endsWith("/tokenize")) return tokenizer();
    throw new Error(`Unexpected request ${url}`);
  }));
});
afterEach(() => { clearServerCaches(); configureServerConnections(); vi.unstubAllGlobals(); });

describe("image support on connection", () => {
  it.each(["vllm", "llama.cpp"] as const)("checks %s with a valid tiny in-memory image and selected model/key", async server => {
    backend = server; probe = server === "vllm" ? tokenizer : completion;
    const result = await connect("test-model", "secret");
    expect(result).toMatchObject({ backend: server, imageSupport: "supported", supportsVision: true });
    expect(probes).toHaveLength(1);
    const { url, body, headers } = probes[0];
    expect(url).toBe(`http://127.0.0.1:8000/proxy/${server === "vllm" ? "tokenize" : "v1/chat/completions"}`);
    expect(headers.get("Authorization")).toBe("Bearer secret");
    expect(body.model).toBe("test-model");
    expect(body).not.toHaveProperty("thinking_budget_tokens");
    expect(body).not.toHaveProperty("thinking_token_budget");
    if (server === "llama.cpp") expect(body).toMatchObject({ max_tokens: 1, stream: false });
    else expect(body).not.toHaveProperty("max_tokens");
    const messages = body.messages as { content: { type: string; image_url?: { url: string } }[] }[];
    const imageUrl = messages[0].content.find(part => part.type === "image_url")!.image_url!.url;
    expect(imageUrl).toMatch(/^data:image\/png;base64,/);
    const png = Buffer.from(imageUrl.split(",")[1], "base64");
    expect(png.length).toBeLessThan(100);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([28, 28]);
    expect(inflateSync(png.subarray(41, png.length - 16))).toHaveLength(28 * (1 + 28 * 3));
  });

  it.each(["vllm", "llama.cpp"] as const)("treats explicit unsupported images on %s as a successful text-only connection", async server => {
    backend = server;
    probe = () => Response.json({ error: { message: server === "vllm" ? "test-model is not a multimodal model" : "image input is not supported - hint: provide the mmproj" } }, { status: 400 });
    expect(await connect()).toMatchObject({ backend: server, supportsVision: false, imageSupport: "unsupported" });
    expect(await connect()).toMatchObject({ supportsVision: false });
    expect(probes).toHaveLength(1);
  });

  it.each([
    [401, "image input is not supported"], [403, "Forbidden"], [503, "image input is not supported"],
    [400, "Cannot decode image"], [400, "Image decoding failed in mmproj"],
    [400, "At most 0 images may be provided"], [413, "Request too large"]
  ])("keeps HTTP %s (%s) separate from unsupported images and permits retry", async (status, message) => {
    probe = () => Response.json({ error: { message } }, { status: Number(status) });
    await expect(connect()).rejects.toThrow(`HTTP ${status}`);
    expect((await withConnectionDraft({ endpoint, model: "test-model" }, undefined, () => fetchServerMetadata(endpoint))).imageSupport).toBe("unknown");
    probe = tokenizer;
    expect((await connect()).imageSupport).toBe("supported");
    expect(probes).toHaveLength(2);
  });

  it.each(["vllm", "llama.cpp"] as const)("rejects malformed or incomplete %s responses", async server => {
    backend = server;
    for (const response of [() => new Response("not JSON"), () => Response.json({}), () => server === "vllm"
      ? Response.json({ count: 0, tokens: [], max_model_len: 8192 })
      : Response.json({ choices: [{ message: { role: "assistant" }, finish_reason: null }] })]) {
      probe = response;
      await expect(connect()).rejects.toThrow();
    }
    probe = server === "vllm" ? tokenizer : completion;
    expect((await connect()).imageSupport).toBe("supported");
  });

  it("does not expose credentials from probe errors", async () => {
    probe = () => new Response("rejected secret-key", { status: 401 });
    await expect(connect("test-model", "secret-key")).rejects.toThrow("rejected [redacted]");
  });

  it("shares concurrent probes, caches them, and rechecks on explicit reconnect", async () => {
    let finish!: (response: Response) => void;
    probe = () => new Promise(resolve => { finish = resolve; });
    const first = connect();
    await vi.waitFor(() => expect(probes).toHaveLength(1));
    const second = connect();
    finish(tokenizer());
    expect((await Promise.all([first, second])).map(m => m.imageSupport)).toEqual(["supported", "supported"]);
    await connect();
    expect(probes).toHaveLength(1);
    probe = () => new Response("only supports text", { status: 400 });
    expect((await connect("test-model", undefined, true)).imageSupport).toBe("unsupported");
    expect(probes).toHaveLength(2);
  });

  it("checks again for a different model, key or endpoint", async () => {
    await connect(); await connect("other-model"); await connect("test-model", "key");
    const other = "http://127.0.0.1:8001/proxy/v1";
    await withConnectionDraft({ endpoint: other, model: "test-model" }, undefined, () => fetchServerMetadata(other, { probeImages: true }));
    expect(probes).toHaveLength(4);
  });

  it("does not publish a probe invalidated by a connection change", async () => {
    let finish!: (response: Response) => void;
    probe = () => new Promise(resolve => { finish = resolve; });
    const changed = vi.fn();
    const subscription = onServerCapabilitiesChange(changed);
    try {
      const pending = connect();
      await vi.waitFor(() => expect(probes).toHaveLength(1));
      clearServerCaches();
      finish(tokenizer()); await pending;
      expect(changed).not.toHaveBeenCalled();
      probe = () => new Response("only supports text", { status: 400 });
      expect((await connect()).imageSupport).toBe("unsupported");
      expect(probes).toHaveLength(2);
    } finally { subscription.dispose(); }
  });

  it("does not cache timeouts or cancellations as image support", async () => {
    probe = () => { throw new DOMException("Timed out", "TimeoutError"); };
    await expect(connect()).rejects.toThrow("Timed out");
    const controller = new AbortController();
    probe = () => { controller.abort(); return tokenizer(); };
    await expect(withConnectionDraft({ endpoint, model: "test-model" }, undefined,
      () => fetchServerMetadata(endpoint, { probeImages: true, signal: controller.signal }))).rejects.toThrow();
    probe = tokenizer;
    expect((await connect()).imageSupport).toBe("supported");
    expect(probes).toHaveLength(3);
  });
});
