import { safeFetch } from "../network/safeFetch.js";
import { StreamFailure, serverErrorMessage } from "./completion.js";
import { connectionFor, connectionCacheKey, connectionHeaders, redactServerError, serverUrl, type ServerConnection } from "./connection.js";
import type { ServerMetadata, ServerModel, ImageSupport } from "./serverTypes.js";
import type { ChatCompletionRequest } from "./client.js";

export type { ServerMetadata, ServerModel } from "./serverTypes.js";
const metadataCache = new Map<string, { at: number; value: ServerMetadata }>();
const modelsCache = new Map<string, { at: number; value: ServerModel[] }>();
const imageCapabilities = new Map<string, ImageSupport>();
const TTL = 60_000;
const capabilityListeners = new Set<(connection: ServerConnection) => void>();
export function onServerCapabilitiesChange(listener: (connection: ServerConnection) => void): { dispose(): void } {
  capabilityListeners.add(listener);
  return { dispose: () => { capabilityListeners.delete(listener); } };
}

function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function cached<T>(map: Map<string, { at: number; value: T }>, key: string, force?: boolean): T | undefined {
  const hit = map.get(key);
  if (!force && hit && Date.now() - hit.at < TTL) return hit.value;
  map.delete(key);
  return undefined;
}
function remember<T>(map: Map<string, { at: number; value: T }>, key: string, value: T): T {
  if (map.size > 128) map.clear();
  map.set(key, { at: Date.now(), value });
  return value;
}
export function clearServerCaches(): void { metadataCache.clear(); modelsCache.clear(); imageCapabilities.clear(); }

