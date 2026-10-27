import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretStorage } from "vscode";
import { complete, streamChat, type ChatCompletionRequest, type LlmStreamChunk } from "../src/llm/client.js";
import { configureServerConnections, hasServerApiKey, saveServerApiKey, serverUrl, withConnectionDraft, withServerConnection } from "../src/llm/connection.js";
import { clearServerCaches, countServerPrompt, fetchServerMetadata, fetchServerModels, onServerCapabilitiesChange, tokenize } from "../src/llm/server.js";
import { memorySignature } from "../src/chat/memoryJobs.js";
import { generateChatTitle } from "../src/chat/chatTitle.js";
import { generateMemory } from "../src/chat/memoryGeneration.js";
import type { ChatRecord } from "../src/chat/types.js";

const settings = { endpoint: "http://127.0.0.1:8000/proxy/v1", model: "test-model", serverType: "vllm" as const };
const messages = [{ role: "user" as const, content: "hello" }];
const tokenResponse = (count = 5, limit = 8192) => Response.json({ count, max_model_len: limit, tokens: Array.from({ length: count }, (_, i) => i) });
const sse = (chunks: unknown[] = [{ choices: [{ delta: { content: "A useful response" }, finish_reason: "stop" }] }], done = true) =>
  new Response(": keepalive\n\n" + chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""));
let calls: { url: string; body: Record<string, unknown>; headers?: HeadersInit }[];
let generation: () => Response;
let tokenizeResponse: (body: Record<string, unknown>) => Response;

beforeEach(() => {
  clearServerCaches(); configureServerConnections(); calls = [];
  generation = () => sse(); tokenizeResponse = () => tokenResponse();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, body, headers: init.headers });
    if (url.includes("/props")) return new Response("Not found", { status: 404 });
    if (url.endsWith("/v1/models")) return Response.json({ data: [{ id: settings.model, owned_by: "vllm", max_model_len: 8192 }, { id: "adapter", owned_by: "vllm" }] });
    if (url.endsWith("/tokenize")) return tokenizeResponse(body);
    if (url.endsWith("/v1/chat/completions")) return generation();
    throw new Error(`Unexpected request ${url}`);
  }));
});
afterEach(() => { configureServerConnections(); clearServerCaches(); vi.unstubAllGlobals(); });

