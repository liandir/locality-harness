import { connectionIdentity } from "../llm/connection.js";
import { isImageAttachment } from "./attachments.js";
import { tokenize } from "../llm/client.js";
import type { LlmContent } from "../llm/client.js";
import { withUserContext } from "../llm/prompt.js";
import { VISION_TOKEN_RESERVE, modelMessages } from "./storage.js";
import type { ChatMessage, ChatRecord } from "./types.js";
import type { ChatCompletionRequest } from "../llm/client.js";
import { countServerPrompt } from "../llm/server.js";
import type { PromptMeasurement } from "../llm/requestPolicy.js";

/**
 * Exact token counts keyed by the exact string tokenized. Repeated guard and
 * trigger passes within a turn — and unchanged messages across turns — reuse
 * the count instead of re-hitting /tokenize. Bounded so a long session can't
 * grow it without limit.
 */
const tokenCountCache = new Map<string, number>();
const TOKEN_CACHE_MAX = 1024;

/** Authoritative token count for a single string, with a bounded content cache. */
export async function countTokens(endpoint: string, text: string, model?: string, options: { signal?: AbortSignal; exact?: boolean; onEstimate?: () => void } = {}): Promise<number> {
  options.signal?.throwIfAborted();
  const cacheKey = `${connectionIdentity(endpoint, model)}\n${text}`;
  const cached = tokenCountCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let estimated = false;
  const n = await tokenize(endpoint, text, model, { ...options, onEstimate: () => { estimated = true; } });
  options.signal?.throwIfAborted();
  // Best-effort callers retain their fallback; estimates never become exact cache entries.
  if (estimated) { options.onEstimate?.(); return n; }
  if (tokenCountCache.size >= TOKEN_CACHE_MAX) tokenCountCache.clear();
  tokenCountCache.set(cacheKey, n);
  return n;
}

/**
 * Lazily attaches a token count to each message; returns the sum.
 * Uses the endpoint's /tokenize where reachable, falling back to a char/4
 * heuristic. Caching on each message means recompute is amortized.
 */
export async function recomputeTokens(
  endpoint: string,
  rec: ChatRecord,
  model?: string,
  signal?: AbortSignal
): Promise<number> {
  const identity = `${connectionIdentity(endpoint, model)}:history-v2`;
  if (rec.tokenizerIdentity !== identity) {
    for (const message of modelMessages(rec)) delete message.tokens;
    rec.tokenizerModel = model;
    rec.tokenizerIdentity = identity;
  }
  let total = 0;
  for (const m of modelMessages(rec)) {
    signal?.throwIfAborted();
    let tokens = m.tokens;
    if (typeof tokens !== "number") {
      let estimated = false;
      tokens = await countTokens(endpoint, formatForCounting(m), model, { signal, onEstimate: () => { estimated = true; } })
        + (m.attachments?.filter(isImageAttachment).length ?? 0) * VISION_TOKEN_RESERVE;
      if (!estimated) m.tokens = tokens;
    }
    total += tokens;
  }
  rec.totalTokens = total;
  return total;
}

/**
 * Estimate the assembled prompt using exact content tokenization and explicit
 * template overhead. This includes reconstructed calls and tool results, but
 * cannot claim the accuracy of a server-rendered chat-template count.
 * measureRequestPrompt labels this fallback and the shared budget adds headroom.
 */
export async function promptTokens(
  endpoint: string,
  messages: {
    role: string;
    content: LlmContent;
    reasoning_content?: string;
    tool_calls?: unknown[];
  }[],
  overheadPerMessage: number,
  model?: string,
  signal?: AbortSignal
): Promise<number> {
  let total = 0;
  for (const m of messages) {
    total += await countTokens(endpoint, formatPromptMessageForCounting(m), model, { signal, exact: true });
    if (Array.isArray(m.content)) {
      total += m.content.filter(part => part.type === "image_url").length * VISION_TOKEN_RESERVE;
    }
    total += overheadPerMessage;
  }
  return total;
}

export interface TruncationResult {
  text: string;
  truncated: boolean;
  elidedTokens: number;
  elidedLines: number;
}

