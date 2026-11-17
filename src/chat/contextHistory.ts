import { createHash, randomUUID } from "node:crypto";
import type { ChatMessage, ChatRecord } from "./types.js";
import { messageContainsToolCall } from "./messageOrder.js";

export interface ContextCheckpoint {
  version: 1;
  summaryMessageId: string;
  summary: string;
  sourceRevision: string;
  coveredIds: string[];
  protectedIds: string[];
  evidenceIds: string[];
  inputTokens: number;
  targetReached: boolean;
}

/** Legacy identities are deterministic across reloads and matching context copies. */
export function identifyMessages(messages: ChatMessage[]): void {
  const occurrences = new Map<string, number>();
  for (const message of messages) {
    const base = `${message.role}:${message.ts}:${message.toolCall?.id ?? ""}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    message.id ??= `legacy_${createHash("sha256").update(`${base}:${occurrence}`).digest("hex").slice(0, 32)}`;
  }
}

export function newMessageId(): string { return randomUUID(); }

/** Token caches do not change context; all other mutations remain guarded. */
export function historyRevision(record: ChatRecord, messages = record.contextMessages ?? record.messages): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([record.id, record.workspaceRoot, record.contextCheckpoint, record.unconsumedExchangeId,
    record.turnSystemPrompt, record.mode, record.planning, record.pendingPlanMessageTs]));
  for (const message of messages) hash.update(JSON.stringify({ ...message, tokens: undefined }));
  return hash.digest("hex");
}

/** New exchanges have explicit identities; older chats retain their original grouping. */
export function historyGroups(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const first = messages[i];
    const group = [first];
    if (first.exchangeId) {
      while (messages[i + 1]?.exchangeId === first.exchangeId) group.push(messages[++i]);
    } else if (first.role === "tool") {
      while (messages[i + 1]?.role === "tool" && !messages[i + 1].exchangeId
        && !!messages[i + 1].initialMemoryContext === !!first.initialMemoryContext) group.push(messages[++i]);
      if (!first.initialMemoryContext && messages[i + 1]?.role === "assistant" && messageContainsToolCall(messages[i + 1])) group.push(messages[++i]);
    }
    groups.push(group);
  }
  return groups;
}

export function validCheckpoint(value: unknown, messages: ChatMessage[]): value is ContextCheckpoint {
  if (!value || typeof value !== "object") return false;
  const item = value as ContextCheckpoint;
  return item.version === 1 && typeof item.summaryMessageId === "string" && typeof item.summary === "string"
    && typeof item.sourceRevision === "string" && Number.isSafeInteger(item.inputTokens) && item.inputTokens >= 0
    && typeof item.targetReached === "boolean"
    && [item.coveredIds, item.protectedIds, item.evidenceIds].every(ids => Array.isArray(ids) && ids.every(id => typeof id === "string"))
    && messages.some(message => message.id === item.summaryMessageId && message.role === "system"
      && message.content === `[context summary]\n${item.summary}`);
}