describe("vLLM 0.32 connection contract", () => {
  it("detects vLLM positively, retains proxy paths, and obtains alias limits from the tokenizer", async () => {
    await withServerConnection({ ...settings, serverType: "auto" }, async () => {
      expect(await fetchServerModels(settings.endpoint)).toHaveLength(2);
      expect(await fetchServerMetadata(settings.endpoint)).toMatchObject({ backend: "vllm", contextSize: 8192, imageSupport: "unknown", supportsVision: true });
    });
    await withServerConnection({ ...settings, model: "adapter" }, async () => {
      expect(await fetchServerMetadata(settings.endpoint)).toMatchObject({ modelAlias: "adapter", contextSize: 8192 });
    });
    expect(calls.every(c => c.url.startsWith("http://127.0.0.1:8000/proxy/"))).toBe(true);
    expect(serverUrl("http://localhost:8000/proxy/", "/v1/models")).toBe("http://localhost:8000/proxy/v1/models");
  });

  it.each([401, 403, 500, 503])("does not misclassify a /props HTTP %s as vLLM", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("failure", { status })));
    await expect(withServerConnection({ ...settings, serverType: "auto" }, () => fetchServerMetadata(settings.endpoint))).rejects.toThrow(`HTTP ${status}`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not infer vLLM from a missing /props alone", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("props") ? new Response("", { status: 404 })
      : url.endsWith("models") ? Response.json({ data: [{ id: settings.model, owned_by: "other" }] }) : tokenResponse()));
    await expect(withServerConnection({ ...settings, serverType: "auto" }, () => fetchServerMetadata(settings.endpoint))).rejects.toThrow("Could not identify");
    await expect(withServerConnection(settings, () => fetchServerMetadata(settings.endpoint))).resolves.toMatchObject({ backend: "vllm" });
  });

  it("rejects invalid context and tokenizer data", async () => {
    tokenizeResponse = () => Response.json({ count: 5, tokens: [1], max_model_len: 0 });
    await expect(withServerConnection(settings, () => fetchServerMetadata(settings.endpoint))).rejects.toThrow("invalid tokenizer");
  });

  it("does not expose malformed metadata bodies in errors", async () => {
    tokenizeResponse = () => new Response("private-key is not JSON");
    await expect(withConnectionDraft(settings, "private-key", () => fetchServerMetadata(settings.endpoint))).rejects.toThrow("malformed JSON");
  });

  it("stores credentials by server, snapshots them, and redacts server echoes", async () => {
    const entries = new Map<string, string>();
    const secrets = { get: async (k: string) => entries.get(k), store: async (k: string, v: string) => { entries.set(k, v); }, delete: async (k: string) => { entries.delete(k); } } as unknown as SecretStorage;
    configureServerConnections(() => settings, secrets);
    await saveServerApiKey(settings.endpoint, "private-test-key");
    expect(await hasServerApiKey(settings.endpoint)).toBe(true);
    expect(await hasServerApiKey("http://127.0.0.1:8001/v1")).toBe(false);
    await withServerConnection(settings, async () => {
      await saveServerApiKey(settings.endpoint, "replacement");
      await complete(settings.endpoint, { messages }, new AbortController().signal);
    });
    expect(calls.every(c => (c.headers as Record<string, string>).Authorization === "Bearer private-test-key")).toBe(true);
    generation = () => new Response("rejected private-test-key", { status: 401 });
    await expect(withConnectionDraft(settings, "private-test-key", () => complete(settings.endpoint, { messages }, new AbortController().signal))).rejects.toThrow("[redacted]");
    await saveServerApiKey(settings.endpoint, "");
    expect(await hasServerApiKey(settings.endpoint)).toBe(false);
  });

  it("keeps an active connection when settings change", async () => {
    const mutable = { ...settings };
    configureServerConnections(() => mutable);
    await withServerConnection(mutable, async () => {
      mutable.endpoint = "http://127.0.0.1:9000/v1";
      await complete(mutable.endpoint, { messages }, new AbortController().signal);
    });
    expect(calls.every(c => c.url.includes(":8000/proxy/"))).toBe(true);
  });

  it("does not reuse metadata validated with a different draft credential", async () => {
    await withConnectionDraft(settings, "valid-key", () => fetchServerMetadata(settings.endpoint));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Unauthorized", { status: 401 })));
    await expect(withConnectionDraft(settings, "wrong-key", () => fetchServerMetadata(settings.endpoint))).rejects.toThrow("HTTP 401");
  });

  it("reports unavailable credentials inside the attempt without sending unauthenticated requests", async () => {
    configureServerConnections(() => settings, { get: async () => { throw new Error("Credential store locked"); } } as unknown as SecretStorage);
    let attempted = false;
    await withServerConnection(settings, async () => {
      attempted = true;
      await expect(fetchServerMetadata(settings.endpoint)).rejects.toThrow("SecretStorage");
    });
    expect(attempted).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("separates memory checkpoints by backend, model and normalized endpoint", () => {
    const signature = memorySignature(settings.endpoint, settings.model, "vllm");
    expect(memorySignature(settings.endpoint.replace(/\/v1$/, "/"), settings.model, "vllm")).toBe(signature);
    expect(memorySignature(settings.endpoint, settings.model, "llama.cpp")).not.toBe(signature);
    expect(memorySignature(settings.endpoint, "adapter", "vllm")).not.toBe(signature);
    expect(memorySignature("http://localhost:9000/v1", settings.model, "vllm")).not.toBe(signature);
  });
});

