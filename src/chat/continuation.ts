import { modelMessages } from "./storage.js";
import type { ChatMessage, ChatRecord } from "./types.js";

/** Keep completed work and any compacted summary, dropping the failed tail. */
export function continuationContext(record: ChatRecord): ChatMessage[] {
  const context = modelMessages(record);
  let end = context.length;
  for (let index = context.length - 1; index >= 0; index--) {
    const message = context[index];
    if (message.role === "user") {
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
