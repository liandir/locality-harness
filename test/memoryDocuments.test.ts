import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

vi.mock("vscode", () => ({
  Uri: { from: (value: { scheme: string; path: string }) => ({ ...value, toString: () => `${value.scheme}:${value.path}` }) },
  EventEmitter: class {
    private listeners = new Set<(value: unknown) => void>();
    event = (listener: (value: unknown) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(value: unknown) { this.listeners.forEach(listener => listener(value)); }
    dispose() { this.listeners.clear(); }
  },
  Disposable: class { constructor(public dispose: () => void) {} },
  FileType: { File: 1 }, FilePermission: { Readonly: 1 }, FileChangeType: { Changed: 1 },
  FileSystemError: {
    FileNotFound: () => new Error("File not found"),
    NoPermissions: (message = "No permissions") => new Error(message)
  },
  workspace: { openTextDocument: vi.fn(async uri => ({ uri })) },
  commands: { executeCommand: vi.fn() },
  window: { showTextDocument: vi.fn() }
}));
import { WorkspaceMemory } from "../src/chat/workspaceMemory.js";
import { MemoryDocuments } from "../src/ui/memoryDocuments.js";
import { noteRevision } from "../src/chat/memoryStore.js";
let dir: string, root: string, memory: WorkspaceMemory, documents: MemoryDocuments, id: string;
const openedUri = () => vi.mocked(vscode.workspace.openTextDocument).mock.calls.at(-1)![0] as vscode.Uri;
beforeEach(async () => {
  vi.clearAllMocks(); dir = await fs.mkdtemp(path.join(os.tmpdir(), "locality-memory-editor-")); root = dir;
  memory = new WorkspaceMemory(() => root); documents = new MemoryDocuments(memory);
  id = (await memory.current()!.save({ name: "Parser / decisions", contents: "# Existing decision" })).note.id;
});
afterEach(async () => { documents.dispose(); memory.dispose(); await fs.rm(dir, { recursive: true, force: true }); });
describe("workspace Markdown editors", () => {
  it("saves Markdown through the note store without model requests", async () => {
    await documents.open(id, false); const uri = openedUri();
    expect(uri.path).toContain("Parser - decisions.md");
    expect(Buffer.from(await documents.readFile(uri)).toString()).toBe("# Existing decision");
    await documents.writeFile(uri, Buffer.from("# Updated decision"));
    expect((await memory.current()!.get(id)).contents).toBe("# Updated decision");
    await documents.writeFile(uri, Buffer.from("Another update"));
    expect((await memory.current()!.get(id)).contents).toBe("Another update");
  });
  it("refreshes previews but keeps dirty editors tied to their opened version", async () => {
    await documents.open(id, false); const editable = openedUri();
    await documents.open(id, true); const preview = openedUri();
    expect((await documents.stat(preview)).permissions).toBe(vscode.FilePermission.Readonly);
    await expect(documents.writeFile(preview, Buffer.from("Forbidden"))).rejects.toThrow("Use Edit memory");
    const store = memory.current()!, note = await store.get(id);
    await store.save({ ...note, contents: "External correction" }, noteRevision(note)); memory.changed();
    expect(Buffer.from(await documents.readFile(preview)).toString()).toBe("External correction");
    expect(Buffer.from(await documents.readFile(editable)).toString()).toBe("# Existing decision");
    await expect(documents.writeFile(editable, Buffer.from("Stale draft"))).rejects.toThrow("Recall");
    await documents.open(id, false); await documents.writeFile(openedUri(), Buffer.from("Reviewed correction"));
    expect((await store.get(id)).contents).toBe("Reviewed correction");
  });
  it("rejects empty, oversized, deleted, and wrong-workspace saves", async () => {
    await documents.open(id, false); const uri = openedUri();
    await expect(documents.writeFile(uri, Buffer.from(" "))).rejects.toThrow("Memory contents");
    await expect(documents.writeFile(uri, Buffer.from("a".repeat(20001)))).rejects.toThrow("Memory contents");
    root = path.join(dir, "other"); await fs.mkdir(root);
    await expect(documents.writeFile(uri, Buffer.from("Wrong workspace"))).rejects.toThrow("active workspace");
    root = dir;
    await documents.open(id, false); const current = openedUri();
    await memory.current()!.delete(id, noteRevision(await memory.current()!.get(id)));
    await expect(documents.writeFile(current, Buffer.from("Late save"))).rejects.toThrow("no longer exists");
  });
});
