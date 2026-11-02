import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { noteRevision, type MemoryStore } from "../chat/memoryStore.js";
import type { WorkspaceNote } from "../chat/workspaceNotes.js";
import type { WorkspaceMemory } from "../chat/workspaceMemory.js";

interface MemoryDocument {
  uri: vscode.Uri;
  store: MemoryStore;
  note: WorkspaceNote;
  readonly: boolean;
}

/** Markdown editors keep the version they opened, including when an external edit arrives. */
export class MemoryDocuments implements vscode.FileSystemProvider, vscode.Disposable {
  static readonly scheme = "locality-memory";
  private documents = new Map<string, MemoryDocument>();
  private changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private subscription: { dispose(): void };
  constructor(private memory: WorkspaceMemory) {
    this.subscription = memory.onChange(() => {
      this.changes.fire([...this.documents.values()].filter(entry => entry.readonly)
        .map(({ uri }) => ({ uri, type: vscode.FileChangeType.Changed })));
    });
  }
  async open(id: string, readonly: boolean): Promise<void> {
    const store = this.memory.current();
    if (!store) throw new Error("Open a workspace to access memories.");
    const note = await store.get(id);
    if (store !== this.memory.current()) return;
    const title = note.name.replace(/[\\/:*?"<>|\p{Cc}]/gu, "-").slice(0, 100);
    const uri = vscode.Uri.from({ scheme: MemoryDocuments.scheme, path: "/" + randomUUID() + "/" + title + (readonly ? " (read-only)" : "") + ".md" });
    this.documents.set(uri.toString(), { uri, store, note, readonly });
    const document = await vscode.workspace.openTextDocument(uri);
    if (store !== this.memory.current()) return;
    if (readonly) await vscode.commands.executeCommand("vscode.openWith", document.uri, "vscode.markdown.preview.editor", { preview: false });
    else await vscode.window.showTextDocument(document, { preview: false });
  }
  private async load(uri: vscode.Uri) {
    const entry = this.documents.get(uri.toString());
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    if (entry.store !== this.memory.current()) throw vscode.FileSystemError.NoPermissions("Reopen this memory in the active workspace.");
    const current = await entry.store.get(entry.note.id);
    if (entry.store !== this.memory.current()) throw vscode.FileSystemError.NoPermissions("The active workspace changed.");
    return { entry, note: entry.readonly ? current : entry.note };
  }
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { entry, note } = await this.load(uri);
    return { type: vscode.FileType.File, ctime: note.createdAt, mtime: note.updatedAt, size: Buffer.byteLength(note.contents),
      ...(entry.readonly ? { permissions: vscode.FilePermission.Readonly } : {}) };
  }
  async readFile(uri: vscode.Uri): Promise<Uint8Array> { return Buffer.from((await this.load(uri)).note.contents); }
  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const { entry } = await this.load(uri);
    if (entry.readonly) throw vscode.FileSystemError.NoPermissions("Use Edit memory to make changes.");
    const saved = await entry.store.save({ id: entry.note.id, name: entry.note.name, contents: Buffer.from(content).toString("utf8") }, noteRevision(entry.note));
    entry.note = saved.note;
    this.memory.changed();
  }
  watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }
  readDirectory(): [string, vscode.FileType][] { return []; }
  createDirectory(): never { throw vscode.FileSystemError.NoPermissions(); }
  delete(): never { throw vscode.FileSystemError.NoPermissions(); }
  rename(): never { throw vscode.FileSystemError.NoPermissions(); }
  dispose(): void { this.subscription.dispose(); this.changes.dispose(); this.documents.clear(); }
}
