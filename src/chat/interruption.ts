import type { ChatRecord, ChatMessage } from "./types.js";

/** Old saved interruptions remain resumable; explicit cancellation does not hold the queue. */
export function unresolvedInterruption(record: ChatRecord): ChatMessage | undefined {
  const message = record.messages.at(-1);
  const interruption = message?.interruption;
  if (!interruption || interruption.resolved || interruption.queueReleased || interruption.diagnostics?.cause === "user_cancel"
    || /^(Stopped by user\.|Cancelled\.)$/.test(interruption.reason)) return undefined;
  return message;
}
