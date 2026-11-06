import type { ChatMessage } from "./types.js";

export function messageContainsToolCall(message: ChatMessage): boolean {
  return Array.isArray(message.events)
    && message.events.some(event => !!event && typeof event === "object" && (event as { kind?: unknown }).kind === "toolCall");
}

/**
 * Tool results are saved as they execute, before the assistant round is saved.
 * Replay that round's preamble before its results, retaining original indices
 * for stable UI identities. Plain answers and legacy initial recalls stay put.
 */
export function chronologicalMessages(messages: ChatMessage[]): { message: ChatMessage; index: number }[] {
  const ordered: { message: ChatMessage; index: number }[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== "tool" || message.initialMemoryContext) {
      ordered.push({ message, index });
      continue;
    }
    const start = index;
    while (index < messages.length && messages[index].role === "tool" && !messages[index].initialMemoryContext) index++;
    const following = messages[index];
    const preamble = following?.role === "assistant" && messageContainsToolCall(following);
    if (preamble) ordered.push({ message: following, index });
    for (let toolIndex = start; toolIndex < index; toolIndex++) ordered.push({ message: messages[toolIndex], index: toolIndex });
    if (!preamble) index--;
  }
  return ordered;
}
