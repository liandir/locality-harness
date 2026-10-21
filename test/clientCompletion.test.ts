import { afterEach, describe, expect, it, vi } from "vitest";
import { streamChat, StreamFailure, GenerationLengthError, type LlmStreamChunk } from "../src/llm/client.js";

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const choice = (delta: unknown, finish_reason?: string) => frame({ choices: [{ delta, finish_reason }] });

async function collect(payload: string | Uint8Array[], signal = new AbortController().signal) {
  const bytes = typeof payload === "string" ? [new TextEncoder().encode(payload)] : payload;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
    start(controller) { bytes.forEach(chunk => controller.enqueue(chunk)); controller.close(); }
  }))));
  const chunks: LlmStreamChunk[] = [];
  try {
    for await (const chunk of streamChat("http://127.0.0.1:8080", { messages: [] }, signal)) chunks.push(chunk);
    return { chunks, error: undefined };
  } catch (error) { return { chunks, error: error as StreamFailure }; }
}

afterEach(() => vi.unstubAllGlobals());

describe("stream completion contract", () => {
  it.each(["", choice({ content: "Partial answer" }), choice({ reasoning_content: "Thinking" })])("rejects unconfirmed EOF (%s)", async payload => {
    const { chunks, error } = await collect(payload);
    expect(error?.diagnostics).toMatchObject({ cause: "unexpected_eof", completionEvidence: "none" });
    expect(chunks.some(chunk => chunk.kind === "finish")).toBe(false);
  });

  it.each(["stop", "tool_calls"])("accepts finish_reason=%s without DONE and retains usage trailers", async reason => {
    const { chunks, error } = await collect(choice({ content: "Answer" }, reason) + frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } }));
    expect(error).toBeUndefined();
    expect(chunks.at(-1)).toEqual({ kind: "finish", reason, diagnostics: { completionEvidence: "finish_reason", finishReason: reason, promptTokens: 10, completionTokens: 4 } });
  });

  it("accepts DONE-only completion and processes its unterminated final line", async () => {
    const { chunks, error } = await collect(choice({ content: "Answer" }) + "data: [DONE]");
    expect(error).toBeUndefined();
    expect(chunks.at(-1)).toEqual({ kind: "finish", reason: undefined, diagnostics: { completionEvidence: "done" } });
  });

  it("decodes fragmented UTF-8 and processes a final JSON line without newline", async () => {
    const bytes = new TextEncoder().encode(choice({ content: "caffè ☕" }, "stop").trimEnd());
    const { chunks, error } = await collect(Array.from(bytes, byte => new Uint8Array([byte])));
    expect(error).toBeUndefined();
    expect(chunks).toContainEqual({ kind: "text", text: "caffè ☕" });
    expect(chunks.at(-1)).toMatchObject({ kind: "finish", reason: "stop" });
  });

  it.each([
    [frame({ error: { message: "inference failed" } }) + "data: [DONE]\n", "server_error"],
    ["data: {broken}\n\n", "protocol_error"],
    ["data: null\n\n", "protocol_error"],
    [choice({}, "content_filter"), "server_error"]
  ])("reports erroneous frames instead of silent completion", async (payload, cause) => {
    const { error, chunks } = await collect(payload);
    expect(error).toBeInstanceOf(StreamFailure);
    expect(error?.diagnostics.cause).toBe(cause);
    expect(chunks.some(chunk => chunk.kind === "finish")).toBe(false);
  });

  it.each([undefined, "length"])("never releases native calls after unsuccessful completion (%s)", async reason => {
    const { chunks, error } = await collect(choice({ tool_calls: [{ index: 0, function: { name: "create_file", arguments: '{"path":"a.txt","content":"partial"}' } }] }) + (reason ? choice({}, reason) : ""));
    expect(error).toBeInstanceOf(reason ? GenerationLengthError : StreamFailure);
    expect(chunks.some(chunk => chunk.kind === "toolCall")).toBe(false);
  });

  it("publishes completion evidence before executable native calls", async () => {
    const { chunks, error } = await collect(choice({ tool_calls: [{ index: 0, id: "plan", function: { name: "submit_plan", arguments: '{"markdown":"Plan"}' } }] }, "tool_calls"));
    expect(error).toBeUndefined();
    expect(chunks.map(chunk => chunk.kind)).toEqual(["finish", "toolCall"]);
  });

  it("distinguishes a socket read failure from user cancellation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("socket closed")); } }))));
    const drain = async (signal: AbortSignal) => { for await (const chunk of streamChat("http://127.0.0.1:8080", { messages: [] }, signal)) void chunk; };
    await expect(drain(new AbortController().signal)).rejects.toMatchObject({ diagnostics: { cause: "transport" } });
    const controller = new AbortController();
    controller.abort();
    await expect(drain(controller.signal)).rejects.toThrow("socket closed");
  });
});