/**
 * Middle-truncate `text` so its token count fits within `maxTokens`, leaving a
 * visible marker where content was elided. The head is favored (60% of the
 * kept budget) because a tool result's first lines — the path, command, or
 * opening of a file — usually carry the most orientation. Tokenization is
 * non-linear in characters, so we converge over a few measured passes rather
 * than trusting a single ratio estimate.
 */
export async function truncateToTokenBudget(
  endpoint: string,
  text: string,
  maxTokens: number,
  model?: string,
  signal?: AbortSignal
): Promise<TruncationResult> {
  const total = await countTokens(endpoint, text, model, { signal });
  if (maxTokens <= 0) {
    const marker = elisionMarker(total, countNewlines(text));
    return { text: marker, truncated: true, elidedTokens: total, elidedLines: countNewlines(text) };
  }
  if (total <= maxTokens) return { text, truncated: false, elidedTokens: 0, elidedLines: 0 };

  const markerReserve = 48; // leave room for the marker itself inside the budget
  let keepTokens = Math.max(1, maxTokens - markerReserve);
  const charsPerToken = text.length / Math.max(1, total);
  let out = text;
  let elidedLines = 0;

  for (let attempt = 0; attempt < 6; attempt++) {
    const keepChars = Math.max(0, Math.floor(keepTokens * charsPerToken));
    const headChars = Math.floor(keepChars * 0.6);
    const tailChars = Math.max(0, keepChars - headChars);
    const head = text.slice(0, headChars);
    const tail = tailChars > 0 ? text.slice(text.length - tailChars) : "";
    const elidedMiddle = text.slice(head.length, text.length - tail.length);
    elidedLines = countNewlines(elidedMiddle);
    const approxElidedTokens = Math.max(1, total - keepTokens);
    out = head + elisionMarker(approxElidedTokens, elidedLines) + tail;
    const measured = await countTokens(endpoint, out, model, { signal });
    if (measured <= maxTokens) break;
    // Overshot the budget — shrink proportionally and try again.
    keepTokens = Math.max(1, Math.floor(keepTokens * (maxTokens / measured)) - 4);
  }

  const finalTokens = await countTokens(endpoint, out, model, { signal });
  return { text: out, truncated: true, elidedTokens: Math.max(0, total - finalTokens), elidedLines };
}

function elisionMarker(tokens: number, lines: number): string {
  return `\n\n[… context guard elided ≈${tokens} tokens / ${lines} lines …]\n\n`;
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") n++;
  return n;
}

function formatForCounting(m: ChatMessage): string {
  return `<|${m.role}|>${m.reasoningContent ? `<|reasoning|>${m.reasoningContent}` : ""}${withUserContext(m.content, m.requestContext)}${m.toolCall ? `<|tool_call|>${m.toolCall.name}\n${m.toolCall.argsJson}` : ""}`;
}

/** One measurement path for every task; only the adapter knows the backend. */
export async function measureRequestPrompt(endpoint: string, request: ChatCompletionRequest, overhead: number, signal?: AbortSignal): Promise<PromptMeasurement> {
  const exact = await countServerPrompt(endpoint, request, signal, false);
  if (exact !== undefined) return { tokens: exact, accuracy: "exact" };
  const messages = [...request.messages];
  if (request.tools?.length) messages.push({ role: "system", content: JSON.stringify(request.tools) });
  return { tokens: await promptTokens(endpoint, messages, overhead, request.model, signal), accuracy: "estimated" };
}

function formatPromptMessageForCounting(m: {
  role: string;
  content: LlmContent;
  reasoning_content?: string;
  tool_calls?: unknown[];
}): string {
  const reasoning = m.reasoning_content ? `<|reasoning|>${m.reasoning_content}` : "";
  const calls = m.tool_calls?.length ? `<|tool_calls|>${JSON.stringify(m.tool_calls)}` : "";
  if (typeof m.content === "string") return `<|${m.role}|>${reasoning}${m.content}${calls}`;
  const text = m.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  return `<|${m.role}|>${reasoning}${text}${calls}`;
}
