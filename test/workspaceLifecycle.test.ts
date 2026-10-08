import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const mocks = vi.hoisted(() => ({
  folders: [{ uri: { fsPath: "/workspace/a" } }, { uri: { fsPath: "/workspace/b" } }],
  changed: undefined as (() => void) | undefined,
  closeAll: vi.fn(),
  pushSettings: vi.fn(),
  pushChats: vi.fn(),
  pushRecentChats: vi.fn(),
  watcherDisposed: vi.fn(),
  watchers: [] as (() => void)[],
  rebuild: vi.fn().mockResolvedValue(3),
  commands: new Map<string, () => Promise<void>>(),
  refreshOpenTabs: vi.fn(),
  storageRoots: [] as string[]
}));
vi.mock("vscode", () => ({
  workspace: {
    get workspaceFolders() { return mocks.folders; },
    onDidChangeWorkspaceFolders: (handler: () => void) => { mocks.changed = handler; return { dispose() {} }; }
  },
  window: { registerWebviewViewProvider: vi.fn(), showInformationMessage: vi.fn(), showErrorMessage: vi.fn() },
  commands: { registerCommand: (name: string, handler: () => Promise<void>) => { mocks.commands.set(name, handler); } }
}));
vi.mock("../src/config/settings.js", () => ({ onSettingsChange: vi.fn(() => ({ dispose() {} })) }));
vi.mock("../src/scm/commitMessage.js", () => ({ CommitMessageController: class {} }));
vi.mock("../src/chat/storage.js", () => ({
  ChatStorage: class {
    constructor(root: string) { mocks.storageRoots.push(root); }
    watch(onChange: () => void) { mocks.watchers.push(onChange); return { dispose: mocks.watcherDisposed }; }
    rebuildWorkspaceIndex = mocks.rebuild;
  }
}));
vi.mock("../src/ui/chatView/provider.js", () => ({
  ChatViewProvider: class {
    closeAll = mocks.closeAll;
    pushSettings = mocks.pushSettings;
    pushRecentChats = mocks.pushRecentChats;
    refreshMemoryVisibility = vi.fn();
  }
}));
vi.mock("../src/ui/sideView/provider.js", () => ({
  SideViewProvider: class {
    pushChats = mocks.pushChats;
    pushMemories = vi.fn();
    refreshOpenTabs = mocks.refreshOpenTabs;
  }
}));
import { activate } from "../src/extension.js";

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.storageRoots = [];
  mocks.watchers = [];
  mocks.folders = [{ uri: { fsPath: "/workspace/a" } }, { uri: { fsPath: "/workspace/b" } }];
  await activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
  mocks.watcherDisposed.mockClear();
});

describe("workspace folder lifecycle", () => {
  it("rebuilds the active workspace index and refreshes both chat lists", async () => {
    await mocks.commands.get("locality.rebuildChatIndex")!();
    expect(mocks.rebuild).toHaveBeenCalledOnce();
    expect(mocks.pushChats).toHaveBeenCalledOnce();
    expect(mocks.pushRecentChats).toHaveBeenCalledOnce();
  });

  it("ignores old workspace watcher notifications after switching folders", () => {
    const old = mocks.watchers[0];
    mocks.folders.shift(); mocks.changed!();
    mocks.pushChats.mockClear(); mocks.pushRecentChats.mockClear();
    old();
    expect(mocks.pushChats).not.toHaveBeenCalled();
    mocks.watchers[1]();
    expect(mocks.pushChats).toHaveBeenCalledOnce();
    expect(mocks.pushRecentChats).toHaveBeenCalledOnce();
  });

  it("closes the old chat and refreshes views when the active root is replaced", () => {
    mocks.folders.shift();
    mocks.changed!();
    expect(mocks.storageRoots).toEqual(["/workspace/a", "/workspace/b"]);
    expect(mocks.closeAll).toHaveBeenCalledOnce();
    expect(mocks.pushSettings).toHaveBeenCalledOnce();
    expect(mocks.pushChats).toHaveBeenCalledOnce();
    expect(mocks.refreshOpenTabs).toHaveBeenCalledOnce();
    expect(mocks.pushRecentChats).toHaveBeenCalledOnce();
    expect(mocks.watcherDisposed).toHaveBeenCalledOnce();
  });

  it("closes the chat when all folders are removed", () => {
    mocks.folders = [];
    mocks.changed!();
    expect(mocks.storageRoots).toEqual(["/workspace/a"]);
    expect(mocks.closeAll).toHaveBeenCalledOnce();
    expect(mocks.pushSettings).toHaveBeenCalledOnce();
    expect(mocks.pushChats).toHaveBeenCalledOnce();
  });

  it("preserves the active session when unrelated folders change", () => {
    mocks.folders.pop();
    mocks.changed!();
    expect(mocks.storageRoots).toEqual(["/workspace/a"]);
    expect(mocks.closeAll).not.toHaveBeenCalled();
    expect(mocks.pushSettings).not.toHaveBeenCalled();
  });
});
