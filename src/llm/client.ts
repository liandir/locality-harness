import { GenerationLengthError, StreamFailure, serverErrorMessage, type CompletionDiagnostics } from "./completion.js";
export { GenerationLengthError, StreamFailure } from "./completion.js";
import { connectionHeaders, redactServerError, serverUrl } from "./connection.js";
import { countServerPrompt, isUnsupportedImage, resolvedConnection, serializeRequest, serverFailure, setImageSupport, VisionUnsupportedError } from "./server.js";
export { fetchServerMetadata, fetchServerModels, fetchServerContextSize, tokenize, VisionUnsupportedError } from "./server.js";
export type { ServerMetadata, ServerModel } from "./serverTypes.js";
import { beginForeground } from "./activity.js";
import { safeFetch, NetworkPolicyError } from "../network/safeFetch.js";
import { progressSignature, writeProgressFromJsonToolBody } from "./toolProgress.js";
import type { OpenAiTool } from "../tools/toolDefinitions.js";

export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
export type LlmContent = string | LlmContentPart[];

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: LlmContent;
  reasoning_content?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: LlmToolCall[];
}

export interface ChatCompletionRequest {
  /** OpenAI-compatible model id; required for llama.cpp router mode. */
  model?: string;
  /** Internal scheduling flag, never sent to the server. */
  background?: boolean;
  /** Auxiliary tasks disable optional reasoning on servers without a parser. */
  purpose?: "auxiliary";
  messages: LlmMessage[];
  temperature?: number;
  top_k?: number;
  top_p?: number;
  max_tokens?: number;
  /** llama.cpp extension: cap reasoning without disabling it entirely. */
  thinking_budget_tokens?: number;
  /** Model/template-specific effort value configured by the user. */
  reasoning_effort?: string;
  /** Per-request Jinja arguments; used as a compatibility fallback to disable thinking. */
  chat_template_kwargs?: Record<string, unknown>;
  tools?: OpenAiTool[];
  tool_choice?: "auto" | "required" | "none";
  parallel_tool_calls?: boolean;
  /** llama.cpp extension: report prompt processing before generation starts. */
  return_progress?: boolean;
  /** Called once llama.cpp has accepted this generation request. Not sent over the wire. */
  onResponseAccepted?: () => void;
}

export class NativeToolsUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeToolsUnsupportedError";
  }
}

export class MalformedNativeToolCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedNativeToolCallError";
  }
}

export type LlmStreamChunk =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "finish"; reason?: string; diagnostics?: CompletionDiagnostics }
  | { kind: "usage"; promptTokens: number; completionTokens?: number }
  | { kind: "promptProgress"; processedTokens: number; totalTokens: number }
  | { kind: "toolCallProgress"; name: string; path?: string; content?: string; contentBytes: number; contentLines: number; startLine?: number; endLine?: number; line?: number; id?: string }
  | { kind: "toolCall"; name: string; argsJson: string; id?: string };

interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface StreamChoice {
  delta?: {
    content?: unknown;
    reasoning_content?: unknown;
    reasoning?: unknown;
    thought?: unknown;
    tool_calls?: ToolCallDelta[];
  };
  text?: unknown;
  reasoning_content?: unknown;
  finish_reason?: unknown;
}

