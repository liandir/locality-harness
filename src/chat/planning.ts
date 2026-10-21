import type { ChatRecord } from "./types.js";

/** Retain old submitted plans, but never approve a missing or interrupted response. */
export function pendingPlanTimestamp(record: ChatRecord): number | undefined {
  const timestamp = record.pendingPlanMessageTs;
  if (timestamp === undefined) return undefined;
  return record.messages.some(message => message.ts === timestamp && message.role === "assistant"
    && !message.interruption && message.content.trim()) ? timestamp : undefined;
}
