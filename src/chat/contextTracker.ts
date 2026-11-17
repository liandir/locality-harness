import { createHash } from "node:crypto";
import { connectionIdentity } from "../llm/connection.js";
import { tokenize, type ChatCompletionRequest } from "../llm/client.js";
import { countServerPrompt, serverCacheRevision } from "../llm/server.js";
import type { PromptMeasurement } from "../llm/requestPolicy.js";

const tokenCountCache = new Map<string, { tokens: number; at: number }>();
const TOKEN_CACHE_MAX = 1024;

/** Only successful tokenizer responses enter this bounded cache. */
export async function countTokens(endpoint: string, text: string, model?: string, options: { signal?: AbortSignal; exact?: boolean } = {}): Promise<number> {
  options.signal?.throwIfAborted();
  const key = createHash("sha256").update(connectionIdentity(endpoint, model)).update(`:${serverCacheRevision()}\n`).update(text).digest("hex");
  const cached = tokenCountCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) { tokenCountCache.delete(key); tokenCountCache.set(key, cached); return cached.tokens; }
  const tokens = await tokenize(endpoint, text, model, { ...options, exact: true });
  options.signal?.throwIfAborted();
  if (tokenCountCache.size >= TOKEN_CACHE_MAX) tokenCountCache.delete(tokenCountCache.keys().next().value!);
  tokenCountCache.set(key, { tokens, at: Date.now() });
  return tokens;
}

export interface TruncationResult {
  text: string;
  truncated: boolean;
  elidedTokens: number;
  elidedLines: number;
}

/** Search character boundaries, accepting only candidates measured within budget. */
export async function truncateToTokenBudget(endpoint: string, text: string, maxTokens: number, model?: string, signal?: AbortSignal): Promise<TruncationResult> {
  if (await countTokens(endpoint, text, model, { signal }) <= maxTokens) {
    return { text, truncated: false, elidedTokens: 0, elidedLines: 0 };
  }
  const points = Array.from(text);
  const candidate = (keep: number) => {
    const head = Math.ceil(keep * 0.6), tail = keep - head;
    const removed = points.slice(head, points.length - tail).join("");
    const lines = removed.split("\n").length;
    return { text: points.slice(0, head).join("") + `\n[… context guard elided ${lines} lines …]\n` + (tail ? points.slice(-tail).join("") : ""), removed, lines };
  };
  let best = candidate(0);
  if (await countTokens(endpoint, best.text, model, { signal }) > maxTokens) throw new Error("The tool output budget cannot fit a truncation marker.");
  let low = 1, high = points.length - 1;
  for (let attempt = 0; low <= high && attempt < 32; attempt++) {
    const keep = Math.floor((low + high) / 2);
    const next = candidate(keep);
    if (await countTokens(endpoint, next.text, model, { signal }) <= maxTokens) { best = next; low = keep + 1; }
    else high = keep - 1;
  }
  return { text: best.text, truncated: true, elidedTokens: await countTokens(endpoint, best.removed, model, { signal }), elidedLines: best.lines };
}

/** The adapter measures its serialized generation request, including images and tools. */
export async function measureRequestPrompt(endpoint: string, request: ChatCompletionRequest, _overhead: number, signal?: AbortSignal): Promise<PromptMeasurement> {
  return { tokens: await countServerPrompt(endpoint, request, signal, false), accuracy: "exact" };
}
