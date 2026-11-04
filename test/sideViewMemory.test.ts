import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkspaceMemory } from "../src/chat/workspaceMemory.js";
import type { ChatStorage } from "../src/chat/storage.js";
import type { SideToExt, MemoryPanelState } from "../src/ui/messaging.js";
import { MemoryStore, noteRevision } from "../src/chat/memoryStore.js";

vi.mock("vscode", () => ({
  Uri: { joinPath: (...parts: string[]) => parts.join("/") }, commands: { executeCommand: vi.fn() },
  window: { showWarningMessage: vi.fn(async () => "Delete") }
}));
vi.mock("../src/config/settings.js", () => ({
  onSettingsChange: () => ({ dispose() {} }), readSettings: () => ({ endpoint: "invalid", memoryEnabled: true })
}));
import { SideViewProvider } from "../src/ui/sideView/provider.js";

let provider: SideViewProvider, receive: (message: SideToExt) => Promise<void>, storage: ChatStorage | undefined;
const postMessage = vi.fn(), list = vi.fn(), setEnabled = vi.fn(), remove = vi.fn(), save = vi.fn(), get = vi.fn(), changed = vi.fn();
const store = { setEnabled, delete: remove, save, get, list };
let currentStore: Pick<MemoryStore, "setEnabled" | "delete" | "save" | "get" | "list"> | undefined;
const note = { version: 1 as const, id: "12345678-1234-1234-1234-123456789abc", name: "Parser", contents: "Decision", createdAt: 1, updatedAt: 1, enabled: true };
let memories = [note];
const latestPanel = (): MemoryPanelState => postMessage.mock.calls.map(([message]) => message).filter(m => m.type === "memoryPanel").at(-1).panel;
const active = () => { const panel = latestPanel(); return panel.editors.find(e => e.key === panel.activeKey)!; };

beforeEach(() => {
  vi.clearAllMocks(); storage = undefined; currentStore = store; memories = [{ ...note }];
  list.mockImplementation(async () => ({ memories, warnings: [] }));
  get.mockImplementation(async () => memories[0]);
  save.mockImplementation(async input => {
    const updated = { ...memories[0], ...input, id: input.id ?? note.id, updatedAt: 2 };
    memories = [updated]; return { note: updated, operation: input.id ? "updated" : "created" };
  });
  remove.mockImplementation(async id => { memories = memories.filter(note => note.id !== id); });
  provider = new SideViewProvider(
    { subscriptions: [], extensionUri: "/extension", extension: { packageJSON: { version: "1.7.0" } } } as unknown as vscode.ExtensionContext,
    () => storage, vi.fn(), vi.fn(), () => [], { list, current: () => currentStore, changed } as unknown as WorkspaceMemory
  );
  provider.resolveWebviewView({
    webview: { asWebviewUri: (uri: string) => uri, postMessage,
      onDidReceiveMessage: (handler: typeof receive) => { receive = handler; return { dispose() {} }; } },
    onDidDispose: vi.fn(), show: vi.fn()
  } as unknown as vscode.WebviewView);
});

