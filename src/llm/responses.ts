import { createHash } from "node:crypto";
import type { ChatCompletionRequest, LlmStreamChunk } from "./client.js";
import { redactServerError, serverRoot, type ServerConnection } from "./connection.js";
import { GenerationLengthError, StreamFailure, serverErrorMessage, type CompletionDiagnostics } from "./completion.js";
import { replayResponseHistory, responseItem, type ResponseOutputItem } from "./responseHistory.js";
import { progressSignature, writeProgressFromJsonToolBody } from "./toolProgress.js";

export function responseSource(c: ServerConnection): string {
  return JSON.stringify([serverRoot(c.endpoint), c.model ?? "local", c.backend ?? c.serverType]);
}

/** Translate the shared request, keeping backend policy separate from wire format. */
export function serializeResponses(req: ChatCompletionRequest, c: ServerConnection, chat: Record<string, unknown>): Record<string, unknown> {
  if (c.backend === "vllm" && chat.thinking_token_budget !== undefined) {
    throw new StreamFailure("Finite reasoning budgets are unavailable with vLLM Responses. Leave Reasoning budget unlimited or select Chat Completions in Protocol.", { cause: "protocol_error" });
  }
  const input: unknown[] = [];
  for (const [index, message] of req.messages.entries()) {
    const native = message.role === "assistant" ? replayResponseHistory(message, responseSource(c)) : undefined;
    if (native) { input.push(...native); continue; }
    if (message.role === "tool") {
      if (!message.tool_call_id) throw new StreamFailure("A tool result is missing its call ID.", { cause: "protocol_error" });
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: typeof message.content === "string" ? message.content : JSON.stringify(message.content) });
      continue;
    }
    if (message.role === "assistant" && message.reasoning_content) {
      input.push({ type: "reasoning", id: legacyItemId("rs", index, message.reasoning_content), summary: [], content: [{ type: "reasoning_text", text: message.reasoning_content }] });
    }
    const parts = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    if (message.role !== "assistant" || parts.some(part => part.type !== "text" || part.text)) {
      input.push({ type: "message", role: message.role,
        ...(message.role === "assistant" ? { status: "completed", id: legacyItemId("msg", index, JSON.stringify(message.content)) } : {}),
        content: parts.map(part => part.type === "image_url"
          ? { type: "input_image", image_url: part.image_url.url }
          : { type: message.role === "assistant" ? "output_text" : "input_text", text: part.text, ...(message.role === "assistant" ? { annotations: [] } : {}) }) });
    }
    for (const call of message.tool_calls ?? []) input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
  }
  const local = c.backend !== "vllm";
  return {
    model: chat.model, input, stream: true, store: false,
    temperature: chat.temperature, top_p: chat.top_p,
    max_output_tokens: chat.max_completion_tokens ?? chat.max_tokens,
    reasoning: chat.reasoning_effort !== undefined ? { effort: chat.reasoning_effort } : undefined,
    tools: req.tools?.map(tool => ({ type: "function", ...tool.function, strict: false })),
    tool_choice: chat.tool_choice,
    parallel_tool_calls: req.tools?.length ? req.parallel_tool_calls ?? false : undefined,
    ...(local ? { extra_params: { top_k: chat.top_k, thinking_budget_tokens: chat.thinking_budget_tokens,
      chat_template_kwargs: chat.chat_template_kwargs, return_progress: chat.return_progress } }
      : { top_k: chat.top_k, chat_template_kwargs: chat.chat_template_kwargs })
  };
}

function legacyItemId(prefix: string, index: number, text: string): string {
  return `${prefix}_local_${createHash("sha256").update(`${index}:${text}`).digest("hex").slice(0, 24)}`;
}

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** SSE framing is independent of JSON events, including split UTF-8 and multiline data. */
async function* events(res: Response, signal: AbortSignal): AsyncGenerator<JsonObject> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const parse = (): JsonObject | undefined => {
    const text = data.join("\n"); data = [];
    if (!text || text === "[DONE]") return;
    try {
      const value = object(JSON.parse(text));
      if (value) return value;
    } catch { /* Produce the same bounded protocol error for malformed frames. */ }
    throw new StreamFailure("The server sent malformed Responses streaming data.", { cause: "protocol_error", completionEvidence: "none" });
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done && buffer && !buffer.endsWith("\n")) buffer += "\n";
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1);
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        else if (!line) { const event = parse(); if (event) yield event; }
      }
      if (done) { const event = parse(); if (event) yield event; break; }
    }
  } finally { await reader.cancel().catch(() => undefined); }
}