async function request(c: ServerConnection, route: string, signal?: AbortSignal, body?: unknown): Promise<Response> {
  return safeFetch(c.endpoint, serverUrl(c.endpoint, route), {
    method: body === undefined ? "GET" : "POST",
    headers: { ...connectionHeaders(c), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
  });
}
async function readJson<T>(res: Response): Promise<T> {
  try { return await res.json() as T; }
  catch { throw new StreamFailure("The model server returned malformed JSON.", { cause: "protocol_error" }); }
}
export async function serverFailure(res: Response, c: ServerConnection, operation: string): Promise<StreamFailure> {
  const text = redactServerError(await res.text().catch(() => ""), c);
  const hint = res.status === 401 || res.status === 403 ? " Check the server API key in Settings."
    : text.includes("thinking_token_budget") && /reasoning.config|reasoning.parser/.test(text)
      ? " Configure vLLM --reasoning-parser/--reasoning-config, or leave the reasoning budget unlimited."
      : /enable-auto-tool-choice|tool.call.parser/i.test(text) ? " Enable vLLM automatic tool choice and the model's tool parser." : "";
  return new StreamFailure(`${operation} returned HTTP ${res.status}.${hint} ${serverErrorMessage(text)}`, { cause: "server_error", httpStatus: res.status });
}

export async function fetchServerModels(endpoint: string, force = false, signal?: AbortSignal): Promise<ServerModel[]> {
  const c = await connectionFor(endpoint);
  const key = connectionCacheKey(c);
  const hit = cached(modelsCache, key, force);
  if (hit) return hit;
  const res = await request(c, "v1/models", signal);
  if (!res.ok) throw await serverFailure(res, c, "Model discovery");
  const obj = await readJson<{ data?: { id?: unknown; max_model_len?: unknown; owned_by?: unknown }[] }>(res);
  const models: ServerModel[] = [];
  for (const item of Array.isArray(obj?.data) ? obj.data : []) {
    if (typeof item?.id !== "string" || !item.id.trim()) continue;
    const id = item.id.trim();
    if (models.some(m => m.id === id)) continue;
    models.push({ id, ...(positive(item.max_model_len) ? { contextSize: item.max_model_len } : {}),
      ...(typeof item.owned_by === "string" ? { owner: item.owned_by } : {}) });
  }
  if (!models.length) throw new Error("The server's /v1/models did not report any model ids.");
  return remember(modelsCache, key, models);
}

export async function fetchServerMetadata(endpoint: string, options: { model?: string; force?: boolean; signal?: AbortSignal } = {}): Promise<ServerMetadata> {
  options.signal?.throwIfAborted();
  const c = await connectionFor(endpoint, options.model);
  const key = connectionCacheKey(c);
  const hit = cached(metadataCache, key, options.force);
  if (hit) { c.backend = hit.backend ?? "llama.cpp"; return hit; }
  if (c.serverType !== "vllm") {
    const route = `props${c.model ? `?model=${encodeURIComponent(c.model)}` : ""}`;
    const res = await request(c, route, options.signal);
    if (res.ok) {
      const obj = await readJson<{ modalities?: { vision?: unknown }; model_alias?: unknown; model_path?: unknown; default_generation_settings?: { n_ctx?: unknown; model?: unknown } }>(res);
      const size = obj?.default_generation_settings?.n_ctx;
      const alias = obj?.model_alias ?? obj?.default_generation_settings?.model ?? (typeof obj?.model_path === "string" ? obj.model_path.replaceAll("\\", "/").split("/").pop() : undefined);
      if (!positive(size)) throw new Error("llama.cpp /props did not report a valid context length.");
      if (typeof alias !== "string" || !alias.trim()) throw new Error("llama.cpp /props did not report a model alias or model path.");
      c.backend = "llama.cpp";
      return remember(metadataCache, key, { modelAlias: alias.trim(), contextSize: size, supportsVision: obj.modalities?.vision === true, backend: "llama.cpp", imageSupport: obj.modalities?.vision === true ? "supported" : "unsupported" });
    }
    if (c.serverType === "llama.cpp" || (res.status !== 404 && res.status !== 405)) throw await serverFailure(res, c, "llama.cpp /props");
  }
  const models = await fetchServerModels(c.endpoint, options.force, options.signal);
  const model = models.find(m => m.id === c.model) ?? (!c.model ? models[0] : undefined);
  if (!model) throw new Error("The selected model is no longer available. Choose a model in Settings.");
  const tokenized = await vllmTokenize(c, { model: model.id, prompt: "", add_special_tokens: false }, options.signal);
  if (c.serverType === "auto" && model.owner !== "vllm") {
    throw new Error("Could not identify the model server. Select llama.cpp or vLLM in Settings.");
  }
  c.backend = "vllm";
  const imageSupport = imageCapabilities.get(key) ?? "unknown";
  return remember(metadataCache, key, { modelAlias: model.id, contextSize: model.contextSize ?? tokenized.max_model_len,
    supportsVision: imageSupport !== "unsupported", backend: "vllm", imageSupport });
}

export async function resolvedConnection(endpoint: string, model?: string, signal?: AbortSignal): Promise<ServerConnection> {
  signal?.throwIfAborted();
  const c = await connectionFor(endpoint, model);
  if (!c.backend) {
    if (c.serverType !== "auto") c.backend = c.serverType;
    else c.backend = (await fetchServerMetadata(endpoint, { model, signal })).backend;
  }
  return c;
}

export async function fetchServerContextSize(endpoint: string, model?: string, options: { signal?: AbortSignal; strict?: boolean } = {}): Promise<number | undefined> {
  try { return (await fetchServerMetadata(endpoint, { model, signal: options.signal })).contextSize; }
  catch (error) { options.signal?.throwIfAborted(); if (options.strict) throw error; return undefined; }
}

export function isUnsupportedImage(status: number, text: string): boolean {
  return status >= 400 && status < 500 && status !== 401 && status !== 403 &&
    /image input is not supported|does not support (?:image|multi.?modal)|not a multimodal model|only supports text|image.*mmproj/i.test(text);
}

export class VisionUnsupportedError extends Error {
  constructor(message: string) { super(message); this.name = "VisionUnsupportedError"; }
}
export function setImageSupport(c: ServerConnection, imageSupport: ImageSupport): void {
  const key = connectionCacheKey(c);
  const changed = imageCapabilities.get(key) !== imageSupport;
  if (imageCapabilities.size > 128) imageCapabilities.clear();
  imageCapabilities.set(key, imageSupport);
  const hit = metadataCache.get(key);
  if (hit && hit.value.imageSupport !== imageSupport) {
    hit.value = { ...hit.value, imageSupport, supportsVision: imageSupport !== "unsupported" };
  }
  if (changed) for (const listener of capabilityListeners) listener(c);
}

async function vllmTokenize(c: ServerConnection, body: unknown, signal?: AbortSignal, images = false): Promise<{ count: number; max_model_len: number }> {
  const res = await request(c, "tokenize", signal, body);
  if (!res.ok) {
    const failure = await serverFailure(res, c, "vLLM preprocessing");
    if (images && isUnsupportedImage(res.status, failure.message)) {
      setImageSupport(c, "unsupported");
      throw new VisionUnsupportedError("The selected vLLM model does not support image input. Choose a vision model or remove the images.");
    }
    throw failure;
  }
  const data = await readJson<{ count?: unknown; max_model_len?: unknown; tokens?: unknown }>(res);
  if (!Number.isSafeInteger(data?.count) || (data.count as number) < 0 || !positive(data.max_model_len)
    || !Array.isArray(data.tokens) || data.tokens.length !== data.count || !data.tokens.every(Number.isSafeInteger)) {
    throw new StreamFailure("vLLM returned invalid tokenizer data.", { cause: "protocol_error" });
  }
  if (images) setImageSupport(c, "supported");
  return { count: data.count as number, max_model_len: data.max_model_len };
}

export async function tokenize(endpoint: string, text: string, model?: string, options: { signal?: AbortSignal; exact?: boolean; onEstimate?: () => void } = {}): Promise<number> {
  options.signal?.throwIfAborted();
  try {
    const c = await resolvedConnection(endpoint, model, options.signal);
    if (c.backend === "vllm") {
      const result = await vllmTokenize(c, { model: c.model ?? model, prompt: text, add_special_tokens: false }, options.signal);
      if (text.trim() && !result.count) throw new StreamFailure("vLLM returned an empty token count for nonempty text.", { cause: "protocol_error" });
      return result.count;
    }
    const res = await request(c, "tokenize", options.signal, { content: text, model: c.model ?? model });
    if (!res.ok) throw await serverFailure(res, c, "Tokenization");
    const obj = await readJson<{ tokens?: number[] }>(res);
    if (!Array.isArray(obj?.tokens) || !obj.tokens.every(Number.isSafeInteger) || (text.trim() && !obj.tokens.length)) throw new StreamFailure("The tokenizer returned invalid data.", { cause: "protocol_error" });
    options.signal?.throwIfAborted();
    return obj.tokens.length;
  } catch (error) {
    options.signal?.throwIfAborted();
    if (options.exact) throw error;
    options.onEstimate?.(); return Math.ceil(text.length / 4);
  }
}

export function serializeRequest(req: ChatCompletionRequest, c: ServerConnection): Record<string, unknown> {
  const vllm = c.backend === "vllm";
  const disabled = req.chat_template_kwargs?.enable_thinking === false || req.thinking_budget_tokens === 0;
  const auxiliary = req.purpose === "auxiliary";
  const effort = vllm && (disabled || auxiliary) ? "none" : req.reasoning_effort;
  if (vllm && effort !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)) {
    throw new StreamFailure(`vLLM does not support reasoning effort "${effort}". Update Reasoning efforts in Settings.`, { cause: "protocol_error" });
  }
  return {
    model: c.model ?? req.model ?? "local", messages: vllm ? req.messages.map(({ reasoning_content, ...m }) => ({ ...m, ...(reasoning_content !== undefined ? { reasoning: reasoning_content } : {}) })) : req.messages,
    stream: true, temperature: req.temperature ?? 0.8, top_k: req.top_k, top_p: req.top_p,
    [vllm ? "max_completion_tokens" : "max_tokens"]: req.max_tokens,
    ...(vllm ? { thinking_token_budget: !disabled && !auxiliary && (req.thinking_budget_tokens ?? -1) > 0 ? req.thinking_budget_tokens : undefined }
      : { thinking_budget_tokens: req.thinking_budget_tokens, return_progress: req.return_progress,
        parallel_tool_calls: req.tools?.length ? req.parallel_tool_calls ?? false : undefined }),
    reasoning_effort: effort,
    chat_template_kwargs: vllm && (disabled || auxiliary) ? { ...req.chat_template_kwargs, enable_thinking: false } : req.chat_template_kwargs,
    tools: req.tools, tool_choice: req.tools?.length ? req.tool_choice ?? "auto" : undefined,
    stream_options: { include_usage: true }
  };
}

