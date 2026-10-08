import type { ChatResponseDiscarded } from "../../../chat/events.js";

type ResponsePart =
  | { kind: "text" | "thought"; text: string }
  | { kind: "tool"; card: { toolId: string } }
  | { kind: "summary" | "abort" | "steering" };

interface ResumableResponse {
  id: string;
  role: string;
  aborted?: string;
  recordTs?: number;
  workStartedAt?: number;
  workEndedAt?: number;
  startNewPart?: boolean;
  parts: { kind: string; startedAt?: number }[];
}

/** Bind resumed events to the saved work instead of creating a second response. */
export function resumeResponseMessage<T extends ResumableResponse>(messages: T[], messageId: string): T | undefined {
  const message = messages.at(-1);
  if (message?.role !== "assistant" || message.aborted !== undefined) return;
  message.id = messageId;
  message.recordTs = undefined;
  message.workEndedAt = undefined;
  // A restored thought is settled; new deltas must start a live activity.
  message.startNewPart = true;
  const starts = message.parts.flatMap(part => part.startedAt === undefined ? [] : [part.startedAt]);
  if (starts.length) message.workStartedAt ??= Math.min(...starts);
  return message;
}

/** Keep completed work while removing a failed generation's trailing output. */
export function discardResponseParts<T extends ResponsePart>(parts: readonly T[], discarded: ChatResponseDiscarded): T[] {
  const remaining = { text: discarded.textChars, thought: discarded.thoughtChars };
  const toolIds = new Set(discarded.toolIds);
  const kept: T[] = [];
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (part.kind === "tool" && toolIds.has(part.card.toolId)) continue;
    if ((part.kind === "text" || part.kind === "thought") && remaining[part.kind] > 0) {
      const count = Math.min(remaining[part.kind], part.text.length);
      remaining[part.kind] -= count;
      if (count < part.text.length) kept.push({ ...part, text: part.text.slice(0, -count) });
    } else kept.push(part);
  }
  return kept.reverse();
}
