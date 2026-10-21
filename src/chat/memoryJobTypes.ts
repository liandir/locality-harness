import type { CompletionDiagnostics } from "../llm/completion.js";

export type MemoryStage = "metadata" | "tokenization" | "generation" | "validation" | "storage";
export interface MemoryDiagnostic {
  stage: MemoryStage;
  cause: "unavailable" | "transport" | "unexpected_eof" | "server_error" | "protocol_error" | "generation_limit" | "invalid_output" | "timeout" | "budget" | "storage" | "policy";
  message: string;
  retryable: boolean;
  attempt: number;
  completion?: CompletionDiagnostics;
}
export interface MemoryCheckpoint { offset: number; summary: string; complete?: boolean }
export interface MemoryAttempt {
  version: 1;
  id: string;
  state: "queued" | "generating" | "retry_wait" | "failed" | "cancelled" | "succeeded";
  operation: "create" | "update";
  messageTs?: number;
  sourceLength: number;
  sourceRevision: string;
  signature: string;
  regenerate: boolean;
  createdAt: number;
  updatedAt: number;
  retries: number;
  requests: number;
  shorterAttempt: 0 | 1;
  activeMs: number;
  startedAt?: number;
  retryAt?: number;
  checkpoint?: MemoryCheckpoint;
  diagnostic?: MemoryDiagnostic;
}
const number = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const hash = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
export function validMemoryDiagnostic(value: unknown): value is MemoryDiagnostic {
  if (!value || typeof value !== "object") return false;
  const d = value as MemoryDiagnostic;
  return ["metadata", "tokenization", "generation", "validation", "storage"].includes(d.stage)
    && ["unavailable", "transport", "unexpected_eof", "server_error", "protocol_error", "generation_limit", "invalid_output", "timeout", "budget", "storage", "policy"].includes(d.cause)
    && typeof d.message === "string" && d.message.length <= 500 && typeof d.retryable === "boolean" && number(d.attempt)
    && (d.completion === undefined || (typeof d.completion === "object" && d.completion !== null
      && [d.completion.promptTokens, d.completion.completionTokens, d.completion.httpStatus].every(n => n === undefined || number(n))
      && (d.completion.finishReason === undefined || typeof d.completion.finishReason === "string" && d.completion.finishReason.length <= 100)));
}
export function validMemoryAttempt(value: unknown): value is MemoryAttempt {
  if (!value || typeof value !== "object") return false;
  const a = value as MemoryAttempt;
  return a.version === 1 && typeof a.id === "string" && /^[a-f0-9-]{36}$/.test(a.id)
    && ["queued", "generating", "retry_wait", "failed", "cancelled", "succeeded"].includes(a.state)
    && ["create", "update"].includes(a.operation) && typeof a.regenerate === "boolean"
    && number(a.sourceLength) && a.sourceLength > 0 && hash(a.sourceRevision) && hash(a.signature)
    && [a.createdAt, a.updatedAt, a.retries, a.requests, a.activeMs].every(number) && [0, 1].includes(a.shorterAttempt)
    && [a.messageTs, a.startedAt, a.retryAt].every(n => n === undefined || number(n))
    && (a.diagnostic === undefined || validMemoryDiagnostic(a.diagnostic))
    && (a.checkpoint === undefined || !!a.checkpoint && number(a.checkpoint.offset) && a.checkpoint.offset > 0
      && typeof a.checkpoint.summary === "string" && a.checkpoint.summary.length <= 20000 && !!a.checkpoint.summary.trim()
      && (a.checkpoint.complete === undefined || typeof a.checkpoint.complete === "boolean"));
}
