import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete, streamChat, type ChatCompletionRequest, type LlmStreamChunk } from "../src/llm/client.js";
import { configureServerConnections, withServerConnection, type ServerConnection } from "../src/llm/connection.js";
import { clearServerCaches, fetchServerMetadata, serializeRequest, verifyServerProtocol } from "../src/llm/server.js";
import { GenerationLengthError, StreamFailure } from "../src/llm/completion.js";
import { measureRequestPrompt } from "../src/chat/contextTracker.js";
import { responseSource } from "../src/llm/responses.js";
import { replayResponseHistory, type ResponseOutputItem } from "../src/llm/responseHistory.js";

const endpoint = "http://127.0.0.1:8080/proxy/v1";
const message = (text = "Hello"): ResponseOutputItem => ({ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const call = (id = "call_1", name = "read_file", args = '{"path":"a.ts"}'): ResponseOutputItem => ({ type: "function_call", id: `fc_${id}`, call_id: id, status: "completed", name, arguments: args });
const reason = (): ResponseOutputItem => ({ type: "reasoning", id: "rs_1", summary: [], content: [{ type: "reasoning_text", text: "Think" }] });
const terminal = (output: ResponseOutputItem[] = [message()]) => ({ type: "response.completed", response: { status: "completed", output, usage: { input_tokens: 20, output_tokens: 5 } } });
const frame = (value: unknown) => `event: ${String((value as { type?: string }).type ?? "error")}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
const sse = (values: unknown[]) => new Response(values.map(frame).join(""));
const req: ChatCompletionRequest = { messages: [{ role: "user", content: "Hi" }] };
let generation: () => Response;
let requests: { url: string; body: Record<string, unknown>; headers: Headers }[];

beforeEach(() => {
  configureServerConnections(); clearServerCaches(); requests = [];
  generation = () => sse([terminal()]);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    requests.push({ url, body, headers: new Headers(init.headers) });
    if (url.endsWith("/input_tokens") || url.endsWith("/render")) return new Response("Not found", { status: 404 });
    if (url.endsWith("/tokenize")) return Response.json({ tokens: [1, 2], count: 2, max_model_len: 8192 });
    if (url.endsWith("/v1/responses")) return generation();
    if (url.includes("/props")) return Response.json({ model_alias: "local", default_generation_settings: { n_ctx: 8192 }, modalities: { vision: false } });
    throw new Error(`Unexpected request ${url}`);
  }));
});
afterEach(() => { configureServerConnections(); clearServerCaches(); vi.unstubAllGlobals(); });

async function collect(request = req, signal = new AbortController().signal) {
  const chunks: LlmStreamChunk[] = [];
  try { for await (const chunk of streamChat(endpoint, request, signal)) chunks.push(chunk); return { chunks, error: undefined }; }
  catch (error) { return { chunks, error: error as StreamFailure }; }
}

describe("Responses requests", () => {
  it("defaults to Responses and sends stateless input through the guarded proxy URL", async () => {
    expect(await complete(endpoint, req, new AbortController().signal)).toBe("Hello");
    const sent = requests.at(-1)!;
    expect(sent.url).toBe(`${endpoint}/responses`);
    expect(sent.body).toMatchObject({ stream: true, store: false, input: [{ role: "user", content: [{ type: "input_text", text: "Hi" }] }] });
    expect(sent.body).not.toHaveProperty("messages");
    expect(sent.body).not.toHaveProperty("previous_response_id");
    expect(sent.body).not.toHaveProperty("generation");
  });

  it.each(["llama.cpp", "vllm"] as const)("maps %s tools, images, reasoning and local tool-result history", backend => {
    const c: ServerConnection = { endpoint, serverType: backend, backend, model: "test" };
    const body = serializeRequest({ messages: [
      { role: "system", content: "Instructions" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] },
      { role: "assistant", content: "Checking", reasoning_content: "Think", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "Contents" }
    ], tools: [{ type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object", properties: {} } } }],
    top_k: 40, max_tokens: 256, reasoning_effort: "low" }, c);
    expect(body).toMatchObject({ max_output_tokens: 256, reasoning: { effort: "low" }, parallel_tool_calls: false,
      tools: [{ type: "function", name: "read_file", strict: false }] });
    expect(body.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }),
      expect.objectContaining({ type: "reasoning", content: [{ type: "reasoning_text", text: "Think" }] }),
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "Contents" }
    ]));
    expect(backend === "llama.cpp" ? body.extra_params : body).toMatchObject({ top_k: 40 });
  });

  it("rejects finite vLLM reasoning budgets and supports auxiliary reasoning-off", () => {
    const c: ServerConnection = { endpoint, backend: "vllm", serverType: "vllm" };
    expect(() => serializeRequest({ ...req, thinking_budget_tokens: 64 }, c)).toThrow("unlimited or select Chat Completions");
    expect(serializeRequest({ ...req, generation: { task: "compaction", reasoning: { mode: "prefer-off" }, maxOutputTokens: 32 } }, c))
      .toMatchObject({ reasoning: { effort: "none" }, chat_template_kwargs: { enable_thinking: false }, max_output_tokens: 32 });
  });

  it.each([404, 405, 501])("reports HTTP %s without switching protocols", async status => {
    generation = () => new Response("Unsupported endpoint", { status });
    const { error } = await collect();
    expect(error?.message).toContain("Select Chat Completions in Protocol");
    expect(requests.some(r => r.url.includes("chat/completions"))).toBe(false);
  });

  it("keeps an active protocol after settings change", async () => {
    const settings = { endpoint, protocol: "responses" as "responses" | "chat-completions", serverType: "llama.cpp" as const };
    configureServerConnections(() => settings);
    await withServerConnection(settings, async () => {
      settings.protocol = "chat-completions";
      expect(await complete(endpoint, req, new AbortController().signal)).toBe("Hello");
    });
    expect(requests.at(-1)!.url).toBe(`${endpoint}/responses`);
  });
});

describe("Responses terminal evidence", () => {
  it("reconciles deltas and final snapshots once and releases all calls after completion", async () => {
    generation = () => sse([
      { type: "response.output_item.added", output_index: 0, item: { ...message(""), status: "in_progress" } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hel" },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "Hello" },
      { type: "response.output_item.done", output_index: 0, item: message() },
      { type: "response.output_item.added", output_index: 1, item: { ...call(), arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"path":' },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: '"a.ts"}' },
      { type: "response.function_call_arguments.done", output_index: 1, arguments: '{"path":"a.ts"}' },
      terminal([message(), call(), call("call_2")])
    ]);
    const { chunks, error } = await collect();
    expect(error).toBeUndefined();
    expect(chunks.flatMap(c => c.kind === "text" ? c.text : []).join("")).toBe("Hello");
    expect(chunks.filter(c => c.kind === "toolCall")).toHaveLength(2);
    expect(chunks.findIndex(c => c.kind === "finish")).toBeLessThan(chunks.findIndex(c => c.kind === "toolCall"));
    expect(chunks).toContainEqual({ kind: "usage", promptTokens: 20, completionTokens: 5 });
    expect(chunks.find(c => c.kind === "finish")).toMatchObject({ diagnostics: { completionEvidence: "response_completed" } });
  });

  it("handles split UTF-8, multiline SSE, reasoning and write progress", async () => {
    const write = call("write", "write_file", '{"path":"a.ts","content":"caffè ☕"}');
    const payload = [
      { type: "response.output_item.added", output_index: 0, item: { ...write, status: "in_progress", arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"a.ts","content":"caffè ☕"}' },
      terminal([write, reason(), message("caffè ☕")])
    ].map(value => `data: ${JSON.stringify(value, null, 2).replaceAll("\n", "\ndata: ")}\n\n`).join("");
    generation = () => new Response(new ReadableStream({ start(controller) {
      for (const byte of new TextEncoder().encode(payload)) controller.enqueue(new Uint8Array([byte])); controller.close();
    } }));
    const { chunks, error } = await collect();
    expect(error).toBeUndefined();
    expect(chunks).toContainEqual({ kind: "text", text: "caffè ☕" });
    expect(chunks).toContainEqual({ kind: "thought", text: "Think" });
    expect(chunks.some(c => c.kind === "toolCallProgress" && c.id === "write")).toBe(true);
  });

  it.each([
    [[], "unexpected_eof"],
    [[{ type: "response.output_item.done", output_index: 0, item: call() }], "unexpected_eof"],
    [[{ type: "response.failed", response: { status: "failed", error: { message: "Server failed" } } }], "server_error"],
    [[{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "content_filter" } } }], "server_error"],
    [[{ type: "response.completed", response: { status: "in_progress", output: [call()] } }], "protocol_error"],
    [[terminal([call("same"), call("same")])], "protocol_error"],
    [[terminal([call("bad", "read_file", "{")])], "protocol_error"]
  ])("does not execute calls on failed or incomplete output (%j)", async (values, cause) => {
    generation = () => sse(values as unknown[]);
    const { chunks, error } = await collect();
    expect(error?.diagnostics.cause).toBe(cause);
    expect(chunks.some(c => c.kind === "toolCall" || c.kind === "finish")).toBe(false);
  });

  it("retains partial text on output limits without releasing a call", async () => {
    generation = () => sse([
      { type: "response.output_text.delta", output_index: 0, delta: "Partial" },
      { type: "response.incomplete", response: { status: "incomplete", output: [call()], incomplete_details: { reason: "max_output_tokens" } } }
    ]);
    const { chunks, error } = await collect();
    expect(error).toBeInstanceOf(GenerationLengthError);
    expect(error?.diagnostics).toMatchObject({ completionEvidence: "response_incomplete", cause: "generation_limit" });
    expect(chunks).toContainEqual({ kind: "text", text: "Partial" });
    expect(chunks.some(c => c.kind === "toolCall")).toBe(false);
  });

  it("does not accept DONE as completion and rejects malformed data", async () => {
    generation = () => new Response("data: [DONE]\n\n");
    expect((await collect()).error?.diagnostics.cause).toBe("unexpected_eof");
    generation = () => new Response("data: {broken}\n\n");
    expect((await collect()).error?.diagnostics.cause).toBe("protocol_error");
  });

  it("waits for the response failure reason after incomplete item events", async () => {
    generation = () => sse([
      { type: "response.output_item.done", output_index: 0, item: { ...message("Partial"), status: "incomplete" } },
      { type: "response.output_item.done", output_index: 1, item: { ...call("partial", "read_file", "{"), status: "incomplete" } },
      { type: "response.incomplete", response: { status: "incomplete", output: [{ ...message("Partial"), status: "incomplete" }], incomplete_details: { reason: "max_output_tokens" } } }
    ]);
    const { chunks, error } = await collect();
    expect(error).toBeInstanceOf(GenerationLengthError);
    expect(chunks.filter(c => c.kind === "text")).toEqual([{ kind: "text", text: "Partial" }]);
    expect(chunks.some(c => c.kind === "toolCall" || c.kind === "finish")).toBe(false);
  });

  it("retains final-only partial text without marking it as completed history", async () => {
    generation = () => sse([{ type: "response.incomplete", response: { status: "incomplete", output: [{ ...message("Partial"), status: "incomplete" }], incomplete_details: { reason: "max_output_tokens" } } }]);
    const { chunks, error } = await collect();
    expect(error).toBeInstanceOf(GenerationLengthError);
    expect(chunks).toContainEqual({ kind: "text", text: "Partial" });
    expect(chunks.some(c => c.kind === "finish")).toBe(false);
  });

  it("does not release tools after cancellation", async () => {
    const controller = new AbortController();
    generation = () => sse([terminal([call()])]);
    const chunks: LlmStreamChunk[] = [];
    await expect((async () => {
      for await (const chunk of streamChat(endpoint, req, controller.signal)) {
        chunks.push(chunk);
        if (chunk.kind === "finish") controller.abort();
      }
    })()).rejects.toThrow();
    expect(chunks.some(c => c.kind === "toolCall")).toBe(false);
  });
});

describe("Responses history and counting", () => {
  it("replays completed items and call IDs after JSON roundtrip, rejecting edited or foreign history", () => {
    const c: ServerConnection = { endpoint, serverType: "llama.cpp", backend: "llama.cpp", model: "local" };
    const output = [reason(), message(), call()];
    const historyMessage = { role: "assistant" as const, content: "Hello", reasoning_content: "Think", tool_calls: [{ type: "function" as const, id: "call_1", function: { name: "read_file", arguments: '{ "path": "a.ts" }' } }],
      responseHistory: JSON.parse(JSON.stringify({ source: responseSource(c), output })) };
    expect(serializeRequest({ messages: [historyMessage] }, c).input).toEqual(output);
    expect(replayResponseHistory({ ...historyMessage, content: "Edited" }, responseSource(c))).toBeUndefined();
    expect(replayResponseHistory(historyMessage, "different model")).toBeUndefined();
    const chat = serializeRequest({ messages: [historyMessage] }, { ...c, protocol: "chat-completions" });
    expect(JSON.stringify(chat)).not.toContain("responseHistory");
    expect(JSON.stringify(chat)).not.toContain("rs_1");
  });

  it.each(["llama.cpp", "vllm"] as const)("measures %s Responses using its actual request", async backend => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementationOnce(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ input: expect.any(Array), store: false });
      return Response.json(backend === "vllm" ? { token_ids: [1, 2, 3] } : { input_tokens: 3 });
    });
    const result = await withServerConnection({ endpoint, serverType: backend }, () => measureRequestPrompt(endpoint, req, 4));
    expect(result).toEqual({ tokens: 3, accuracy: "exact" });
  });

  it("uses tokenizer estimates only when the optional count route is unavailable", async () => {
    const measurement = await measureRequestPrompt(endpoint, req, 4);
    expect(measurement).toEqual({ tokens: 6, accuracy: "estimated" });
    vi.mocked(fetch).mockImplementationOnce(async () => new Response("Unauthorized", { status: 401 }));
    clearServerCaches();
    await expect(measureRequestPrompt(endpoint, req, 4)).rejects.toThrow("HTTP 401");
  });

  it("checks the selected protocol with a bounded generation and probes images", async () => {
    generation = () => Response.json({ status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" } });
    await verifyServerProtocol(endpoint);
    expect(requests.at(-1)!.body).toMatchObject({ max_output_tokens: 1, stream: false });
    const metadata = await fetchServerMetadata(endpoint, { probeImages: true });
    expect(metadata.imageSupport).toBe("supported");
    expect(requests.at(-1)!.body.input).toEqual(expect.arrayContaining([expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ type: "input_image" })]) })]));
  });
});
