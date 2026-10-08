import * as fs from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fingerprint, sameFile, validChatHeader, writeAtomic, type ChatHeader, type FileFingerprint, type IndexedChat } from "./chatFile.js";
import { isValidChatId } from "./storagePaths.js";
import { withStorageLock } from "./storageLock.js";

interface WorkspaceIndex { version: 1; workspaceRoot: string; chats: IndexedChat[] }

/** The index is disposable; chat headers always own the metadata. */
export class WorkspaceChatIndex {
  readonly file: string;
  private cache?: { file: FileFingerprint; value: WorkspaceIndex };
  private pending?: Promise<ChatHeader[]>;
  private generation = 0;

  constructor(
    private root: string,
    private workspaceRoot: string,
    private readHeader: (id: string) => Promise<IndexedChat | undefined>
  ) {
    this.file = path.join(root, "indexes", createHash("sha256").update(workspaceRoot).digest("hex") + ".json");
  }

  async list(): Promise<ChatHeader[]> {
    if (!this.pending) {
      const generation = this.generation;
      const pending = this.read().then(index => index ?? this.rebuild());
      this.pending = pending.then(index => index.chats.map(chat => chat.header));
      const current = this.pending;
      void current.finally(() => {
        if (generation === this.generation && this.pending === current) this.pending = undefined;
      }).catch(() => undefined);
    }
    // Callers must not mutate metadata shared by the two webviews.
    return structuredClone(await this.pending);
  }

  private invalidate(): void {
    this.generation++;
    this.cache = undefined;
    this.pending = undefined;
  }

  private async read(): Promise<WorkspaceIndex | undefined> {
    try {
      const current = fingerprint(await fs.stat(this.file));
      if (this.cache && sameFile(this.cache.file, current)) return this.cache.value;
      const handle = await fs.open(this.file, "r");
      try {
        const value: unknown = JSON.parse(await handle.readFile("utf8"));
        if (!this.validIndex(value)) return undefined;
        this.cache = { value, file: fingerprint(await handle.stat()) };
        return value;
      } finally { await handle.close(); }
    } catch { return undefined; }
  }

  private validIndex(value: unknown): value is WorkspaceIndex {
    if (!value || typeof value !== "object") return false;
    const index = value as WorkspaceIndex;
    if (index.version !== 1 || index.workspaceRoot !== this.workspaceRoot || !Array.isArray(index.chats)) return false;
    const ids = new Set<string>();
    return index.chats.every(chat => {
      if (!chat || !validChatHeader(chat.header) || chat.header.workspaceRoot !== this.workspaceRoot
        || ids.has(chat.header.id) || !chat.file || ![chat.file.size, chat.file.mtimeMs, chat.file.ctimeMs, chat.file.ino].every(Number.isFinite)) return false;
      ids.add(chat.header.id);
      return true;
    });
  }

  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    return withStorageLock(this.file + ".lock", task);
  }

  /** Hold the workspace lock across the record change and index replacement. */
  async change<T>(id: string, task: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      this.invalidate();
      try {
        const result = await task();
        const index = await this.read() ?? await this.scan();
        const entry = await this.readHeader(id).catch(() => undefined);
        index.chats = index.chats.filter(chat => chat.header.id !== id);
        if (entry?.header.workspaceRoot === this.workspaceRoot) index.chats.push(entry);
        await this.persist(index);
        return result;
      } catch (error) {
        // The record may already have been replaced. Never leave a trusted stale index.
        await fs.unlink(this.file).catch(() => undefined);
        throw error;
      } finally { this.invalidate(); }
    });
  }

  async rebuild(): Promise<WorkspaceIndex> {
    return this.exclusive(async () => {
      this.invalidate();
      const index = await this.scan();
      await this.persist(index);
      return index;
    });
  }

  /** Repair missed/crashed/external writes using only fingerprints and headers. */
  async reconcile(): Promise<boolean> {
    return this.exclusive(async () => {
      const previous = await this.read();
      const next = await this.scan(previous);
      if (JSON.stringify(previous) === JSON.stringify(next)) return false;
      this.invalidate();
      await this.persist(next);
      return true;
    });
  }

  private async scan(previous?: WorkspaceIndex): Promise<WorkspaceIndex> {
    const files = (await fs.readdir(this.root)).filter(file => file.endsWith(".json") && isValidChatId(file.slice(0, -5)));
    const known = new Map(previous?.chats.map(chat => [chat.header.id, chat]));
    const chats: IndexedChat[] = [];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
      while (cursor < files.length) {
        const file = files[cursor++];
        const id = file.slice(0, -5);
        try {
          const cached = known.get(id);
          const stat = await fs.stat(path.join(this.root, file));
          if (!stat.isFile()) continue;
          const entry = cached && sameFile(cached.file, fingerprint(stat)) ? cached : await this.readHeader(id);
          if (entry?.header.workspaceRoot === this.workspaceRoot) chats.push(entry);
        } catch { /* Keep other chats available when a header is unreadable. */ }
      }
    }));
    chats.sort((a, b) => b.header.updatedAt - a.header.updatedAt || a.header.id.localeCompare(b.header.id));
    return { version: 1, workspaceRoot: this.workspaceRoot, chats };
  }

  private async persist(index: WorkspaceIndex): Promise<void> {
    index.chats.sort((a, b) => b.header.updatedAt - a.header.updatedAt || a.header.id.localeCompare(b.header.id));
    await writeAtomic(this.file, JSON.stringify(index));
    this.cache = { value: index, file: fingerprint(await fs.stat(this.file)) };
  }

  /** Refresh views after other windows or external tools change stored chats. */
  watch(onChange: () => void): { dispose(): void } {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let needsScan = false;
    const watchers: FSWatcher[] = [];
    const schedule = (scan: boolean): void => {
      needsScan ||= scan;
      if (disposed || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        const scanNow = needsScan;
        needsScan = false;
        void (async () => {
          if (scanNow) await this.reconcile();
          else this.invalidate();
          if (!disposed) onChange();
        })().catch(() => { /* Explicit rebuild remains available on I/O failure. */ });
      }, 250);
      timer.unref();
    };
    void fs.mkdir(path.dirname(this.file), { recursive: true }).then(() => {
      if (disposed) return;
      for (const directory of [this.root, path.dirname(this.file)]) {
        const watcher = watch(directory, (_event, filename) => {
          if (!filename) { schedule(true); return; }
          const name = filename.toString();
          if (directory === this.root && name.endsWith(".json") && isValidChatId(name.slice(0, -5))) schedule(true);
          else if (directory !== this.root && name === path.basename(this.file)) schedule(false);
        });
        watcher.on("error", () => watcher.close());
        watchers.push(watcher);
      }
      // Let the valid index paint first, then catch changes missed while VS Code was closed.
      schedule(true);
    }).catch(() => undefined);
    return { dispose: () => { disposed = true; if (timer) clearTimeout(timer); watchers.forEach(watcher => watcher.close()); } };
  }
}
