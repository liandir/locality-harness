import { generateMemory, memoryInput, MemoryYield } from "./memoryGeneration.js";
export { generateMemory } from "./memoryGeneration.js";
import { randomUUID } from "node:crypto";
import { beginForeground, foregroundBusy, onForegroundChange } from "../llm/activity.js";
import { readSettings } from "../config/settings.js";
import { countTokens } from "./contextTracker.js";
import { ChatStorage } from "./storage.js";
import type { ChatRecord } from "./types.js";
import {
  MEMORY_SUMMARY_TOKENS, transcriptRevision, usableMemory, redactMemorySecrets, memoryListItem, memoryCreation,
  type ChatMemory, type MemoryCreation, type MemoryListItem, type MemorySnapshot
} from "./memory.js";
import {
  MemoryFailure, invalidMemoryOutput, memoryFailure, memorySignature, memorySourceMatches, newMemoryAttempt, pendingMemory,
  MEMORY_JOB_BUDGET_MS, MEMORY_MAX_RETRIES, MEMORY_REQUEST_TIMEOUT_MS, type MemoryAttempt, type MemoryDiagnostic
} from "./memoryJobs.js";

interface MemoryWorkerOptions {
  budgetMs?: number;
  retryDelay?: (retry: number) => number;
  reportError?: (message: string) => void;
}
class SupersededMemory extends Error {}