export async function* streamResponses(res: Response, c: ServerConnection, signal: AbortSignal): AsyncGenerator<LlmStreamChunk> {
  const diagnostics: CompletionDiagnostics = { completionEvidence: "none" };
  const items = new Map<number, JsonObject>();
  const emitted = new Map<string, string>();
  const signatures = new Map<number, string>();
  const fail = (text: string): never => { throw new StreamFailure(text, { ...diagnostics, cause: "protocol_error" }); };
  const indexOf = (event: JsonObject): number => {
    if (typeof event.output_index === "number" && Number.isSafeInteger(event.output_index) && event.output_index >= 0) return event.output_index;
    if (typeof event.item_id === "string") for (const [index, item] of items) if (item.id === event.item_id) return index;
    return fail("A Responses event is missing its output item index.");
  };
  function* textPart(index: number, part: number, channel: string, text: string, snapshot: boolean): Generator<LlmStreamChunk> {
    const key = `${index}:${channel}:${part}`;
    const previous = emitted.get(key) ?? "";
    if (snapshot && !text.startsWith(previous)) fail("The server changed an already streamed Responses item.");
    const delta = snapshot ? text.slice(previous.length) : text;
    emitted.set(key, snapshot ? text : previous + text);
    if (delta) yield { kind: channel === "text" ? "text" : "thought", text: delta };
  }
  function* progress(index: number, item: JsonObject): Generator<LlmStreamChunk> {
    if (typeof item.arguments !== "string" || typeof item.name !== "string" || typeof item.call_id !== "string") return;
    const value = writeProgressFromJsonToolBody(item.arguments, item.name);
    if (!value) return;
    const signature = progressSignature(value);
    if (signatures.get(index) === signature) return;
    signatures.set(index, signature);
    yield { kind: "toolCallProgress", ...value, id: item.call_id };
  }
  function* snapshot(index: number, item: ResponseOutputItem): Generator<LlmStreamChunk> {
    const previous = items.get(index);
    if (previous && (previous.type !== item.type || (previous.id && previous.id !== item.id)
      || (item.type === "function_call" && ((previous.call_id && previous.call_id !== item.call_id) || (previous.name && previous.name !== item.name))))) {
      fail("The server changed a streamed Responses item identity.");
    }
    if (item.type === "message") {
      for (const [part, value] of item.content.entries()) yield* textPart(index, part, "text", value.type === "output_text" ? value.text : value.refusal, true);
    } else if (item.type === "reasoning") {
      for (const [part, value] of (item.content ?? []).entries()) yield* textPart(index, part, "reasoning", value.text, true);
      for (const [part, value] of item.summary.entries()) yield* textPart(index, part, "summary", value.text, true);
    } else {
      if (typeof previous?.arguments === "string" && !item.arguments.startsWith(previous.arguments)) fail("The server changed streamed function arguments.");
      yield* progress(index, item);
    }
    items.set(index, item);
  }
  function* partialOutput(value: unknown): Generator<LlmStreamChunk> {
    if (!Array.isArray(value)) return;
    for (const [index, raw] of value.entries()) {
      const item = responseItem({ ...object(raw), status: undefined });
      // Partial function data is progress only and must never become executable.
      if (item && item.type !== "function_call") yield* snapshot(index, item);
    }
  }
  try {
    for await (const event of events(res, signal)) {
      signal.throwIfAborted();
      const type = event.type;
      const response = object(event.response);
      const usage = object(response?.usage);
      const inputTokens = tokenCount(usage?.input_tokens);
      const outputTokens = tokenCount(usage?.output_tokens);
      if (inputTokens !== undefined) {
        diagnostics.promptTokens = inputTokens; diagnostics.completionTokens = outputTokens;
        if (type !== "response.completed" || response?.status !== "completed") yield { kind: "usage", promptTokens: inputTokens, completionTokens: outputTokens };
      }
      if (type === "error" || event.error !== undefined || type === "response.failed" || response?.status === "failed") {
        yield* partialOutput(response?.output);
        const error = object(event.error) ?? object(response?.error) ?? event;
        const message = typeof error.message === "string" ? redactServerError(error.message, c) : undefined;
        throw new StreamFailure(`Generation failed: ${serverErrorMessage(message)}`, { ...diagnostics, cause: "server_error" });
      }
      if (type === "response.incomplete" || response?.status === "incomplete") {
        yield* partialOutput(response?.output);
        diagnostics.completionEvidence = "response_incomplete";
        const reason = object(response?.incomplete_details)?.reason;
        diagnostics.finishReason = typeof reason === "string" ? serverErrorMessage(reason) : "incomplete";
        if (reason === "max_output_tokens" || reason === "length") throw new GenerationLengthError(diagnostics);
        throw new StreamFailure(`The server returned an incomplete response (${diagnostics.finishReason}).`, { ...diagnostics, cause: "server_error" });
      }
      if (type === "response.cancelled" || response?.status === "cancelled") {
        throw new StreamFailure("The server cancelled the response before completion.", { ...diagnostics, cause: "server_error" });
      }
      if (type === "response.completed") {
        if (response?.status !== "completed" || !Array.isArray(response.output)) fail("The server did not confirm a completed Responses result.");
        const output = (response!.output as unknown[]).map(responseItem);
        if (output.some(item => !item)) fail("The server returned an invalid or unsupported Responses output item.");
        const complete = output as ResponseOutputItem[];
        for (const key of emitted.keys()) {
          const [index, channel, part] = key.split(":");
          const item = complete[Number(index)];
          const text = channel === "text" && item?.type === "message" ? item.content[Number(part)]
            : item?.type === "reasoning" ? (channel === "summary" ? item.summary : item.content)?.[Number(part)] : undefined;
          if (!text) fail("The final response omitted streamed text or reasoning.");
        }
        const callIds = new Set<string>();
        for (const item of complete) if (item.type === "function_call") {
          if (callIds.has(item.call_id)) fail("The server returned duplicate function call IDs.");
          callIds.add(item.call_id);
          try { if (!object(JSON.parse(item.arguments))) fail("Invalid function arguments."); }
          catch { fail("The server returned invalid function arguments."); }
        }
        for (const [index, item] of complete.entries()) yield* snapshot(index, item);
        if ([...items.keys()].some(index => index >= complete.length)) fail("The final response omitted a streamed output item.");
        diagnostics.completionEvidence = "response_completed";
        diagnostics.finishReason = callIds.size ? "tool_calls" : "stop";
        signal.throwIfAborted();
        if (inputTokens !== undefined) yield { kind: "usage", promptTokens: inputTokens, completionTokens: outputTokens };
        signal.throwIfAborted();
        yield { kind: "finish", reason: diagnostics.finishReason, diagnostics: { ...diagnostics }, responseHistory: { source: responseSource(c), output: complete } };
        for (const item of complete) if (item.type === "function_call") {
          signal.throwIfAborted();
          yield { kind: "toolCall", name: item.name, argsJson: item.arguments, id: item.call_id };
        }
        return;
      }
      if (type === "response.output_item.added") {
        const index = indexOf(event), item = object(event.item);
        if (!item) fail("The server returned an invalid Responses item.");
        if (items.has(index)) fail("The server repeated a Responses output item.");
        items.set(index, item!);
      } else if (type === "response.output_item.done") {
        const raw = object(event.item);
        // Item-level truncation is not a response-level failure reason. Wait for
        // the terminal response to distinguish output limits from other failures.
        const item = responseItem(raw?.status === "incomplete" ? { ...raw, status: undefined } : raw);
        if (!item) fail("The server returned an invalid completed Responses item.");
        yield* snapshot(indexOf(event), item!);
      } else if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
        const index = indexOf(event), item = items.get(index);
        if (!item || item.type !== "function_call") fail("Function arguments arrived without a function call item.");
        const previous = typeof item!.arguments === "string" ? item!.arguments : "";
        const value = type.endsWith(".done") ? event.arguments : event.delta;
        if (typeof value !== "string") fail("The server returned invalid function argument data.");
        if (type.endsWith(".done") && !(value as string).startsWith(previous as string)) fail("The server changed streamed function arguments.");
        item!.arguments = type.endsWith(".done") ? value : previous + (value as string);
        yield* progress(index, item!);
      } else if (typeof type === "string" && /^response\.(output_text|refusal|reasoning_text|reasoning_summary_text)\.(delta|done)$/.test(type)) {
        const index = indexOf(event);
        const channel = type.includes("summary") ? "summary" : type.includes("reasoning") ? "reasoning" : "text";
        const part = tokenCount(channel === "summary" ? event.summary_index : event.content_index) ?? 0;
        const value = type.endsWith(".done") ? event.text ?? event.refusal : event.delta;
        if (typeof value !== "string") fail("The server returned invalid Responses text data.");
        yield* textPart(index, part, channel, value as string, type.endsWith(".done"));
      }
    }
    throw new StreamFailure("The server stream ended before confirming completion. The response is incomplete.", { ...diagnostics, cause: "unexpected_eof" });
  } catch (error) {
    if (signal.aborted || error instanceof StreamFailure) throw error;
    throw new StreamFailure("The connection to the model server was interrupted. The response may be incomplete.", { ...diagnostics, cause: "transport" });
  }
}