describe("vLLM generation", () => {
  it("maps reasoning, history and tool options and counts actual messages and tools", async () => {
    const req: ChatCompletionRequest = { model: settings.model, messages: [...messages, { role: "assistant", content: "answer", reasoning_content: "reason" }],
      thinking_budget_tokens: 32, reasoning_effort: "low", max_tokens: 64, return_progress: true, parallel_tool_calls: false,
      tools: [{ type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object", properties: {} } } }] };
    await withServerConnection(settings, () => complete(settings.endpoint, req, new AbortController().signal));
    const body = calls.find(c => c.url.endsWith("completions"))!.body;
    expect(body).toMatchObject({ thinking_token_budget: 32, max_completion_tokens: 64, reasoning_effort: "low" });
    expect(body).not.toHaveProperty("thinking_budget_tokens"); expect(body).not.toHaveProperty("return_progress"); expect(body).not.toHaveProperty("parallel_tool_calls");
    expect((body.messages as Record<string, unknown>[])[1]).toMatchObject({ reasoning: "reason" });
    const counted = calls.find(c => c.url.endsWith("tokenize"))!.body;
    expect(counted.messages).toEqual(body.messages); expect(counted.tools).toEqual(req.tools);
    expect(counted.chat_template_kwargs).toMatchObject({ reasoning_effort: "low", enable_thinking: true });
  });

  it("supports off, unlimited and finite reasoning without forcing parser requirements on auxiliary work", async () => {
    for (const req of [{ thinking_budget_tokens: 0 }, { thinking_budget_tokens: -1 }, { purpose: "auxiliary" as const, thinking_budget_tokens: 1024 }]) {
      await withServerConnection(settings, () => complete(settings.endpoint, { messages, ...req }, new AbortController().signal));
    }
    const bodies = calls.filter(c => c.url.endsWith("completions")).map(c => c.body);
    expect(bodies.every(b => !("thinking_token_budget" in b))).toBe(true);
    expect(bodies[0]).toMatchObject({ reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } });
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
    expect(bodies[2]).toMatchObject({ reasoning_effort: "none" });
    await expect(withServerConnection(settings, () => complete(settings.endpoint, { messages, reasoning_effort: "unsupported" }, new AbortController().signal))).rejects.toThrow("does not support reasoning effort");
  });

  it("requires successful preprocessing and reserves output space", async () => {
    tokenizeResponse = () => tokenResponse(8180);
    await expect(withServerConnection(settings, () => complete(settings.endpoint, { messages, max_tokens: 64 }, new AbortController().signal))).rejects.toThrow("output budget");
    expect(calls.some(c => c.url.endsWith("completions"))).toBe(false);
    await expect(withServerConnection(settings, () => complete(settings.endpoint, { messages }, new AbortController().signal))).rejects.toThrow("output budget");
  });

  it("reports parser configuration errors with a remedy", async () => {
    generation = () => new Response("thinking_token_budget is set but reasoning_config is not configured", { status: 400 });
    await expect(withServerConnection(settings, () => complete(settings.endpoint, { messages, thinking_budget_tokens: 16 }, new AbortController().signal))).rejects.toThrow("--reasoning-parser");
  });

  it("preserves terminal evidence, reasoning, usage, and all tool calls", async () => {
    generation = () => sse([
      { choices: [{ delta: { reasoning: "thinking", tool_calls: [{ index: 0, id: "a", function: { name: "read_file", arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }, { index: 1, id: "b", function: { name: "read_file", arguments: '{"path":"b"}' } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 42, completion_tokens: 12 } }
    ]);
    const chunks: LlmStreamChunk[] = [];
    await withServerConnection(settings, async () => { for await (const c of streamChat(settings.endpoint, { messages }, new AbortController().signal)) chunks.push(c); });
    expect(chunks.filter(c => c.kind === "toolCall")).toHaveLength(2);
    expect(chunks.findIndex(c => c.kind === "finish")).toBeLessThan(chunks.findIndex(c => c.kind === "toolCall"));
    expect(chunks).toContainEqual({ kind: "thought", text: "thinking" });
    expect(chunks).toContainEqual({ kind: "usage", promptTokens: 42, completionTokens: 12 });
  });

  it("does not release unfinished tools on EOF or cancellation", async () => {
    generation = () => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "read_file", arguments: '{"path":' } }] } }] }], false);
    const chunks: LlmStreamChunk[] = [];
    await expect(withServerConnection(settings, async () => { for await (const c of streamChat(settings.endpoint, { messages }, new AbortController().signal)) chunks.push(c); })).rejects.toThrow("before confirming completion");
    expect(chunks.some(c => c.kind === "toolCall")).toBe(false);
    const controller = new AbortController(); controller.abort();
    await expect(withServerConnection(settings, () => complete(settings.endpoint, { messages }, controller.signal))).rejects.toThrow();
  });

  it("validates images on first use without classifying ordinary failures as missing vision", async () => {
    const updated = vi.fn();
    const subscription = onServerCapabilitiesChange(updated);
    const req: ChatCompletionRequest = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }] };
    await withServerConnection(settings, async () => {
      expect((await fetchServerMetadata(settings.endpoint)).imageSupport).toBe("unknown");
      tokenizeResponse = () => new Response("Invalid image data", { status: 400 });
      await expect(countServerPrompt(settings.endpoint, req)).rejects.toThrow("Invalid image");
      expect((await fetchServerMetadata(settings.endpoint)).imageSupport).toBe("unknown");
      tokenizeResponse = () => tokenResponse(4097);
      expect(await countServerPrompt(settings.endpoint, req)).toBe(4097);
      expect((await fetchServerMetadata(settings.endpoint)).imageSupport).toBe("supported");
      expect((await fetchServerMetadata(settings.endpoint, { force: true })).imageSupport).toBe("supported");
      tokenizeResponse = () => new Response("This model does not support image input", { status: 400 });
      await expect(countServerPrompt(settings.endpoint, req)).rejects.toThrow("does not support image input");
      expect((await fetchServerMetadata(settings.endpoint)).imageSupport).toBe("unsupported");
    });
    expect(updated).toHaveBeenCalledTimes(2);
    subscription.dispose();
  });

  it("uses exact raw tokenization and supports auxiliary titles and memory", async () => {
    await withServerConnection(settings, async () => {
      expect(await tokenize(settings.endpoint, "text", settings.model, { exact: true })).toBe(5);
      expect(calls[0].body).toEqual({ model: settings.model, prompt: "text", add_special_tokens: false });
      expect(await generateChatTitle("hello", { ...settings, topK: 40, topP: 0.95, titlePrompt: "Name this" })).toBe("A useful response");
      const record = { messages: [{ role: "user", content: "We use strict TypeScript", ts: 1 }] } as ChatRecord;
      expect(await generateMemory(record, settings.endpoint, settings.model, new AbortController().signal)).toBe("A useful response");
    });
    expect(calls.filter(c => c.url.endsWith("completions")).every(c => c.body.reasoning_effort === "none")).toBe(true);
  });
});
