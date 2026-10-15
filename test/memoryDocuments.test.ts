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
vi.mock("../src/config/settings.js", () => ({ readSettings: () => ({ endpoint: "http://127.0.0.1:8080", model: "test" }) }));
vi.mock("../src/llm/client.js", () => ({ tokenize: vi.fn(async (_endpoint, text: string) => Math.ceil(text.length / 4)) }));
import { ChatStorage } from "../src/chat/storage.js";
import { WorkspaceMemory } from "../src/chat/workspaceMemory.js";
import { MemoryDocuments } from "../src/ui/memoryDocuments.js";

let dir: string;
let storage: ChatStorage;
let memory: WorkspaceMemory;
let documents: MemoryDocuments;
let id: string;
const openedUri = () => vi.mocked(vscode.workspace.openTextDocument).mock.calls.at(-1)![0] as vscode.Uri;

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "locality-memory-editor-"));
  storage = new ChatStorage(path.join(dir, "workspace"), path.join(dir, "chats"));
  memory = new WorkspaceMemory(() => storage);
  documents = new MemoryDocuments(() => storage, memory);
  const record = storage.newRecord("native");
  record.title = "Parser / decisions";
  record.messages = [{ role: "user", content: "Parser", ts: 1 }, { role: "assistant", content: "Done", ts: 2 }];
  await storage.save(record);
  id = record.id;
});
afterEach(async () => { documents.dispose(); memory.dispose(); await fs.rm(dir, { recursive: true, force: true }); });

describe("memory Markdown editors", () => {
  it("opens an editable Markdown document and saves validated memory to its source chat", async () => {
    await memory.edit(id, "# Existing decision");
    await memory.setEnabled(id, true);
    await documents.open(id, false);
    const uri = openedUri();
    expect(uri.path).toMatch(/Parser - decisions — Memory\.md$/);
    expect((await documents.stat(uri)).permissions).toBeUndefined();
    expect(Buffer.from(await documents.readFile(uri)).toString()).toBe("# Existing decision");
    await documents.writeFile(uri, Buffer.from("# Updated decision\n\nKeep the parser strict."));
    expect((await storage.load(id))?.memory).toMatchObject({ text: "# Updated decision\n\nKeep the parser strict.", manual: true, enabled: true });
    await documents.open(id, false);
    expect(openedUri()).toBe(uri);
    expect(vscode.window.showTextDocument).toHaveBeenLastCalledWith({ uri }, { preview: false });
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it("opens View as a read-only Markdown preview and refreshes both views after memory changes", async () => {
    await memory.edit(id, "Saved memory");
    await documents.open(id, false);
    const editable = openedUri();
    vi.mocked(vscode.window.showTextDocument).mockClear();
    await documents.open(id, true);
    const readonly = openedUri();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("vscode.openWith", readonly, "vscode.markdown.preview.editor", { preview: false });
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
    expect((await documents.stat(readonly)).permissions).toBe(vscode.FilePermission.Readonly);
    await expect(documents.writeFile(readonly, Buffer.from("Unwanted edit"))).rejects.toThrow("Use Edit memory");
    const changed = vi.fn();
    documents.onDidChangeFile(changed);
    await memory.edit(id, "Replacement memory");
    expect(changed).toHaveBeenCalledWith([
      { uri: editable, type: vscode.FileChangeType.Changed }, { uri: readonly, type: vscode.FileChangeType.Changed }
    ]);
    expect(Buffer.from(await documents.readFile(readonly)).toString()).toBe("Replacement memory");
  });

  it("allows creating a manual memory but rejects empty or oversized saves", async () => {
    await expect(documents.open(id, true)).rejects.toThrow("no memory yet");
    await documents.open(id, false);
    const uri = openedUri();
    expect((await documents.readFile(uri)).length).toBe(0);
    await expect(documents.writeFile(uri, Buffer.from(" "))).rejects.toThrow("non-empty memory");
    await expect(documents.writeFile(uri, Buffer.from("a".repeat(21000)))).rejects.toThrow("too long");
    await documents.writeFile(uri, Buffer.from("New manual memory"));
    expect((await storage.load(id))?.memory).toMatchObject({ text: "New manual memory", manual: true, enabled: false });
  });

  it("rejects deleted sources and never recreates their memory on save", async () => {
    await documents.open(id, false);
    const uri = openedUri();
    await storage.delete(id);
    await expect(documents.readFile(uri)).rejects.toThrow("File not found");
    await expect(documents.writeFile(uri, Buffer.from("Late edit"))).rejects.toThrow("File not found");
    expect(await storage.load(id)).toBeUndefined();
  });

  it("keeps open editors tied to their original workspace", async () => {
    await memory.edit(id, "Original memory");
    await documents.open(id, false);
    const uri = openedUri();
    const originalStorage = storage;
    storage = new ChatStorage(path.join(dir, "other-workspace"), path.join(dir, "chats"));
    await expect(documents.readFile(uri)).rejects.toThrow("Switch back");
    await expect(documents.writeFile(uri, Buffer.from("Wrong workspace"))).rejects.toThrow("Switch back");
    await expect(documents.open(id, false)).rejects.toThrow("no longer available");
    expect((await originalStorage.load(id))?.memory?.text).toBe("Original memory");
  });

  it("does not display a document if the workspace switches while it opens", async () => {
    let finish!: (document: vscode.TextDocument) => void;
    vi.mocked(vscode.workspace.openTextDocument).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const opening = documents.open(id, false);
    await vi.waitFor(() => expect(finish).toBeDefined());
    storage = new ChatStorage(path.join(dir, "other-workspace"), path.join(dir, "chats"));
    finish({ uri: openedUri() } as vscode.TextDocument);
    await opening;
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });
});
