import { modelMessages } from "./storage.js";
import { newMessageId } from "./contextHistory.js";
import type { ChatMessage, ChatRecord } from "./types.js";

/** Keep completed work and any compacted summary, dropping the failed tail. */
export function continuationContext(record: ChatRecord): ChatMessage[] {
  const context = modelMessages(record);
  let end = context.length;
  for (let index = context.length - 1; index >= 0; index--) {
    const message = context[index];
    // A completed Responses pass can contain commentary or reasoning after
    // the last tool exchange. Its native items are part of the accepted prefix.
    if (message.role === "user" || (message.role === "assistant" && message.responseHistory)) {
      end = index + 1;
      break;
    }
    if (message.role !== "tool") continue;
    const succeeded = message.toolCall?.status === "executed"
      || (message.toolCall?.status === undefined && !/^(?:error:|\[blocked:|\[rejected by user\]|\[ask_user_question dismissed\])/i.test(message.content.trimStart()));
    if (!succeeded) continue;
    end = index + 1;
    // Native reasoning/preamble is stored after the tool result and replayed
    // alongside its call. Keep it when that pass completed successfully.
    const next = context[end];
    if (next?.role === "assistant" && next.events?.some(event =>
      typeof event === "object" && event !== null && "kind" in event && event.kind === "toolCall"
    )) end++;
    break;
  }
  return structuredClone(context.slice(0, end));
}

/** Keep the resume instruction in the model's prefix across later tool passes and reloads. */
export function appendContinuationGuidance(record: ChatRecord, ts: number): void {
  const content = "Resume the interrupted turn from the saved conversation and completed tool results. "
    + "Pick up at the next unfinished step and answer the original request.";
  const context = record.contextMessages ??= record.messages.slice();
  const last = context.at(-1);
  if (last?.steering && last.content === content) return;
  context.push({ id: newMessageId(), role: "user", steering: true, content, ts });
}
