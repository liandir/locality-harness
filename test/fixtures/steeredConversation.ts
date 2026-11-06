import type { ChatMessage } from "../../src/chat/types.js";

/** Execution-order storage, including a failed tool and guidance between rounds. */
export function steeredConversation(): ChatMessage[] {
  return [
    { role: "user", content: "Inspect the parser", ts: 1 },
    { role: "tool", content: "First file contents", ts: 4,
      toolCall: { id: "read", name: "read_file", argsJson: '{"path":"parser.ts"}', status: "executed" } },
    { role: "tool", content: "error: missing", ts: 5,
      toolCall: { id: "missing", name: "read_file", argsJson: '{"path":"missing.ts"}', status: "failed" } },
    { role: "assistant", content: "Checking the files.", reasoningContent: "Inspect before editing.", ts: 6,
      events: [{ kind: "thought", text: "Inspect before editing.", t: 2 }, { kind: "text", text: "Checking the files.", t: 3 },
        { kind: "toolCall", name: "read_file", argsJson: '{"path":"parser.ts"}', id: "read", t: 4 },
        { kind: "toolCall", name: "read_file", argsJson: '{"path":"missing.ts"}', id: "missing", t: 5 }] },
    { role: "user", content: "Only inspect the tests", steering: true, ts: 7 },
    { role: "tool", content: "Test file contents", ts: 10,
      toolCall: { id: "tests", name: "read_file", argsJson: '{"path":"parser.test.ts"}', status: "executed" } },
    { role: "assistant", content: "Checking the tests.", reasoningContent: "Follow the guidance.", ts: 11,
      events: [{ kind: "thought", text: "Follow the guidance.", t: 8 }, { kind: "text", text: "Checking the tests.", t: 9 },
        { kind: "toolCall", name: "read_file", argsJson: '{"path":"parser.test.ts"}', id: "tests", t: 10 }] },
    { role: "assistant", content: "Inspection complete.", ts: 12,
      events: [{ kind: "text", text: "Inspection complete.", t: 12 }] }
  ];
}