export class WorkspaceMemory {
  private queue = new Map<string, MemoryAttempt>();
  private active?: { id: string; controller: AbortController; endpoint: string; model: string };
  private timer?: ReturnType<typeof setTimeout>;
  private epoch = 0;
  private disposed = false;
  private waitingTurns = 0;
  private listeners = new Set<() => void>();
  private pending = new Set<Promise<void>>();
  // Generation stays separate so listing progress never waits for the model.
  private runTask?: Promise<void>;
  // A disk failure cannot be persisted to that disk. Keep it visible for this host's lifetime.
  private unsaved = new Map<string, MemoryAttempt>();
  private unsubscribe: () => void;
  constructor(private getStorage: () => ChatStorage | undefined, private idleDelayMs = 1000, private options: MemoryWorkerOptions = {}) {
    this.unsubscribe = onForegroundChange(() => {
      if (foregroundBusy()) this.active?.controller.abort();
      else this.schedule();
    });
    void this.restore();
  }
  onChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }
  private changed(): void { for (const listener of this.listeners) listener(); }
  private track(work: Promise<void>): Promise<void> {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => undefined);
    return work;
  }
  private report(id: string, attempt: MemoryAttempt, diagnostic: MemoryDiagnostic): void {
    const failed = { ...attempt, state: "failed" as const, diagnostic, startedAt: undefined };
    this.unsaved.set(id, failed);
    const message = `${diagnostic.message} The attempt status could not be saved.`;
    this.options.reportError?.(message);
    console.error("Locality memory", { id, attemptId: attempt.id, stage: diagnostic.stage, cause: diagnostic.cause, attempt: diagnostic.attempt });
    this.changed();
  }
  /** Finish the in-flight summary before a chat claims the server, without starting another one. */
  async beginChatTurn(signal: AbortSignal, onWaiting: () => void): Promise<() => void> {
    this.waitingTurns++;
    try {
      signal.throwIfAborted();
      if (this.active) {
        onWaiting();
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => { subscription.dispose(); signal.removeEventListener("abort", aborted); };
          const aborted = () => { cleanup(); reject(signal.reason); };
          const subscription = this.onChange(() => {
            if (!this.active) { cleanup(); resolve(); }
          });
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
        });
      }
      signal.throwIfAborted();
      return beginForeground();
    } finally {
      this.waitingTurns--;
      this.schedule();
    }
  }

  async creations(id: string): Promise<MemoryCreation[]> {
    await Promise.allSettled([...this.pending]);
    const storage = this.getStorage();
    const rec = await storage?.load(id);
    if (!rec || storage !== this.getStorage()) return [];
    const creations = rec.memoryCreations ?? [];
    const failed = this.unsaved.get(id);
    const creation = failed && memoryCreation(failed);
    return creation ? [...creations.filter(item => item.messageTs !== creation.messageTs), creation] : creations;
  }
  enqueue(id: string, regenerate = false, messageTs?: number): Promise<void> {
    return this.track(this.admit(id, regenerate, messageTs));
  }
  private async admit(id: string, regenerate: boolean, messageTs?: number, expectedAttemptId?: string): Promise<void> {
    if (this.disposed) return;
    const storage = this.getStorage();
    if (!storage) return;
    const epoch = this.epoch;
    const settings = readSettings();
    let attempt: MemoryAttempt | undefined;
    try {
      const saved = await storage.maintainMemory(id, rec => {
        if (epoch !== this.epoch || storage !== this.getStorage() || this.disposed) return false;
        const previous = this.unsaved.get(id) ?? rec.memoryAttempt;
        if (expectedAttemptId && (previous?.id !== expectedAttemptId || previous.state !== "failed" || !memorySourceMatches(rec, previous))) return false;
        if (!regenerate && (rec.memory?.manual || rec.memory?.enabled === false || usableMemory(rec))) return false;
        if (expectedAttemptId && previous && memorySourceMatches(rec, previous)) {
          attempt = { ...previous, id: randomUUID(), state: "queued", retries: 0, activeMs: 0, startedAt: undefined,
            retryAt: undefined, diagnostic: undefined, updatedAt: Date.now() };
        } else attempt = newMemoryAttempt(rec, memorySignature(settings.endpoint, settings.model), regenerate, messageTs);
        if (!attempt) return false;
        // Coalesce duplicate automatic admissions without resetting a durable retry budget.
        if (!regenerate && pendingMemory(rec.memoryAttempt) && rec.memoryAttempt.sourceRevision === attempt.sourceRevision) return false;
        if (pendingMemory(rec.memoryAttempt) && rec.memoryAttempt.messageTs !== attempt.messageTs) {
          rec.memoryCreations = rec.memoryCreations?.map(item => item.attemptId === rec.memoryAttempt!.id
            ? { ...item, status: "cancelled" } : item);
        }
        rec.memoryAttempt = attempt;
        return true;
      });
      if (!saved || !attempt || epoch !== this.epoch) return;
      this.unsaved.delete(id);
      if (this.active?.id === id) this.active.controller.abort();
      this.queue.set(id, attempt);
      this.changed(); this.schedule();
    } catch (error) {
      if (epoch !== this.epoch || this.disposed) return;
      if (attempt) this.report(id, attempt, memoryFailure(error, "storage"));
      else this.options.reportError?.("The memory job could not be queued. Check local storage and regenerate the memory.");
    }
  }
  /** Rehydrate only this workspace; explicit cancellation is never undone by reload. */
  restore(): Promise<void> { return this.track(this.restorePending()); }
  private async restorePending(): Promise<void> {
    const storage = this.getStorage(); const epoch = this.epoch;
    if (!storage || this.disposed) return;
    try {
      const records = await storage.metadata();
      for (const rec of records) {
        if (epoch !== this.epoch || this.disposed) return;
        const attempt = rec.memoryAttempt && structuredClone(rec.memoryAttempt);
        if (!pendingMemory(attempt) || this.queue.has(rec.id) || this.active?.id === rec.id) continue;
        if (attempt.state === "generating") {
          // A process ended mid-request. Count this recovery before another request is sent.
          if (!attempt.checkpoint?.complete) attempt.activeMs += Math.min(MEMORY_REQUEST_TIMEOUT_MS, Math.max(0, Date.now() - (attempt.startedAt ?? Date.now())));
          attempt.startedAt = undefined;
          if (!attempt.checkpoint?.complete) attempt.retries++;
          attempt.state = attempt.retries > MEMORY_MAX_RETRIES ? "failed" : "queued";
          if (attempt.state === "failed") attempt.diagnostic = {
            stage: "generation", cause: "unexpected_eof", message: "Memory generation was interrupted repeatedly. Retry when the server is available.", retryable: false, attempt: Math.max(1, attempt.requests, attempt.retries)
          };
          const saved = await storage.maintainMemory(rec.id, current => {
            if (epoch !== this.epoch || current.memoryAttempt?.id !== attempt.id || !pendingMemory(current.memoryAttempt)) return false;
            current.memoryAttempt = attempt; return true;
          });
          if (!saved) continue;
        }
        if (pendingMemory(attempt)) this.queue.set(rec.id, attempt);
      }
      this.changed(); this.schedule();
    } catch { this.options.reportError?.("Pending memory jobs could not be restored. Check local storage."); }
  }
  /** Leave durable jobs in their workspace when switching or shutting down. */
  suspend(): void {
    this.epoch++; this.queue.clear(); this.unsaved.clear();
    this.active?.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.changed();
  }
  /** Compatibility entry point for explicit cancellation, distinct from suspension. */
  reset(): void { void this.cancelAll(); }
  cancelAll(): Promise<void> {
    const storage = this.getStorage();
    this.suspend();
    const epoch = this.epoch;
    return this.track((async () => {
      if (!storage) return;
      try {
        for (const rec of await storage.metadata()) {
          if (epoch !== this.epoch) return;
          if (!pendingMemory(rec.memoryAttempt)) continue;
          await storage.maintainMemory(rec.id, current => {
            if (epoch !== this.epoch || !pendingMemory(current.memoryAttempt)) return false;
            current.memoryAttempt = { ...current.memoryAttempt, state: "cancelled", checkpoint: undefined, startedAt: undefined, diagnostic: undefined };
            return true;
          });
        }
      } catch { this.options.reportError?.("Memory cancellation could not be saved. Check local storage before restarting the extension."); }
      this.changed();
    })());
  }
  settingsChanged(): void {
    if (this.active && !settingsStillMatch(this.active.endpoint, this.active.model)) this.active.controller.abort();
    this.schedule(); this.changed();
  }
  /** Stop new work immediately, then finish admissions, restoration and in-flight storage writes. */
  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true; this.suspend(); this.unsubscribe(); this.listeners.clear();
    }
    await Promise.allSettled([...this.pending, this.runTask]);
  }
  private schedule(): void {
    if (this.disposed || this.active || this.timer || !this.queue.size || foregroundBusy() || this.waitingTurns) return;
    const earliest = Math.min(...[...this.queue.values()].map(a => a.retryAt ?? 0));
    this.timer = setTimeout(() => { this.timer = undefined; this.runTask = this.run(); }, Math.max(this.idleDelayMs, earliest - Date.now()));
  }
  private async run(): Promise<void> {
    if (this.disposed || this.active || foregroundBusy() || this.waitingTurns) return;
    const storage = this.getStorage();
    const next = [...this.queue.entries()].find(([, a]) => !a.retryAt || a.retryAt <= Date.now());
    if (!storage || !next) { this.schedule(); return; }
    const [id, queued] = next;
    this.queue.delete(id);
    const controller = new AbortController();
    const epoch = this.epoch;
    const settings = readSettings();
    const active = { id, controller, endpoint: settings.endpoint, model: settings.model };
    this.active = active;
    let attempt = structuredClone(queued);
    let stage: "generation" | "storage" = "storage";
    let runStarted = Date.now(); let priorActiveMs = attempt.activeMs;
    const elapsed = () => { attempt.activeMs = priorActiveMs + Math.max(0, Date.now() - runStarted); attempt.updatedAt = Date.now(); };
    const persist = async (commit?: (rec: ChatRecord) => void) => {
      elapsed();
      if (attempt.state === "generating") attempt.startedAt = attempt.updatedAt;
      try {
        const saved = await storage.maintainMemory(id, current => {
          if (controller.signal.aborted || epoch !== this.epoch || current.memoryAttempt?.id !== attempt.id
            || !pendingMemory(current.memoryAttempt) || !memorySourceMatches(current, attempt)) return false;
          current.memoryAttempt = structuredClone(attempt); commit?.(current); return true;
        });
        if (!saved) throw new SupersededMemory();
      } catch (error) {
        if (error instanceof SupersededMemory) throw error;
        throw new MemoryFailure(memoryFailure(error, "storage", attempt.requests));
      }
      this.changed();
    };
    try {
      const rec = await storage.load(id, true);
      if (!rec || rec.memoryAttempt?.id !== attempt.id || !pendingMemory(rec.memoryAttempt)) return;
      if (!memorySourceMatches(rec, attempt) || (!attempt.regenerate && (rec.memory?.manual || rec.memory?.enabled === false))) {
        await storage.maintainMemory(id, current => {
          if (current.memoryAttempt?.id !== attempt.id) return false;
          current.memoryAttempt = { ...attempt, state: "cancelled", checkpoint: undefined }; return true;
        });
        return;
      }
      const signature = memorySignature(settings.endpoint, settings.model);
      if (signature !== attempt.signature) {
        attempt = { ...attempt, signature, checkpoint: undefined, shorterAttempt: 0, retries: 0, requests: 0, activeMs: 0 };
      }
      const source = { ...rec, messages: rec.messages.slice(0, attempt.sourceLength) };
      if (attempt.checkpoint?.complete && attempt.checkpoint.offset !== memoryInput(source).length) {
        throw invalidMemoryOutput("The saved memory checkpoint is invalid. Regenerate this memory.");
      }
      priorActiveMs = attempt.activeMs; runStarted = Date.now();
      const remaining = (this.options.budgetMs ?? MEMORY_JOB_BUDGET_MS) - attempt.activeMs;
      if (remaining <= 0 && !attempt.checkpoint?.complete) throw new MemoryFailure({ stage: "generation", cause: "budget", message: "Memory generation used its execution budget. Retry to start a new budget.", retryable: false, attempt: attempt.requests });
      attempt.state = "generating"; attempt.startedAt = Date.now(); attempt.retryAt = undefined; attempt.diagnostic = undefined;
      await persist();
      stage = "generation";
      const signal = attempt.checkpoint?.complete ? controller.signal : AbortSignal.any([controller.signal, AbortSignal.timeout(remaining)]);
      const text = attempt.checkpoint?.complete ? attempt.checkpoint.summary : await generateMemory(
        source, settings.endpoint, settings.model, signal,
        { checkpoint: attempt.checkpoint, shorterAttempt: attempt.shorterAttempt, shouldYield: () => this.waitingTurns > 0,
          onProgress: async progress => {
            signal.throwIfAborted();
            if (progress.checkpoint) attempt.checkpoint = progress.checkpoint;
            if (progress.shorterAttempt !== undefined) attempt.shorterAttempt = progress.shorterAttempt;
            if (progress.request) attempt.requests++;
            await persist();
          } }
      );
      signal.throwIfAborted();
      stage = "storage";
      attempt.state = "succeeded"; attempt.startedAt = undefined;
      await persist(current => {
        current.memory = { text, sourceRevision: attempt.sourceRevision, generatedAt: Date.now(), enabled: current.memory?.enabled ?? true, manual: false };
        current.memoryAttempt!.checkpoint = undefined;
      });
      this.unsaved.delete(id);
    } catch (error) {
      if (error instanceof SupersededMemory && !controller.signal.aborted) return;
      if (epoch !== this.epoch || this.disposed) {
        if (controller.signal.aborted) {
          elapsed();
          await storage.maintainMemory(id, current => {
            if (current.memoryAttempt?.id !== attempt.id || !pendingMemory(current.memoryAttempt)) return false;
            current.memoryAttempt = { ...attempt, state: "queued", startedAt: undefined }; return true;
          }).catch(() => undefined); // Shutdown: existing durable checkpoint remains recoverable if storage is unavailable.
        }
        return;
      }
      elapsed(); attempt.startedAt = undefined;
      if (controller.signal.aborted || error instanceof MemoryYield) {
        attempt.state = "queued";
        // Preemption is resumable, not a failure or a spent retry.
        try {
          const saved = await storage.maintainMemory(id, current => {
            if (epoch !== this.epoch || current.memoryAttempt?.id !== attempt.id || !pendingMemory(current.memoryAttempt)) return false;
            current.memoryAttempt = attempt; return true;
          });
          if (saved && !this.queue.has(id)) this.queue.set(id, attempt);
        } catch (failure) { this.report(id, attempt, memoryFailure(failure, "storage", attempt.requests)); }
      } else {
        const diagnostic = memoryFailure(error, stage, Math.max(1, attempt.requests, attempt.retries + 1));
        if (attempt.activeMs >= (this.options.budgetMs ?? MEMORY_JOB_BUDGET_MS)) {
          diagnostic.cause = "budget"; diagnostic.retryable = false;
          diagnostic.message = "Memory generation used its execution budget. Retry to start a new budget.";
        }
        attempt.diagnostic = diagnostic;
        if (diagnostic.retryable && attempt.retries < MEMORY_MAX_RETRIES) {
          attempt.retries++;
          attempt.state = "retry_wait";
          attempt.retryAt = Date.now() + (this.options.retryDelay?.(attempt.retries) ?? (attempt.retries === 1 ? 1000 : 4000));
        } else attempt.state = "failed";
        try {
          await persist();
          if (attempt.state === "retry_wait") this.queue.set(id, attempt);
          console.warn("Locality memory", { id, attemptId: attempt.id, cause: diagnostic.cause, stage: diagnostic.stage, attempt: diagnostic.attempt });
        } catch (failure) {
          if (!(failure instanceof SupersededMemory)) this.report(id, attempt, memoryFailure(failure, "storage", attempt.requests));
        }
      }
    } finally {
      if (this.active === active) this.active = undefined;
      this.changed(); this.schedule();
    }
  }
  async list(): Promise<MemoryListItem[]> {
    await Promise.allSettled([...this.pending]);
    const storage = this.getStorage();
    const records = await storage?.metadata() ?? [];
    if (storage !== this.getStorage()) return [];
    return records.filter(r => r.messageCount).map(rec => {
      const attempt = this.unsaved.get(rec.id) ?? rec.memoryAttempt;
      const item = memoryListItem({ ...rec, memoryAttempt: attempt });
      return { ...item, status: pendingMemory(attempt) ? attempt.state === "generating" ? "generating" : "queued" : item.status };
    });
  }
  async edit(id: string, text: string, storage = this.getStorage()): Promise<void> {
    if (!storage || storage !== this.getStorage()) throw new Error("This memory is not in the active workspace.");
    const settings = readSettings();
    if (typeof text !== "string" || text.length > 20000) throw new Error("Memory text is too long.");
    text = redactMemorySecrets(text.trim());
    if (!text || await countTokens(settings.endpoint, text, settings.model, { exact: true }) > MEMORY_SUMMARY_TOKENS) {
      throw new Error(`Enter a non-empty memory of at most ${MEMORY_SUMMARY_TOKENS} tokens.`);
    }
    const saved = await storage.updateMemory(id, rec => {
      if (storage !== this.getStorage()) throw new Error("The active workspace changed. The memory was not saved.");
      if (rec.memoryAttempt) {
        rec.memoryAttempt = { ...rec.memoryAttempt, state: "cancelled", diagnostic: undefined, checkpoint: undefined };
        rec.memoryCreations = rec.memoryCreations?.map(item => item.attemptId === rec.memoryAttempt!.id
          ? { ...item, status: "cancelled", error: undefined, diagnostic: undefined } : item);
      }
      return { text, sourceRevision: transcriptRevision(rec), generatedAt: Date.now(), enabled: rec.memory?.enabled ?? false, manual: true };
    });
    if (!saved) throw new Error("The chat is no longer available. The memory was not saved.");
    this.unsaved.delete(id); this.queue.delete(id);
    if (this.active?.id === id) this.active.controller.abort();
    this.changed();
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.getStorage()?.updateMemory(id, rec => ({ ...emptyMemory(rec), ...rec.memory, enabled }));
    if (!enabled) { this.queue.delete(id); if (this.active?.id === id) this.active.controller.abort(); }
    this.changed();
  }
  async regenerate(id: string): Promise<void> { await this.enqueue(id, true); }
  async retry(id: string, attemptId: string): Promise<void> {
    await this.track(this.admit(id, true, undefined, attemptId));
  }
}
function emptyMemory(rec: ChatRecord): ChatMemory {
  return { text: "", sourceRevision: transcriptRevision(rec), generatedAt: 0, enabled: true, manual: false };
}
function settingsStillMatch(endpoint: string, model: string): boolean {
  const settings = readSettings(); return settings.endpoint === endpoint && settings.model === model;
}

export async function activeSnapshots(storage: ChatStorage, snapshots: MemorySnapshot[]): Promise<MemorySnapshot[]> {
  if (!snapshots.length) return [];
  const sources = new Map((await storage.metadata(true)).map(source => [source.id, source]));
  return snapshots.filter(snapshot => {
    const source = sources.get(snapshot.sourceId);
    return source && usableMemory(source)
      && (source.memory!.manual || source.revision === snapshot.sourceRevision);
  });
}
