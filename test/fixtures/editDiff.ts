import type { WriteToolName } from "../../src/llm/toolProgress.js";

export interface EditDiffCase {
  name: string;
  tool: WriteToolName;
  previous?: string;
  next: string;
  args: Record<string, unknown>;
  added: number;
  removed: number;
}

const largePrevious = Array.from({ length: 1300 }, (_, i) => `old ${i}`).join("\n");
const largeNext = Array.from({ length: 1300 }, (_, i) => `new ${i}`).join("\n");

export const editDiffCases: EditDiffCase[] = [
  { name: "multiple replacements", tool: "edit_file", previous: "one\ntwo\nthree\n", next: "ONE\ntwo\nTHREE\n",
    args: { edits: [{ oldText: "one", newText: "ONE" }, { oldText: "three", newText: "THREE" }] }, added: 2, removed: 2 },
  { name: "trailing newline", tool: "create_file", next: "hello\n", args: { content: "hello\n" }, added: 1, removed: 0 },
  { name: "empty new file", tool: "create_file", next: "", args: { content: "" }, added: 0, removed: 0 },
  { name: "CRLF new file", tool: "create_file", next: "one\r\ntwo\r\n", args: { content: "one\r\ntwo\r\n" }, added: 2, removed: 0 },
  { name: "range with unchanged lines", tool: "replace_range", previous: "one\ntwo\nthree\n", next: "one\nTWO\nthree\n",
    args: { startLine: 1, endLine: 3, expectedContent: "one\ntwo\nthree", content: "one\nTWO\nthree\n" }, added: 1, removed: 1 },
  { name: "insertion with automatic line break", tool: "insert_text", previous: "one\ntwo\n", next: "one\nmiddle\ntwo\n",
    args: { line: 2, expectedLine: "two", text: "middle" }, added: 1, removed: 0 },
  { name: "append without existing final newline", tool: "insert_text", previous: "one", next: "one\nmiddle",
    args: { line: 2, expectedLine: "<EOF>", text: "middle" }, added: 1, removed: 0 },
  { name: "deletion", tool: "edit_file", previous: "one\ntwo\n", next: "one\n",
    args: { edits: [{ oldText: "two\n", newText: "" }] }, added: 0, removed: 1 },
  { name: "legacy overwrite", tool: "write_file", previous: "one\ntwo\nthree\n", next: "one\ntwo\nTHREE\n",
    args: { content: "one\ntwo\nTHREE\n" }, added: 1, removed: 1 },
  { name: "legacy new file", tool: "write_file", next: "hello\n", args: { content: "hello\n" }, added: 1, removed: 0 },
  { name: "capped preview", tool: "edit_file", previous: largePrevious, next: largeNext,
    args: { edits: [{ oldText: largePrevious, newText: largeNext }] }, added: 1300, removed: 1300 }
];
