import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { WorkspaceMemory } from "../src/chat/workspaceMemory.js";
import type { ChatStorage } from "../src/chat/storage.js";
import type { SideToExt } from "../src/ui/messaging.js";

const editor = vi.hoisted(() => ({ open: vi.fn(), register: vi.fn(), error: vi.fn() }));
vi.mock("../src/ui/memoryDocuments.js", () => ({
  MemoryDocuments: class {
    static scheme = "locality-memory";
    open = editor.open;
  }
}));
vi.mock("vscode", () => ({
  Uri: { joinPath: (...parts: string[]) => parts.join("/") }, commands: { executeCommand: vi.fn() },
  workspace: { registerFileSystemProvider: editor.register }, window: { showErrorMessage: editor.error, showInputBox: vi.fn(async () => "Renamed"), showWarningMessage: vi.fn(async () => "Delete") }
}));
vi.mock("../src/config/settings.js", () => ({
  onSettingsChange: () => ({ dispose() {} }),
  readSettings: () => ({ endpoint: "invalid", memoryEnabled: true })
}));
import { SideViewProvider } from "../src/ui/sideView/provider.js";

let provider: SideViewProvider;
let receive: (message: SideToExt) => Promise<void>;
let storage: ChatStorage | undefined;
const postMessage = vi.fn();
const list = vi.fn();
const setEnabled = vi.fn();
const remove = vi.fn();
const save = vi.fn();
const get = vi.fn();
const changed = vi.fn();
const store = { setEnabled, delete: remove, save, get };
const memories = [{ version: 1 as const, id: "12345678-1234-1234-1234-123456789abc", name: "Parser", contents: "Decision", createdAt: 1, updatedAt: 1, enabled: true }];

beforeEach(() => {
  vi.clearAllMocks();
  storage = undefined;
  list.mockResolvedValue({ memories, warnings: [] });
  get.mockResolvedValue(memories[0]);
  provider = new SideViewProvider(
    { subscriptions: [], extensionUri: "/extension", extension: { packageJSON: { version: "1.7.0" } } } as unknown as vscode.ExtensionContext,
    () => storage, vi.fn(), vi.fn(), () => [],
    { list, current: () => store, changed } as unknown as WorkspaceMemory
  );
  provider.resolveWebviewView({
    webview: {
      asWebviewUri: (uri: string) => uri,
      postMessage,
      onDidReceiveMessage: (handler: typeof receive) => { receive = handler; return { dispose() {} }; }
    },
    onDidDispose: vi.fn(), show: vi.fn()
  } as unknown as vscode.WebviewView);
});

describe("Recent Chats memory management", () => {
  it("routes deletion through the existing chat deletion command", async () => {
    await receive({ type: "deleteChat", id: "source" });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("locality.deleteChat", "source");
  });

  it("routes View to the read-only memory preview without waiting for the sidebar", async () => {
    await provider.revealMemory("source");
    expect(editor.open).toHaveBeenCalledWith("source", true);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("routes Edit and View to the shared memory documents and registers their provider only once", async () => {
    await receive({ type: "openMemory", id: "source", readonly: false });
    await receive({ type: "openMemory", id: "source", readonly: true });
    expect(editor.open.mock.calls).toEqual([["source", false], ["source", true]]);
    expect(editor.register).toHaveBeenCalledOnce();
  });

  it("reports an editor opening failure", async () => {
    editor.open.mockRejectedValueOnce(new Error("Chat is no longer available."));
    await receive({ type: "openMemory", id: "source", readonly: true });
    expect(editor.error).toHaveBeenCalledWith("Chat is no longer available.");
  });

  it("loads memories when entering Chats, including after returning from Settings", async () => {
    await receive({ type: "openTab", tab: "settings" });
    expect(list).not.toHaveBeenCalled();
    await receive({ type: "openTab", tab: "memories" });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "memories", memories: [expect.objectContaining(memories[0])] }));
    await receive({ type: "openTab", tab: "settings" });
    provider.focusTab("memories");
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("routes all management actions and refreshes the chat memory controls", async () => {
    await receive({ type: "openTab", tab: "memories" });
    await receive({ type: "setMemoryEnabled", id: "source", enabled: false, revision: "revision" });
    await receive({ type: "renameMemory", id: "source", revision: "revision" });
    await receive({ type: "deleteMemory", id: "source", revision: "revision" });
    expect(setEnabled).toHaveBeenCalledWith("source", false, "revision");
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: "Renamed" }), "revision");
    expect(remove).toHaveBeenCalledWith(memories[0].id, "revision");
    expect(list).toHaveBeenCalledTimes(4);
  });
});