interface StreamPayload {
  error?: { message?: unknown } | string;
  choices?: StreamChoice[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  prompt_progress?: { processed?: unknown; total?: unknown };
}

/**
 * Streams text and thinking deltas from a llama.cpp /v1/chat/completions endpoint.
 * llama.cpp's OpenAI-compatible server returns SSE with lines `data: {json}`
 * where json.choices[0].delta.content is the next visible text chunk. Some
 * backends expose thinking as reasoning_content/reasoning/thought deltas; those
 * are forwarded separately so the UI can render them without showing raw tokens.
 *
 * Templates run with `--jinja` may instead return structured tool calls as
 * `delta.tool_calls` fragments. Those are accumulated by index across the stream
 * and emitted as `toolCall` chunks once complete, so they aren't silently lost.
 */
export async function* streamChat(
  endpoint: string,
  req: ChatCompletionRequest,
  signal: AbortSignal
): AsyncGenerator<LlmStreamChunk, void, void> {
  const end = req.background ? () => undefined : beginForeground();
  try {
    yield* streamChatRequest(endpoint, req, signal);
  } catch (error) {
    if (signal.aborted || error instanceof StreamFailure || error instanceof NetworkPolicyError || error instanceof NativeToolsUnsupportedError
      || error instanceof MalformedNativeToolCallError || error instanceof VisionUnsupportedError) throw error;
    throw new StreamFailure("The connection to the model server failed. Check the server and continue when it is available.", { cause: "transport", completionEvidence: "none" });
  } finally {
    end();
  }
}

async function* streamChatRequest(
  endpoint: string, req: ChatCompletionRequest, signal: AbortSignal
): AsyncGenerator<LlmStreamChunk, void, void> {
  const connection = await resolvedConnection(endpoint, req.model, signal);
  await countServerPrompt(endpoint, req, signal);
  const res = await safeFetch(connection.endpoint, serverUrl(connection.endpoint, "v1/chat/completions"), {
    method: "POST",
    headers: { ...connectionHeaders(connection), "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(serializeRequest(req, connection)), signal
  });
  if (!res.ok || !res.body) {
    const text = redactServerError(await res.clone().text().catch(() => ""), connection);
    if (req.tools?.length && nativeToolsUnsupported(res.status, text)) {
      throw new NativeToolsUnsupportedError(text.slice(0, 500) || `HTTP ${res.status}`);
    }
    if (req.tools?.length && malformedNativeToolCall(res.status, text)) {
      throw new MalformedNativeToolCallError(text.slice(0, 500) || `HTTP ${res.status}`);
    }
    if (isUnsupportedImage(res.status, text)) {
      if (connection.backend === "vllm") setImageSupport(connection, "unsupported");
      throw new VisionUnsupportedError(text.slice(0, 500) || `HTTP ${res.status}`);
    }
    throw await serverFailure(res, connection, "The model server");
  }
  req.onResponseAccepted?.();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const generatedCallPrefix = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // index -> accumulated structured tool call
  const toolAcc = new Map<number, { name: string; args: string; id?: string; lastProgressSignature?: string }>();
  const collectToolCalls = (delta: { tool_calls?: ToolCallDelta[] }): LlmStreamChunk[] => {
    const out: LlmStreamChunk[] = [];
    const calls = delta?.tool_calls;
    if (!Array.isArray(calls)) return out;
    for (const c of calls) {
      const idx = typeof c.index === "number" ? c.index : 0;
      const cur = toolAcc.get(idx) ?? { name: "", args: "" };
      if (c.id) cur.id = c.id;
      if (c.function?.name) cur.name = c.function.name;
      if (typeof c.function?.arguments === "string") cur.args += c.function.arguments;
      toolAcc.set(idx, cur);
      const progress = writeProgressFromJsonToolBody(cur.args, cur.name);
      if (!progress) continue;
      const signature = progressSignature(progress);
      if (signature === cur.lastProgressSignature) continue;
      cur.lastProgressSignature = signature;
      out.push({ kind: "toolCallProgress", ...progress, id: cur.id ?? `${generatedCallPrefix}_${idx}` });
    }
    return out;
  };
  const flushToolCalls = (): LlmStreamChunk[] => {
    const out: LlmStreamChunk[] = [];
    for (const [idx, v] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
      if (v.name) out.push({ kind: "toolCall", name: v.name, argsJson: v.args.trim() || "{}", id: v.id ?? `${generatedCallPrefix}_${idx}` });
    }
    toolAcc.clear();
    return out;
  };

  let finished = false;
  let generationStarted = false;
  const diagnostics: CompletionDiagnostics = { completionEvidence: "none" };
  function* processLine(raw: string): Generator<LlmStreamChunk> {
    const line = raw.trim();
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      finished = true;
      if (diagnostics.completionEvidence === "none") diagnostics.completionEvidence = "done";
      return;
    }
    let obj: StreamPayload;
    try {
      obj = JSON.parse(payload) as StreamPayload;
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error();
    } catch {
      throw new StreamFailure("The server sent malformed streaming data. The response may be incomplete.", { ...diagnostics, cause: "protocol_error" });
    }
    if (obj.error !== undefined) {
      const message = typeof obj.error === "string" ? obj.error : obj.error?.message;
      throw new StreamFailure(`Generation failed: ${serverErrorMessage(typeof message === "string" ? redactServerError(message, connection) : message)}`, { ...diagnostics, cause: "server_error" });
    }
    const total = obj.prompt_progress?.total;
    const processed = obj.prompt_progress?.processed;
    if (!generationStarted && typeof total === "number" && Number.isSafeInteger(total) && total > 0
      && typeof processed === "number" && Number.isSafeInteger(processed) && processed >= 0 && processed <= total) {
      yield { kind: "promptProgress", processedTokens: processed, totalTokens: total };
    }
    const promptTokens = obj.usage?.prompt_tokens;
    const completionTokens = obj.usage?.completion_tokens;
    if (typeof completionTokens === "number" && Number.isFinite(completionTokens) && completionTokens >= 0) diagnostics.completionTokens = completionTokens;
    if (typeof promptTokens === "number" && Number.isFinite(promptTokens) && promptTokens >= 0) {
      diagnostics.promptTokens = promptTokens;
      yield { kind: "usage", promptTokens, completionTokens: diagnostics.completionTokens };
    }
    const choice = obj.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    const thought = delta.reasoning_content ?? delta.reasoning ?? delta.thought ?? choice.reasoning_content ?? "";
    const text = delta.content ?? choice.text ?? "";
    generationStarted ||= !!(thought || text || delta.tool_calls?.length || choice.finish_reason);
    yield* collectToolCalls(delta);
    if (thought) yield { kind: "thought", text: String(thought) };
    if (text) yield { kind: "text", text: String(text) };
    const reason = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;
    if (!reason) return;
    diagnostics.finishReason = serverErrorMessage(reason);
    diagnostics.completionEvidence = "finish_reason";
    if (reason === "length") throw new GenerationLengthError(diagnostics);
    if (reason !== "stop" && reason !== "tool_calls") {
      throw new StreamFailure(`The server ended generation with finish_reason="${serverErrorMessage(reason)}".`, { ...diagnostics, cause: "server_error" });
    }
  }
  try {
    while (!finished) {
      const { value, done } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl: number;
      while (!finished && (nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        yield* processLine(line);
      }
      if (done) {
        if (!finished && buf) yield* processLine(buf);
        break;
      }
    }
    if (diagnostics.completionEvidence === "none") {
      throw new StreamFailure("The server stream ended before confirming completion. The response is incomplete.", { ...diagnostics, cause: "unexpected_eof" });
    }
    // Publish terminal evidence before any executable calls. Progress is never executable.
    yield { kind: "finish", reason: diagnostics.finishReason, diagnostics: { ...diagnostics } };
    yield* flushToolCalls();
  } catch (error) {
    if (signal.aborted || error instanceof StreamFailure) throw error;
    throw new StreamFailure("The connection to the model server was interrupted. The response may be incomplete.", { ...diagnostics, cause: "transport" });
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function nativeToolsUnsupported(status: number, body: string): boolean {
  if (status < 400) return false;
  const text = body.toLowerCase();
  if (text.includes("tools param requires --jinja") || text.includes("tool_choice param requires --jinja")) {
    return true;
  }
  return status < 500 && text.includes("tool") && text.includes("template") && text.includes("support");
}

function malformedNativeToolCall(status: number, body: string): boolean {
  if (status < 400) return false;
  const text = body.toLowerCase();
  return text.includes("tool call arguments")
    && (text.includes("failed to parse") || text.includes("json.exception.parse_error"));
}

/** Non-streaming convenience: collect the full text. */
export async function complete(
  endpoint: string,
  req: ChatCompletionRequest,
  signal: AbortSignal,
  options?: { acceptPartialOnLength?: boolean }
): Promise<string> {
  let out = "";
  try {
    for await (const chunk of streamChat(endpoint, req, signal)) {
      if (chunk.kind === "text") out += chunk.text;
    }
  } catch (error) {
    // Tiny auxiliary completions intentionally use a hard output cap. Their
    // visible text remains useful even when the model omits an EOS token.
    if (!(options?.acceptPartialOnLength && error instanceof GenerationLengthError)) throw error;
  }
  return out;
}
