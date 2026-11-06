import { describe, expect, it } from "vitest";
import { chronologicalMessages } from "../src/chat/messageOrder.js";
import type { ChatMessage } from "../src/chat/types.js";
import { steeredConversation } from "./fixtures/steeredConversation.js";

describe("chat chronology", () => {
  it("restores preambles before their tools while retaining guidance and stable record identities", () => {
    const messages = steeredConversation();
    const ordered = chronologicalMessages(messages);
    expect(ordered.map(item => item.index)).toEqual([0, 3, 1, 2, 4, 6, 5, 7]);
    expect(ordered.map(item => item.message.content)).toEqual([
      "Inspect the parser", "Checking the files.", "First file contents", "error: missing",
      "Only inspect the tests", "Checking the tests.", "Test file contents", "Inspection complete."
    ]);
    expect(messages).toEqual(steeredConversation());
  });

  it("keeps initial recalls, plain answers and incomplete tool rounds in their original places", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Request", ts: 1 },
      { role: "tool", content: "Legacy recalled note", initialMemoryContext: true, ts: 2 },
      { role: "tool", content: "Tool result", ts: 3 },
      { role: "assistant", content: "Preamble", events: [{ kind: "toolCall" }], ts: 4 },
      { role: "tool", content: "Another result", ts: 5 },
      { role: "assistant", content: "Plain answer", ts: 6 },
      { role: "tool", content: "Last result", ts: 7 }
    ];
    expect(chronologicalMessages(messages).map(item => item.index)).toEqual([0, 1, 3, 2, 4, 5, 6]);
  });
});
