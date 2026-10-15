import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { ChatStorage } from "../chat/storage.js";
import type { WorkspaceMemory } from "../chat/workspaceMemory.js";

interface MemoryDocument {
  uri: vscode.Uri;
  storage: ChatStorage;
  id: string;
  readonly: boolean;
}

/** Markdown editors backed by chat memory, with normal editor Save support. */
export class MemoryDocuments implements vscode.FileSystemProvider, vscode.Disposable {
  static readonly scheme = "locality-memory";
  private documents = new Map<string, MemoryDocument>();
  private changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private subscription: { dispose(): void };

  constructor(private getStorage: () => ChatStorage | undefined, private memory: WorkspaceMemory) {
    this.subscription = memory.onChange(() => {
      this.changes.fire([...this.documents.values()].map(({ uri }) => ({ uri, type: vscode.FileChangeType.Changed })));
    });
  }

  async open(id: string, readonly: boolean): Promise<void> {
    const storage = this.getStorage();
    const record = await storage?.load(id);
    if (!storage || !record || storage !== this.getStorage()) throw new Error("This chat is no longer available in the active workspace.");
    if (readonly && !record.memory?.text.trim()) throw new Error("This chat has no memory yet. Use Edit memory or Regenerate memory to create one.");
    let entry = [...this.documents.values()].find(item => item.storage === storage && item.id === id && item.readonly === readonly);
    if (!entry) {
      const title = record.title.replace(/[\\/:*?"<>|\p{Cc}]/gu, "-").slice(0, 100) || "Chat";
      const uri = vscode.Uri.from({ scheme: MemoryDocuments.scheme, path: `/${randomUUID()}/${title} — Memory${readonly ? " (read-only)" : ""}.md` });
      entry = { uri, storage, id, readonly };
      this.documents.set(uri.toString(), entry);
    }
    const document = await vscode.workspace.openTextDocument(entry.uri);
    if (storage !== this.getStorage()) return;
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private async load(uri: vscode.Uri) {
    const entry = this.documents.get(uri.toString());
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    if (entry.storage !== this.getStorage()) throw vscode.FileSystemError.NoPermissions("Switch back to this memory's workspace to access it.");
    const record = await entry.storage.load(entry.id);
    if (entry.storage !== this.getStorage()) throw vscode.FileSystemError.NoPermissions("The active workspace changed.");
    if (!record) throw vscode.FileSystemError.FileNotFound(uri);
    return { entry, record };
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { entry, record } = await this.load(uri);
    return {
      type: vscode.FileType.File, ctime: record.createdAt,
      mtime: record.memory?.generatedAt || record.updatedAt,
      size: Buffer.byteLength(record.memory?.text ?? ""),
      ...(entry.readonly ? { permissions: vscode.FilePermission.Readonly } : {})
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { record } = await this.load(uri);
    return Buffer.from(record.memory?.text ?? "");
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const { entry } = await this.load(uri);
    if (entry.readonly) throw vscode.FileSystemError.NoPermissions("Use Edit memory to make changes.");
    await this.memory.edit(entry.id, Buffer.from(content).toString("utf8"), entry.storage);
  }

  watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }
  readDirectory(): [string, vscode.FileType][] { return []; }
  createDirectory(): never { throw vscode.FileSystemError.NoPermissions(); }
  delete(): never { throw vscode.FileSystemError.NoPermissions(); }
  rename(): never { throw vscode.FileSystemError.NoPermissions(); }
  dispose(): void { this.subscription.dispose(); this.changes.dispose(); this.documents.clear(); }
}
