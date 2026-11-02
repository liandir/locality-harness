import * as fs from "node:fs/promises";
import * as path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { assertInsideWorkspace } from "../tools/workspaceGuard.js";
import { writeAtomic } from "./chatFile.js";
import { withStorageLock } from "./storageLock.js";
import { redactMemorySecrets } from "./memory.js";
import { validMemoryId, validWorkspaceNote, type MemoryListing, type WorkspaceNote } from "./workspaceNotes.js";

export function noteRevision(note: WorkspaceNote): string {
  return createHash("sha256").update(JSON.stringify(note)).digest("hex");
}
/** Workspace notes. Every operation revalidates the path and live contents. */
export class MemoryStore {
  constructor(readonly workspaceRoot: string, private canWrite: () => boolean = () => true) {}
  private assertWritable(): void {
    if (!this.canWrite()) throw new Error("The memory operation was cancelled or its workspace changed.");
  }
  private async directory(): Promise<string> {
    return assertInsideWorkspace(this.workspaceRoot, path.join(".locality", "memories"));
  }
  private async file(id: string): Promise<string> {
    if (!validMemoryId(id)) throw new Error("Invalid memory ID.");
    return assertInsideWorkspace(this.workspaceRoot, path.join(await this.directory(), `${id}.json`));
  }
  private async read(id: string): Promise<WorkspaceNote> {
    const file = await this.file(id);
    if ((await fs.stat(file)).size > 150_000) throw new Error("Memory file is too large.");
    const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (!validWorkspaceNote(value) || value.id !== id) throw new Error("Invalid memory record.");
    const note = { ...value, name: redactMemorySecrets(value.name), contents: redactMemorySecrets(value.contents) };
    if (!validWorkspaceNote(note)) throw new Error("The redacted memory exceeds the name or contents limit.");
    return note;
  }
  async list(): Promise<MemoryListing> {
    const directory = await this.directory();
    let entries: string[];
    try { entries = await fs.readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { memories: [], warnings: [] }; throw error; }
    const memories: WorkspaceNote[] = [], warnings: string[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) continue;
      try { memories.push(await this.read(entry.slice(0, -5))); }
      catch { warnings.push(`Cannot read memory file ${entry}. It was excluded; repair or remove the file to resolve this warning.`); }
    }
    memories.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    return { memories, warnings };
  }
  async get(id: string): Promise<WorkspaceNote> {
    try { return await this.read(id); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("This memory no longer exists. Search memories again.");
      throw error;
    }
  }
  private async mutate<T>(task: () => Promise<T>): Promise<T> {
    this.assertWritable();
    await fs.mkdir(await this.directory(), { recursive: true });
    const lock = await assertInsideWorkspace(this.workspaceRoot, path.join(await this.directory(), ".lock"));
    return withStorageLock(lock, async () => { this.assertWritable(); return task(); });
  }
  private async write(note: WorkspaceNote): Promise<void> {
    const file = await this.file(note.id);
    this.assertWritable();
    await writeAtomic(file, JSON.stringify(note, null, 2) + "\n");
  }
  private async checked(id: string, revision: string | undefined): Promise<WorkspaceNote> {
    const note = await this.get(id);
    if (!revision || noteRevision(note) !== revision) {
      throw new Error("This memory changed or has not been recalled. Recall the current memory again before updating it; reopen the editor for UI changes.");
    }
    return note;
  }
  async save(input: { name: string; contents: string; id?: string }, revision?: string): Promise<{ note: WorkspaceNote; operation: "created" | "updated" | "unchanged" }> {
    if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200) throw new Error("Memory names must contain 1–200 characters.");
    if (typeof input.contents !== "string" || !input.contents.trim() || input.contents.length > 20_000) throw new Error("Memory contents must contain 1–20,000 characters.");
    if (input.id !== undefined && !validMemoryId(input.id)) throw new Error("Invalid memory ID.");
    const name = redactMemorySecrets(input.name.trim()), contents = redactMemorySecrets(input.contents.trim());
    if (name.length > 200 || contents.length > 20_000) throw new Error("The redacted memory exceeds the name or contents limit.");
    return this.mutate(async () => {
      if (input.id) {
        const previous = await this.checked(input.id, revision);
        const note = { ...previous, name, contents, updatedAt: Math.max(Date.now(), previous.updatedAt + 1) };
        await this.write(note);
        return { note, operation: "updated" };
      }
      const duplicate = (await this.list()).memories.find(note => note.name === name && note.contents === contents);
      if (duplicate) return { note: duplicate, operation: "unchanged" };
      const now = Date.now();
      const note: WorkspaceNote = { version: 1, id: randomUUID(), name, contents, createdAt: now, updatedAt: now, enabled: true };
      await this.write(note);
      return { note, operation: "created" };
    });
  }
  async setEnabled(id: string, enabled: boolean, revision: string): Promise<void> {
    if (typeof enabled !== "boolean") throw new Error("Invalid memory state.");
    await this.mutate(async () => {
      const note = await this.checked(id, revision);
      await this.write({ ...note, enabled, updatedAt: Math.max(Date.now(), note.updatedAt + 1) });
    });
  }
  async delete(id: string, revision: string): Promise<void> {
    await this.mutate(async () => {
      await this.checked(id, revision);
      const file = await this.file(id);
      this.assertWritable();
      await fs.unlink(file);
    });
  }
  /** Also watch parents so lazy creation and removal are observed. */
  watch(onChange: () => void): { dispose(): void } {
    let watchers: FSWatcher[] = [], disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    const refresh = async (): Promise<void> => {
      const current = ++generation;
      const next: FSWatcher[] = [];
      for (const relative of [".", ".locality", ".locality/memories"]) {
        try {
          const directory = await assertInsideWorkspace(this.workspaceRoot, relative);
          const watcher = watch(directory, (_event, name) => {
            if (relative === "." && name !== ".locality" || relative === ".locality" && name !== "memories") return;
            if (relative.endsWith("memories") && name && !String(name).endsWith(".json")) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { timer = undefined; if (!disposed) { onChange(); void refresh(); } }, 60);
          });
          watcher.on("error", () => { if (!disposed) onChange(); });
          watcher.unref(); next.push(watcher);
        } catch { /* Lazy directories may not exist yet; reads report access failures. */ }
      }
      if (disposed || generation !== current) { next.forEach(w => w.close()); return; }
      watchers.forEach(w => w.close()); watchers = next;
    };
    void refresh();
    return { dispose: () => { disposed = true; if (timer) clearTimeout(timer); watchers.forEach(w => w.close()); } };
  }
}