/** Count the actual vLLM chat template and multimodal input before generation. */
export function outputTokenReserve(contextSize: number, maxTokens?: number): number {
  return maxTokens ?? Math.max(1, Math.min(4096, Math.floor(contextSize / 4)));
}

export async function countServerPrompt(endpoint: string, req: ChatCompletionRequest, signal?: AbortSignal, checkLimit = true): Promise<number | undefined> {
  signal?.throwIfAborted();
  const c = await resolvedConnection(endpoint, req.model, signal);
  if (c.backend !== "vllm") return undefined;
  const body = serializeRequest(req, c);
  const images = req.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === "image_url"));
  const template = body.chat_template_kwargs as Record<string, unknown> | undefined;
  const kwargs = { ...template,
    ...(body.reasoning_effort !== undefined && template?.enable_thinking === undefined ? { enable_thinking: body.reasoning_effort !== "none" } : {}),
    ...(body.reasoning_effort !== undefined ? { reasoning_effort: body.reasoning_effort } : {}),
    ...(body.tools ? { tool_choice: body.tool_choice } : {}) };
  const result = await vllmTokenize(c, { model: body.model, messages: body.messages, tools: body.tools,
    chat_template_kwargs: kwargs, add_generation_prompt: true, add_special_tokens: false }, signal, images);
  const contextSize = Math.min(result.max_model_len, metadataCache.get(connectionCacheKey(c))?.value.contextSize ?? result.max_model_len);
  if (!result.count) throw new StreamFailure("vLLM returned an empty chat prompt.", { cause: "protocol_error" });
  if (checkLimit && result.count + outputTokenReserve(contextSize, req.max_tokens) > contextSize) {
    throw new StreamFailure(`The prompt and output budget exceed the server context of ${contextSize} tokens. Compact context or increase vLLM --max-model-len.`, { cause: "protocol_error" });
  }
  return result.count;
}
