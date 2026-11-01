import { MemoryStore } from "./memoryStore.js";
import type { MemoryListing } from "./workspaceNotes.js";

/** Active workspace store and notifications, with no background generation. */
export class WorkspaceMemory {
  private store?: MemoryStore;
  private watcher?: { dispose(): void };
  private listeners = new Set<() => void>();
  private disposed = false;
  constructor(private getRoot: () => string | undefined) {}
  current(): MemoryStore | undefined {
    if (this.disposed) return;
    const root = this.getRoot();
    if (root !== this.store?.workspaceRoot) {
      this.watcher?.dispose();
      const next: MemoryStore | undefined = root ? new MemoryStore(root,
        () => !this.disposed && this.getRoot() === root && this.store === next) : undefined;
      this.store = next;
      this.watcher = this.store?.watch(() => this.changed());
    }
    return this.store;
  }
  async list(): Promise<MemoryListing> { return await this.current()?.list() ?? { memories: [], warnings: [] }; }
  onChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener); this.current();
    return { dispose: () => this.listeners.delete(listener) };
  }
  changed(): void { this.listeners.forEach(listener => listener()); }
  workspaceChanged(): void { this.current(); this.changed(); }
  dispose(): void { this.disposed = true; this.watcher?.dispose(); this.listeners.clear(); }
}
