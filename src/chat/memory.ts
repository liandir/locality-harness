/** Legacy chat-summary parsing and history rendering only. New notes use workspaceNotes.ts. */
import { validMemoryDiagnostic, type MemoryDiagnostic } from "./memoryJobTypes.js";
import { createHash } from "node:crypto";
import type { ChatRecord } from "./types.js";

export interface ChatMemory {
  text: string;
  sourceRevision: string;
  generatedAt: number;
  enabled: boolean;
  manual: boolean;
  error?: string;
}
/** UI history, kept outside the transcript and model context. */
export interface MemoryCreation {
  messageTs: number;
  status: "queued" | "generating" | "retry_wait" | "cancelled" | "created" | "failed";
  attemptId?: string;
  diagnostic?: MemoryDiagnostic;
  /** Whether a summary existed before this operation; absent in older history. */
  operation?: "create" | "update";
  text?: string;
  generatedAt?: number;
  error?: string;
}

export function validMemoryCreation(value: unknown): value is MemoryCreation {
  if (!value || typeof value !== "object") return false;
  const item = value as MemoryCreation;
  return validTimestamp(item.messageTs)
    && (item.attemptId === undefined || typeof item.attemptId === "string" && /^[a-f0-9-]{36}$/.test(item.attemptId))
    && (item.diagnostic === undefined || validMemoryDiagnostic(item.diagnostic))
    && (item.operation === undefined || item.operation === "create" || item.operation === "update")
    && ((item.status === "created" && typeof item.text === "string" && item.text.length <= 20000
      && typeof item.generatedAt === "number" && validTimestamp(item.generatedAt))
      || (item.status === "failed" && typeof item.error === "string")
      || ["queued", "generating", "retry_wait", "cancelled"].includes(item.status));
}
export interface MemorySnapshot {
  sourceId: string;
  title: string;
  sourceRevision: string;
  generatedAt: number;
  text: string;
}
export function transcriptRevision(rec: ChatRecord): string {
  // Exclude token caches, context summaries, imported memories and hidden reasoning.
  return createHash("sha256").update(JSON.stringify(rec.messages.map(m => ({
    role: m.role, content: m.content, ts: m.ts,
    attachments: m.attachments, toolCall: m.toolCall, fileChanges: m.fileChanges
  })))).digest("hex");
}
export function validMemory(value: unknown): value is ChatMemory {
  if (!value || typeof value !== "object") return false;
  const m = value as ChatMemory;
  return typeof m.text === "string" && m.text.length <= 20000
    && typeof m.sourceRevision === "string" && /^[a-f0-9]{64}$/.test(m.sourceRevision)
    && validTimestamp(m.generatedAt) && typeof m.enabled === "boolean" && typeof m.manual === "boolean"
    && (m.error === undefined || typeof m.error === "string");
}
export function validSnapshot(value: unknown): value is MemorySnapshot {
  if (!value || typeof value !== "object") return false;
  const m = value as MemorySnapshot;
  return typeof m.sourceId === "string" && /^[a-f0-9-]{36}$/i.test(m.sourceId)
    && typeof m.title === "string" && typeof m.text === "string" && m.text.length <= 20000
    && typeof m.sourceRevision === "string" && /^[a-f0-9]{64}$/.test(m.sourceRevision)
    && validTimestamp(m.generatedAt);
}
function validTimestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 8640000000000000;
}

/** Versioned identity: source ID disambiguates identical names and contents. */
export function memoryId(memory: MemorySnapshot): string {
  return createHash("sha256").update(JSON.stringify([memory.sourceId, memory.title, memory.text])).digest("hex").slice(0, 16);
}

export function memoryMetadata(memory: MemorySnapshot): { id: string; name: string; date: string } {
  return { id: memoryId(memory), name: memory.title, date: new Date(memory.generatedAt).toISOString().replace(/:\d{2}\.\d{3}Z$/, "Z") };
}

export function memoryRecallResult(memory: MemorySnapshot): string {
  return JSON.stringify({ ...memoryMetadata(memory), contents: memory.text });
}

/** Remove common credential forms before saving and when reading externally edited notes. */
export function redactMemorySecrets(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[credential omitted]")
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{12,}|github_pat_[a-zA-Z0-9_]+|AKIA[A-Z0-9]{16})\b/g, "[credential omitted]")
    .replace(/\b(Bearer)\s+(?:\[credential omitted\]|[^\s"'`]+)/gi, "$1 [credential omitted]")
    .replace(/\b(password|passwd|secret|api[_-]?key|access[_-]?token|token)\b(["']?\s*[:=]\s*)(?:\[credential omitted\]|"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, "$1$2[credential omitted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[credential omitted]@");
}
