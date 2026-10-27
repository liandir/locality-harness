import type { ServerType } from "../llm/serverTypes.js";
import { serverRoot } from "../llm/connection.js";
import { createHash, randomUUID } from "node:crypto";
import { StreamFailure, type CompletionDiagnostics } from "../llm/completion.js";
import { NetworkPolicyError } from "../network/safeFetch.js";
import { transcriptRevision } from "./memory.js";
import type { ChatRecord } from "./types.js";

export const MEMORY_REQUEST_TIMEOUT_MS = 120_000;
/** Active execution only; foreground waits and retry backoff do not spend this budget. */
export const MEMORY_JOB_BUDGET_MS = 10 * 60_000;
export const MEMORY_MAX_RETRIES = 2;
export type { MemoryAttempt, MemoryCheckpoint, MemoryDiagnostic, MemoryStage } from "./memoryJobTypes.js";
import type { MemoryAttempt, MemoryDiagnostic, MemoryStage } from "./memoryJobTypes.js";

export function legacyMemorySignature(endpoint: string, model: string): string {
  // No endpoint credentials are persisted. Bump the version when the input/prompt changes.
  return createHash("sha256").update(JSON.stringify(["memory-v2", endpoint, model])).digest("hex");
}
export function memorySignature(endpoint: string, model: string, serverType: ServerType = "llama.cpp"): string {
  return createHash("sha256").update(JSON.stringify(["memory-v3", serverRoot(endpoint), model, serverType])).digest("hex");
}
export function pendingMemory(attempt?: MemoryAttempt): attempt is MemoryAttempt {
  return !!attempt && ["queued", "generating", "retry_wait"].includes(attempt.state);
}
export function memorySourceMatches(rec: ChatRecord, attempt: MemoryAttempt): boolean {
  return rec.messages.length >= attempt.sourceLength
    && (attempt.messageTs === undefined || rec.messages[attempt.sourceLength - 1]?.ts === attempt.messageTs)
    && transcriptRevision({ ...rec, messages: rec.messages.slice(0, attempt.sourceLength) }) === attempt.sourceRevision;
}
export function newMemoryAttempt(rec: ChatRecord, signature: string, regenerate: boolean, messageTs?: number): MemoryAttempt | undefined {
  messageTs ??= [...rec.messages].reverse().find(message => message.role === "assistant")?.ts;
  const index = messageTs === undefined ? rec.messages.length - 1 : rec.messages.findIndex(message => message.role === "assistant" && message.ts === messageTs);
  if (index < 0) return;
  const sourceLength = index + 1;
  return { version: 1, id: randomUUID(), state: "queued", operation: rec.memory?.text.trim() ? "update" : "create", messageTs,
    sourceLength, sourceRevision: transcriptRevision({ ...rec, messages: rec.messages.slice(0, sourceLength) }), signature,
    regenerate, createdAt: Date.now(), updatedAt: Date.now(), retries: 0, requests: 0, shorterAttempt: 0, activeMs: 0 };
}
export class MemoryFailure extends Error {
  constructor(readonly diagnostic: MemoryDiagnostic) { super(diagnostic.message); this.name = "MemoryFailure"; }
}
export function memoryFailure(error: unknown, stage: MemoryStage, attempt = 1): MemoryDiagnostic {
  attempt = Math.max(1, attempt);
  if (error instanceof MemoryFailure) return { ...error.diagnostic, attempt };
  const raw = error instanceof StreamFailure ? error.diagnostics : undefined;
  const completion: CompletionDiagnostics | undefined = raw && {
    cause: raw.cause, completionEvidence: raw.completionEvidence,
    finishReason: raw.finishReason === undefined ? undefined : ["stop", "tool_calls", "function_call", "length", "content_filter", "error"].includes(raw.finishReason) ? raw.finishReason : "unknown",
    httpStatus: raw.httpStatus, promptTokens: raw.promptTokens, completionTokens: raw.completionTokens
  };
  const timeout = error instanceof Error && error.name === "TimeoutError";
  const policy = error instanceof NetworkPolicyError;
  const transport = completion?.cause === "transport" || error instanceof TypeError
    || (error instanceof Error && ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ETIMEDOUT"].includes(String((error as NodeJS.ErrnoException).code)));
  const cause = stage === "storage" ? "storage" : policy ? "policy" : timeout ? "timeout"
    : transport ? "transport" : completion?.cause === "unexpected_eof" ? "unexpected_eof"
      : completion?.cause === "generation_limit" ? "generation_limit" : completion?.cause === "protocol_error" ? "protocol_error"
        : completion?.cause === "server_error" ? "server_error" : "unavailable";
  const retryable = stage !== "storage" && !policy && (transport || timeout || cause === "unexpected_eof"
    || (cause === "server_error" && [408, 429, 500, 502, 503, 504].includes(completion?.httpStatus ?? 0)));
  const message = stage === "storage" ? "The memory could not be saved. Check local storage and retry."
    : policy ? "The memory request was blocked by the network policy. Check the endpoint settings."
      : cause === "timeout" ? "The memory request timed out."
        : cause === "unexpected_eof" ? "The server stopped before completing the memory."
          : cause === "generation_limit" ? "The memory reached the model's generation limit."
            : cause === "protocol_error" ? "The server returned invalid data during memory generation."
              : stage === "metadata" ? "The server's model context information is unavailable."
                : stage === "tokenization" ? "An exact token count is unavailable. Memory generation needs the server tokenizer."
                  : cause === "transport" ? "The connection to the memory model server failed."
                    : cause === "server_error" ? `The memory model server rejected the request${completion?.httpStatus ? ` (HTTP ${completion.httpStatus})` : ""}.`
                      : "Memory generation failed. Retry after checking the model server.";
  // Never store arbitrary exception messages: server bodies can echo prompts or credentials.
  return { stage, cause, message, retryable, attempt, completion };
}
export function invalidMemoryOutput(message: string): MemoryFailure {
  return new MemoryFailure({ stage: "validation", cause: "invalid_output", message, retryable: false, attempt: 1 });
}
