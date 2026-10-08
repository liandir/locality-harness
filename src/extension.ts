import { WorkspaceMemory } from "./chat/workspaceMemory.js";
import * as vscode from "vscode";
import { SideViewProvider } from "./ui/sideView/provider.js";
import { ChatViewProvider } from "./ui/chatView/provider.js";
import { ChatStorage } from "./chat/storage.js";
import type { ChatRecord } from "./chat/types.js";
import { readSettings, onSettingsChange } from "./config/settings.js";
import { CommitMessageController } from "./scm/commitMessage.js";
import {
  availableReasoningEffort,
  normalizeReasoningEffort,
  WORKSPACE_REASONING_EFFORT_KEY
} from "./chat/reasoningEffort.js";

let sideProvider: SideViewProvider;
let chatProvider: ChatViewProvider;
let storage: ChatStorage | undefined;
let memory: WorkspaceMemory;
let storageWatcher: { dispose(): void } | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  let ws = currentWorkspaceRoot();
  if (ws) storage = new ChatStorage(ws);
  memory = new WorkspaceMemory(() => storage);

  chatProvider = new ChatViewProvider(
    context,
    () => storage,
    () => currentWorkspaceRoot(),
    (tab) => sideProvider.focusTab(tab),
    () => sideProvider.refreshOpenTabs(),
    () => newChat(context),
    () => {
      sideProvider.refreshOpenTabs();
      sideProvider.pushReasoningEffort();
      void sideProvider.pushChats();
      void chatProvider.pushRecentChats();
    },
    memory,
    id => sideProvider.revealMemory(id)
  );

  sideProvider = new SideViewProvider(
    context,
    () => storage,
    () => void newChat(context),
    (id) => void openChatById(id),
    () => chatProvider.getTabs(),
    memory,
    () => chatProvider.pushSettings(),
    {
      get: () => chatProvider.getReasoningEffort(),
      set: effort => chatProvider.setReasoningEffort(effort)
    }
  );
  watchStorage();
  context.subscriptions.push(
    memory,
    { dispose: () => storageWatcher?.dispose() },
    { dispose: () => { void chatProvider.closeAll(); } },
    onSettingsChange(() => memory.settingsChanged()),
    memory.onChange(() => { void sideProvider.pushMemories(); chatProvider.refreshMemoryVisibility(); }),
    new CommitMessageController(() => currentWorkspaceRoot()),
    vscode.window.registerWebviewViewProvider(SideViewProvider.viewType, sideProvider),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider),

    vscode.commands.registerCommand("locality.newChat", () => newChat(context)),
    vscode.commands.registerCommand("locality.openChat", (id?: string) => id ? openChatById(id) : undefined),
    vscode.commands.registerCommand("locality.renameChat", (id: string) => chatProvider.renameChat(id)),
    vscode.commands.registerCommand("locality.deleteChat", (id?: string) => deleteChat(id)),
    vscode.commands.registerCommand("locality.clearChats", () => clearChats()),
    vscode.commands.registerCommand("locality.rebuildChatIndex", async () => {
      const target = storage;
      if (!target) return;
      try {
        const count = await target.rebuildWorkspaceIndex();
        if (target !== storage) return;
        await refreshChatLists();
        void vscode.window.showInformationMessage(`Locality: rebuilt the workspace index (${count} chats).`);
      } catch (error) {
        void vscode.window.showErrorMessage(`Locality: could not rebuild the chat index. ${(error as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("locality.openSettings", () => {
      sideProvider.focusTab("settings");
      return vscode.commands.executeCommand("workbench.view.extension.locality");
    }),
    vscode.commands.registerCommand("locality.togglePlanMode", () => chatProvider.togglePlanMode()),
    vscode.commands.registerCommand("locality.compactNow", () => chatProvider.compactNow()),

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const r = currentWorkspaceRoot();
      if (r === ws) return;
      ws = r;
      memory.reset();
      void chatProvider.closeAll();
      storage = r ? new ChatStorage(r) : undefined;
      watchStorage();
      chatProvider.pushSettings();
      void chatProvider.pushRecentChats();
      void sideProvider.pushChats();
      sideProvider.refreshOpenTabs();
      void sideProvider.pushMemories();
    })
  );
}

export function deactivate(): void { /* noop */ }

async function refreshChatLists(): Promise<void> {
  await Promise.all([sideProvider.pushChats(), chatProvider.pushRecentChats(), sideProvider.pushMemories()]);
}

function watchStorage(): void {
  storageWatcher?.dispose();
  const target = storage;
  storageWatcher = target?.watch(() => { if (target === storage) void refreshChatLists(); });
}

function currentWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return folders[0].uri.fsPath;
}

async function newChat(context: vscode.ExtensionContext): Promise<ChatRecord | undefined> {
  if (chatProvider.isClearingWorkspace()) return undefined;
  if (!storage) {
    vscode.window.showWarningMessage("Locality: open a folder first.");
    return undefined;
  }
  // If the chat view already shows an empty chat, reuse it instead of creating a duplicate.
  const current = chatProvider.getCurrentRecord();
  if (current && current.messages.length === 0) {
    chatProvider.reveal();
    return current;
  }
  const settings = readSettings();
  const reasoningEffort = availableReasoningEffort(normalizeReasoningEffort(
    context.workspaceState.get<unknown>(WORKSPACE_REASONING_EFFORT_KEY)
  ), settings.reasoningEfforts);
  const targetStorage = storage;
  const rec = targetStorage.newRecord(settings.toolCallingMode, reasoningEffort);
  await targetStorage.save(rec);
  if (targetStorage !== storage) return undefined;
  await sideProvider.pushChats();
  if (targetStorage !== storage) return undefined;
  chatProvider.openChat(rec);
  return rec;
}

async function openChatById(id: string): Promise<void> {
  if (!storage) return;
  await chatProvider.openChatById(id);
}

async function deleteChat(id?: string): Promise<void> {
  if (!storage) return;
  const targetStorage = storage;
  const targetId = id ?? chatProvider.getCurrentRecord()?.id;
  if (!targetId) return;
  const rec = (await targetStorage.metadata(true)).find(chat => chat.id === targetId);
  // Only prompt for non-empty chats — empty ones aren't worth confirming.
  if (rec && rec.messageCount > 0) {
    const choice = await vscode.window.showWarningMessage(
      `Delete chat "${rec.title}"? This cannot be undone.`,
      { modal: true },
      "Delete"
    );
    if (choice !== "Delete") return;
  }
  if (targetStorage !== storage) return;
  await chatProvider.removeChat(targetId);
  void sideProvider.pushMemories();
  chatProvider.refreshMemoryVisibility();
  await sideProvider.pushChats();
  sideProvider.refreshOpenTabs();
}

async function clearChats(): Promise<void> {
  if (!storage) return;
  const targetStorage = storage;
  const chats = await targetStorage.list();
  if (chats.length === 0) return;
  const chatLabel = chats.length === 1 ? "chat" : "chats";
  const choice = await vscode.window.showWarningMessage(
    `Delete all ${chats.length} ${chatLabel} for this workspace? This includes the currently open chat and cannot be undone.`,
    { modal: true },
    "Delete all"
  );
  if (choice !== "Delete all" || targetStorage !== storage) return;
  memory.reset();
  await chatProvider.clearChats();
  void sideProvider.pushMemories();
  await sideProvider.pushChats();
  sideProvider.refreshOpenTabs();
}