describe("sidebar memory management", () => {
  it("routes chat deletion through the existing command", async () => {
    await receive({ type: "deleteChat", id: "source" });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("locality.deleteChat", "source");
  });
  it("reveals a memory inline in the sidebar instead of opening a document", async () => {
    await provider.revealMemory(note.id);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("locality.side.focus");
    expect(postMessage).toHaveBeenCalledWith({ type: "focusTab", tab: "memories" });
    expect(active()).toMatchObject({ id: note.id, mode: "view", contents: "Decision" });
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("markdown.showPreview", expect.anything());
  });
  it("opens Edit with the current revision and saves inline", async () => {
    await receive({ type: "openMemory", id: note.id, readonly: false }); const key = active().key;
    expect(active()).toMatchObject({ mode: "edit", revision: noteRevision(note) });
    await receive({ type: "memoryDraft", key, contents: "Updated" });
    await receive({ type: "saveMemoryEditor", key });
    expect(save).toHaveBeenCalledWith({ id: note.id, name: note.name, contents: "Updated" }, noteRevision(note));
    expect(active()).toMatchObject({ mode: "view", contents: "Updated" });
    expect(changed).toHaveBeenCalled();
  });
  it("reports an unreadable note inline", async () => {
    get.mockRejectedValueOnce(new Error("Invalid memory record."));
    await receive({ type: "openMemory", id: note.id, readonly: true });
    expect(postMessage).toHaveBeenCalledWith({ type: "memoryError", error: "Invalid memory record." });
  });
  it("refreshes memory rows when entering the tab", async () => {
    await receive({ type: "openTab", tab: "settings" }); expect(list).not.toHaveBeenCalled();
    await receive({ type: "openTab", tab: "memories" });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "memories", memories: [expect.objectContaining(note)] }));
    await receive({ type: "openTab", tab: "settings" }); provider.focusTab("memories");
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });
  it("names new memories before requesting their contents", async () => {
    await receive({ type: "newMemory" }); const key = active().key;
    await receive({ type: "memoryDraft", key, name: "New note" });
    await receive({ type: "saveMemoryEditor", key });
    expect(save).not.toHaveBeenCalled(); expect(active()).toMatchObject({ name: "New note", mode: "edit" });
    await receive({ type: "memoryDraft", key, contents: "New content" });
    await receive({ type: "saveMemoryEditor", key });
    expect(save).toHaveBeenCalledWith({ id: undefined, name: "New note", contents: "New content" }, undefined);
  });
  it("routes enable, inline rename, and confirmed deletion through revision-checked storage", async () => {
    await receive({ type: "openTab", tab: "memories" });
    await receive({ type: "setMemoryEnabled", id: note.id, enabled: false, revision: "revision" });
    expect(setEnabled).toHaveBeenCalledWith(note.id, false, "revision");
    await receive({ type: "renameMemory", id: note.id, revision: "revision" }); const key = active().key;
    expect(active().mode).toBe("name");
    await receive({ type: "memoryDraft", key, name: "Renamed" }); await receive({ type: "saveMemoryEditor", key });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: "Renamed" }), noteRevision(note));
    await receive({ type: "deleteMemory", id: note.id, revision: "current" });
    expect(remove).toHaveBeenCalledWith(note.id, "current");
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    expect(latestPanel().editors).toEqual([]);
  });
  it("confirms clearing all saved memories and drafts, including disabled notes, and refreshes views", async () => {
    const disabled = { ...note, id: "22345678-1234-1234-1234-123456789abc", name: "Disabled", enabled: false };
    memories.push(disabled);
    await receive({ type: "openMemory", id: note.id, readonly: false });
    await receive({ type: "newMemory" });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce("Delete all" as never);
    await receive({ type: "clearMemories" });
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("2 saved memories"), { modal: true }, "Delete all");
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("1 unsaved draft"), { modal: true }, "Delete all");
    expect(remove.mock.calls).toEqual([[note.id, noteRevision(note)], [disabled.id, noteRevision(disabled)]]);
    expect(latestPanel().editors).toEqual([]);
    expect(postMessage).toHaveBeenCalledWith({ type: "memories", memories: [], warnings: [] });
    expect(changed).toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("locality.clearChats");
  });
  it("keeps notes and drafts on cancellation and ignores repeated clear requests during confirmation", async () => {
    await receive({ type: "newMemory" }); const key = active().key;
    let dismiss!: () => void;
    vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(() => new Promise(resolve => { dismiss = () => resolve(undefined); }));
    const clearing = receive({ type: "clearMemories" });
    await vi.waitFor(() => expect(dismiss).toBeDefined());
    await receive({ type: "clearMemories" }); dismiss(); await clearing;
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled(); expect(active().key).toBe(key);
  });
  it("does not delete from either workspace if the workspace changes during confirmation", async () => {
    vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(async () => { currentStore = { ...store }; return "Delete all" as never; });
    await receive({ type: "clearMemories" });
    expect(remove).not.toHaveBeenCalled();
  });
  it("retains failed notes and reports partial failures after refreshing the list", async () => {
    const retained = { ...note, id: "22345678-1234-1234-1234-123456789abc", name: "Changed elsewhere" };
    memories.push(retained);
    await receive({ type: "openTab", tab: "memories" });
    remove.mockImplementation(async id => {
      if (id === retained.id) throw new Error("This memory changed.");
      memories = memories.filter(note => note.id !== id);
    });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce("Delete all" as never);
    await receive({ type: "clearMemories" });
    expect(memories).toEqual([retained]);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "memories", memories: [expect.objectContaining(retained)] }));
    expect(postMessage.mock.calls.at(-1)?.[0]).toEqual({ type: "memoryError", error: expect.stringContaining("Changed elsewhere: This memory changed.") });
  });
  it("clears new drafts even when no notes have been saved", async () => {
    memories = [];
    await receive({ type: "newMemory" });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce("Delete all" as never);
    await receive({ type: "clearMemories" });
    expect(remove).not.toHaveBeenCalled(); expect(latestPanel().editors).toEqual([]);
  });
  it("preserves notes edited or created in another window while confirmation is open", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "locality-clear-memories-"));
    try {
      const realStore = new MemoryStore(root); currentStore = realStore;
      list.mockImplementation(() => realStore.list());
      const original = (await realStore.save({ name: "Original", contents: "Before" })).note;
      await realStore.save({ name: "Unchanged", contents: "Delete this note" });
      vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(async () => {
        const otherWindow = new MemoryStore(root);
        await otherWindow.save({ ...original, contents: "Changed elsewhere" }, noteRevision(original));
        await otherWindow.save({ name: "Created later", contents: "Preserve this new note" });
        return "Delete all" as never;
      });
      await receive({ type: "clearMemories" });
      expect((await realStore.list()).memories.map(note => note.name).sort()).toEqual(["Created later", "Original"]);
      expect((await realStore.get(original.id)).contents).toBe("Changed elsewhere");
      expect(postMessage).toHaveBeenCalledWith({ type: "memoryError", error: expect.stringContaining("Original: This memory changed") });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
