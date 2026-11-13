import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete, type ChatCompletionRequest } from "../src/llm/client.js";
import { clearServerCaches, serializeRequest } from "../src/llm/server.js";
import { withServerConnection } from "../src/llm/connection.js";
import { measureRequestPrompt } from "../src/chat/contextTracker.js";

const endpoint = "http://127.0.0.1:8080";
const request: ChatCompletionRequest = { model: "policy-model", messages: [{ role: "user", content: "Summarize" }],
  generation: { task: "compaction", maxOutputTokens: 2048, reasoning: { mode: "prefer-off" } } };
const response = (reason = "stop", content = "Summary") => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`);

beforeEach(() => clearServerCaches());
afterEach(() => vi.unstubAllGlobals());

describe.each(["llama.cpp", "vllm"] as const)("%s generation policy", backend => {
  const connection = { endpoint, model: request.model, serverType: backend, backend };
  const outputField = backend === "vllm" ? "max_completion_tokens" : "max_tokens";

  it("translates the same compaction intent and preserves normal reasoning choices", () => {
    const body = serializeRequest(request, connection);
    expect(body[outputField]).toBe(2048);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body[backend === "vllm" ? "reasoning_effort" : "thinking_budget_tokens"]).toBe(backend === "vllm" ? "none" : 0);
    const chat = serializeRequest({ ...request, generation: { task: "chat", reasoning: { mode: "default", effort: "high", budgetTokens: 8000 } } }, connection);
    expect(chat.reasoning_effort).toBe("high");
    expect(chat[backend === "vllm" ? "thinking_token_budget" : "thinking_budget_tokens"]).toBe(8000);
    expect(chat.chat_template_kwargs).toBeUndefined();
  });

  function serve(generation: (body: Record<string, unknown>) => Response) {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body ?? "{}"));
      if (url.endsWith("tokenize")) return Response.json({ count: 12, max_model_len: 32768, tokens: Array.from({ length: 12 }, (_, i) => i) });
      return generation(body);
    }));
  }

  it("falls back once for a model that rejects reasoning-off, remembering its capability", async () => {
    const bodies: Record<string, unknown>[] = [];
    serve(body => {
      bodies.push(body);
      return bodies.length === 1 ? new Response("enable_thinking=false is not supported", { status: 400 }) : response();
    });
    await withServerConnection(connection, async () => {
      expect(await complete(endpoint, request, new AbortController().signal)).toBe("Summary");
      expect(await complete(endpoint, request, new AbortController().signal)).toBe("Summary");
    });
    expect(bodies).toHaveLength(3);
    expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(bodies[1].chat_template_kwargs).toBeUndefined();
    expect(bodies[2].chat_template_kwargs).toBeUndefined();
    expect(bodies.every(body => body[outputField] === 2048)).toBe(true);
  });

  it("keeps length exhaustion distinct and never accepts partial summary text", async () => {
    let calls = 0;
    serve(() => { calls++; return response("length", "Partial summary"); });
    await expect(withServerConnection(connection, () => complete(endpoint, request, new AbortController().signal))).rejects.toThrow('finish_reason="length"');
    expect(calls).toBe(1);
  });

  it("does not retry unrelated errors or override explicitly disabled chat reasoning", async () => {
    let calls = 0;
    serve(() => { calls++; return new Response("enable_thinking=false is not supported", { status: 400 }); });
    await expect(withServerConnection(connection, () => complete(endpoint, { ...request,
      generation: { task: "chat", reasoning: { mode: "off" } }
    }, new AbortController().signal))).rejects.toThrow("HTTP 400");
    expect(calls).toBe(1);
    calls = 0;
    serve(() => { calls++; return new Response("unavailable", { status: 503 }); });
    await expect(withServerConnection(connection, () => complete(endpoint, request, new AbortController().signal))).rejects.toThrow("HTTP 503");
    expect(calls).toBe(1);
  });

  it("reports the accuracy of full-prompt measurement", async () => {
    serve(() => response());
    const result = await withServerConnection(connection, () => measureRequestPrompt(endpoint, request, 4));
    expect(result.accuracy).toBe(backend === "vllm" ? "exact" : "estimated");
    expect(result.tokens).toBeGreaterThan(0);
  });
});

it("handles a model rejecting reasoning-off during vLLM prompt measurement", async () => {
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.chat_template_kwargs?.enable_thinking === false) {
      attempts++;
      return new Response("Invalid reasoning_effort: none", { status: 400 });
    }
    return Response.json({ count: 10, tokens: Array.from({ length: 10 }, (_, i) => i), max_model_len: 8192 });
  }));
  const measured = await withServerConnection({ endpoint, model: request.model, serverType: "vllm" }, () => measureRequestPrompt(endpoint, request, 4));
  expect(measured).toEqual({ tokens: 10, accuracy: "exact" });
  expect(attempts).toBe(1);
});
