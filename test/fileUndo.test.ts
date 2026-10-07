import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileUndoPlan, turnFileEdits, undoFiles, type FileUndoSnapshot } from "../src/chat/fileUndo.js";
import type { ChatMessage } from "../src/chat/storage.js";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "locality-undo-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function edit(snapshot: FileUndoSnapshot, ts = 2): ChatMessage {
  return { role: "tool", content: "edited", ts, toolCall: {
    name: "edit_file", argsJson: "{}", status: "executed", fileUndo: snapshot, fileUndoState: "available",
    fileChange: { path: snapshot.path, added: 1, removed: 1, diffPreview: "" }
  } };
}

describe("response file undo", () => {
  it("selects only the requested turn, including edits after steering", () => {
    const first = edit({ path: "a", previous: "old", next: "new" });
    const second = edit({ path: "b", previous: null, next: "new" }, 4);
    const messages: ChatMessage[] = [
      { role: "user", content: "first", ts: 1 }, first,
      { role: "user", content: "guidance", steering: true, ts: 3 }, second,
      { role: "user", content: "next", ts: 5 }, edit({ path: "a", previous: "new", next: "later" }, 6)
    ];
    expect(turnFileEdits(messages, 1)).toEqual([first, second]);
    expect(turnFileEdits(messages, 1, "a")).toEqual([first]);
    expect(turnFileEdits(messages, 1, "b")).toEqual([second]);
    expect(turnFileEdits(messages, 1, "missing")).toEqual([]);
    expect(turnFileEdits(messages, 1, "")).toEqual([]);
    expect(turnFileEdits(messages, 3)).toEqual([]);
    expect(turnFileEdits(messages, 99)).toEqual([]);
  });

  it("merges consecutive edits while preserving the first file state", () => {
    expect(fileUndoPlan([
      edit({ path: "a", previous: null, next: "one" }), edit({ path: "a", previous: "one", next: "two" })
    ])).toEqual([{ path: "a", previous: null, next: "two" }]);
    expect(() => fileUndoPlan([
      edit({ path: "a", previous: "old", next: "one" }), edit({ path: "a", previous: "external", next: "two" })
    ])).toThrow("changed between");
  });

  it("refuses incomplete legacy snapshots and repeated undo", () => {
    const message = edit({ path: "a", previous: "old", next: "new" });
    delete message.toolCall!.fileUndo;
    expect(() => fileUndoPlan([message])).toThrow("complete, lossless");
    message.toolCall!.fileUndoState = "undone";
    expect(() => fileUndoPlan([message])).toThrow("already been undone");
  });

  it("restores exact contents and executable permissions, preserves empty files, and removes creations", async () => {
    await fs.writeFile(path.join(root, "script"), "new", { mode: 0o755 });
    const originalMode = (await fs.stat(path.join(root, "script"))).mode & 0o777;
    await fs.writeFile(path.join(root, "empty"), "new");
    await fs.writeFile(path.join(root, "created"), "new");
    const result = await undoFiles(root, [
      { path: "script", previous: "#!/bin/sh\r\necho old\r\n", next: "new" },
      { path: "empty", previous: "", next: "new" }, { path: "created", previous: null, next: "new" }
    ]);
    expect(result).toEqual({ undonePaths: ["script", "empty", "created"] });
    expect(await fs.readFile(path.join(root, "script"), "utf8")).toBe("#!/bin/sh\r\necho old\r\n");
    expect((await fs.stat(path.join(root, "script"))).mode & 0o777).toBe(originalMode);
    expect(await fs.readFile(path.join(root, "empty"), "utf8")).toBe("");
    await expect(fs.stat(path.join(root, "created"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks the whole batch before changing a file", async () => {
    await fs.writeFile(path.join(root, "a"), "new");
    await fs.writeFile(path.join(root, "b"), "external");
    await expect(undoFiles(root, [
      { path: "a", previous: "old", next: "new" }, { path: "b", previous: "old", next: "new" }
    ])).rejects.toThrow("No files were changed");
    expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("new");
    expect(await fs.readFile(path.join(root, "b"), "utf8")).toBe("external");
  });

  it("refuses dirty editors and workspace escapes", async () => {
    await fs.writeFile(path.join(root, "a"), "new");
    const changes = [{ path: "a", previous: "old", next: "new" }];
    await expect(undoFiles(root, changes, () => { throw new Error("Unsaved edits"); })).rejects.toThrow("Unsaved edits");
    await fs.symlink(os.tmpdir(), path.join(root, "outside"), process.platform === "win32" ? "junction" : "dir");
    for (const file of ["../outside", "outside/file"]) {
      await expect(undoFiles(root, [{ ...changes[0], path: file }])).rejects.toThrow("outside the workspace");
    }
    expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("new");
  });

  it("refuses a file replaced with non-UTF-8 bytes instead of comparing lossy text", async () => {
    const bytes = Buffer.from([0xff]);
    await fs.writeFile(path.join(root, "a"), bytes);
    await expect(undoFiles(root, [{ path: "a", previous: "old", next: "\ufffd" }])).rejects.toThrow("no longer UTF-8");
    expect(await fs.readFile(path.join(root, "a"))).toEqual(bytes);
  });

  it("rolls back an earlier file if a later file changes during undo", async () => {
    await fs.writeFile(path.join(root, "a"), "new");
    await fs.writeFile(path.join(root, "b"), "new");
    let checks = 0;
    const result = await undoFiles(root, [
      { path: "a", previous: "old", next: "new" }, { path: "b", previous: "old", next: "new" }
    ], async absolute => {
      if (path.basename(absolute) === "b" && ++checks === 2) await fs.writeFile(absolute, "external");
    });
    expect(result.undonePaths).toEqual([]);
    expect(result.error).toContain("No file edits were undone");
    expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("new");
    expect(await fs.readFile(path.join(root, "b"), "utf8")).toBe("external");
    expect((await fs.readdir(root)).sort()).toEqual(["a", "b"]);
  });

  it("does not overwrite newer content even when rolling back a failed batch", async () => {
    await fs.writeFile(path.join(root, "a"), "new");
    await fs.writeFile(path.join(root, "b"), "new");
    let checks = 0;
    const result = await undoFiles(root, [
      { path: "a", previous: "old", next: "new" }, { path: "b", previous: "old", next: "new" }
    ], async absolute => {
      if (path.basename(absolute) === "b" && ++checks === 2) {
        await fs.writeFile(path.join(root, "a"), "external-a");
        await fs.writeFile(absolute, "external-b");
      }
    });
    expect(result.undonePaths).toEqual(["a"]);
    expect(result.error).toContain("Only these files were undone: a");
    expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("external-a");
  });
});
