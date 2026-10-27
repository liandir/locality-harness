import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
const mocks = vi.hoisted(() => ({
  settings: { memoryEnabled: true, endpoint: "http://127.0.0.1:8080", model: "test", serverType: "llama.cpp" as "llama.cpp" | "vllm" },
  complete: vi.fn(), tokenize: vi.fn(), context: vi.fn()
}));
vi.mock("../src/config/settings.js", () => ({ readSettings: () => mocks.settings }));
vi.mock("../src/llm/client.js", async importOriginal => ({
  GenerationLengthError: (await importOriginal<typeof import("../src/llm/client.js")>()).GenerationLengthError,
  complete: mocks.complete, tokenize: mocks.tokenize, fetchServerContextSize: mocks.context
}));
import { WorkspaceMemory, generateMemory, activeSnapshots } from "../src/chat/workspaceMemory.js";
import { ChatStorage, type ChatRecord } from "../src/chat/storage.js";
import { MEMORY_SUMMARY_TOKENS, transcriptRevision, rankMemories, recallMemory, memoryMetadata } from "../src/chat/memory.js";
import { beginForeground, foregroundBusy } from "../src/llm/activity.js";
import { GenerationLengthError } from "../src/llm/client.js";
let dir: string;
let storage: ChatStorage;
let memory: WorkspaceMemory;
let releases: (() => void)[];
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "locality-memory-"));
  storage = new ChatStorage(path.join(dir, "workspace"), path.join(dir, "chats"));
  memory = new WorkspaceMemory(() => storage, 5);
  releases = [];
  mocks.settings.memoryEnabled = true;
  mocks.settings.model = "test";
  mocks.settings.serverType = "llama.cpp";
  mocks.complete.mockReset().mockResolvedValue("Parser uses exact revisions. Verified by tests.");
  mocks.tokenize.mockReset().mockImplementation(async (_endpoint, text: string) => Math.ceil(text.length / 4));
  mocks.context.mockReset().mockResolvedValue(8192);
});
afterEach(async () => { await memory.dispose(); releases.forEach(release => release()); await fs.rm(dir, { recursive: true, force: true }); });
async function chat(text = "Parser change requested"): Promise<ChatRecord> {
  const rec = storage.newRecord("native"); rec.title = "Parser";
  rec.messages = [{ role: "user", content: text, ts: 1 }, { role: "assistant", content: "Parser changed and verified", ts: 2 }];
  await storage.save(rec); return rec;
}
async function generated(id: string): Promise<void> {
  await vi.waitFor(async () => expect((await storage.load(id))?.memory?.text).toContain("Parser"));
}
describe("memory shutdown", () => {
  it.each(["admission", "restoration"] as const)("waits for pending %s before releasing storage", async operation => {
    const rec = await chat();
    await memory.list(); // Finish construction's initial restoration first.
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    const original = storage.metadata.bind(storage);
    const read = vi.spyOn(storage, "metadata").mockImplementation(async (...args) => {
      held = true; await barrier;
      return original(...args);
    });
    const maintain = storage.maintainMemory.bind(storage);
    const write = vi.spyOn(storage, "maintainMemory").mockImplementation(async (...args) => {
      held = true; await barrier;
      return maintain(...args);
    });
    const work = operation === "admission" ? memory.enqueue(rec.id) : memory.restore();
    let closing: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(held).toBe(true));
      let closed = false;
      closing = memory.dispose().then(() => { closed = true; });
      await Promise.resolve();
      expect(closed).toBe(false);
      release();
      await closing;
      expect(mocks.complete).not.toHaveBeenCalled();
    } finally {
      release();
      await work; await closing;
      read.mockRestore(); write.mockRestore();
    }
  });

  it.each(["succeeded", "queued"] as const)("waits for the %s write before releasing storage", async state => {
    const rec = await chat();
    if (state === "queued") {
      mocks.complete.mockImplementationOnce((_endpoint, _req, signal: AbortSignal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
    }
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    let holdWrites = state === "succeeded";
    const original = storage.maintainMemory.bind(storage);
    const write = vi.spyOn(storage, "maintainMemory").mockImplementation(async (id, update) => {
      let savedState: string | undefined;
      const saved = await original(id, current => {
        const changed = update(current);
        if (changed) savedState = current.memoryAttempt?.state;
        return changed;
      });
      // A visible chat record does not mean its enclosing storage operation has finished.
      if (holdWrites && savedState === state) { held = true; await barrier; }
      return saved;
    });
    let closing: Promise<void> | undefined;
    try {
      await memory.enqueue(rec.id);
      if (state === "succeeded") await vi.waitFor(() => expect(held).toBe(true));
      else await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledOnce());
      holdWrites = true;
      let closed = false;
      closing = Promise.resolve(memory.dispose()).then(() => { closed = true; });
      await vi.waitFor(() => expect(held).toBe(true));
      expect((await storage.load(rec.id))!.memoryAttempt?.state).toBe(state);
      expect(closed).toBe(false);
      release();
      await closing;
      expect(closed).toBe(true);
    } finally {
      release();
      await closing;
      write.mockRestore();
    }
  });
});
describe("memory generation", () => {
  it("activates new summaries for retrieval automatically", async () => {
    const rec = await chat();
    memory.enqueue(rec.id);
    await generated(rec.id);
    expect((await memory.list())[0]).toMatchObject({ enabled: true, status: "ready", usable: true });
    expect(rankMemories("parser", await storage.records(), "new-chat")).toHaveLength(1);
  });

  it("saves and recalls summaries up to 1024 tokens without cutting out their middle", async () => {
    const rec = await chat();
    const summary = `Parser decisions. ${"Keep exact revisions and verify tests. ".repeat(80)}Retain this final decision.`;
    expect(Math.ceil(summary.length / 4)).toBeGreaterThan(384);
    mocks.complete.mockResolvedValueOnce(summary);
    memory.enqueue(rec.id);
    await generated(rec.id);
    expect((await storage.load(rec.id))!.memory!.text).toBe(summary);
    const records = await storage.records();
    const metadata = memoryMetadata(rankMemories("parser", records, "new-chat")[0]);
    expect(recallMemory(metadata.name, metadata.id, records, "new-chat").text).toBe(summary);
    expect(await memory.creations(rec.id)).toEqual([expect.objectContaining({ text: summary })]);
    expect(mocks.complete.mock.calls[0][1].max_tokens).toBeGreaterThanOrEqual(1024);
  });

  it("rewrites an oversized draft from the same source before carrying it into later chunks", async () => {
    const rec = await chat("Parser transcript. ".repeat(2000));
    const oversized = "Oversized draft detail. ".repeat(200);
    const rewritten = "Parser uses exact revisions. Verified by tests.";
    mocks.complete.mockResolvedValueOnce(oversized).mockResolvedValue(rewritten);
    const text = await generateMemory(rec, mocks.settings.endpoint, "test", new AbortController().signal);
    expect(text).toBe(rewritten);
    expect(mocks.complete.mock.calls.length).toBeGreaterThan(2);
    const first = mocks.complete.mock.calls[0][1];
    const retry = mocks.complete.mock.calls[1][1];
    expect(retry.messages[1]).toEqual(first.messages[1]);
    expect(first.messages[0].content).toContain("at most 1024 tokens");
    expect(retry.messages[0].content).toContain("at most 768 tokens");
    expect(JSON.parse(mocks.complete.mock.calls[2][1].messages[1].content).priorDraft).toBe(rewritten);
    expect(JSON.stringify(mocks.complete.mock.calls)).not.toContain("context guard elided");
    expect(JSON.stringify(mocks.complete.mock.calls)).not.toContain(oversized);
  });

  it("retries output-limit failures without accepting an unfinished memory", async () => {
    const rec = await chat();
    mocks.complete.mockRejectedValueOnce(new GenerationLengthError());
    memory.enqueue(rec.id);
    await generated(rec.id);
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    for (const call of mocks.complete.mock.calls) expect(call[3]?.acceptPartialOnLength).not.toBe(true);
  });

  it.each(["", "Previous Parser decision"])("preserves prior contents %j if the shorter retry is still oversized", async text => {
    const rec = await chat();
    if (text) await storage.updateMemory(rec.id, () => ({
      text, sourceRevision: "0".repeat(64), generatedAt: 1, enabled: true, manual: false
    }));
    mocks.complete.mockResolvedValue("Oversized draft detail. ".repeat(200));
    memory.enqueue(rec.id);
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("failed"));
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    expect((await storage.load(rec.id))!.memory?.text ?? "").toBe(text);
    expect(await memory.creations(rec.id)).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("does not retry oversized output after cancellation", async () => {
    const rec = await chat();
    const controller = new AbortController();
    mocks.complete.mockImplementationOnce(async () => {
      controller.abort();
      return "Oversized draft detail. ".repeat(200);
    });
    await expect(generateMemory(rec, mocks.settings.endpoint, "test", controller.signal)).rejects.toThrow();
    expect(mocks.complete).toHaveBeenCalledOnce();
  });

  it("leaves room for the running draft and output on a small model context", async () => {
    const rec = await chat("Parser transcript. ".repeat(1000));
    mocks.context.mockResolvedValue(2048);
    mocks.complete.mockResolvedValue("Parser decision with verified tests. ".repeat(40).trim());
    const text = await generateMemory(rec, mocks.settings.endpoint, "test", new AbortController().signal);
    expect(Math.ceil(text.length / 4)).toBeLessThanOrEqual(512);
    expect(mocks.complete.mock.calls.length).toBeGreaterThan(1);
    for (const [, request] of mocks.complete.mock.calls) {
      const inputTokens = request.messages.reduce((sum: number, message: { content: string }) => sum + Math.ceil(message.content.length / 4), 0);
      expect(inputTokens + request.max_tokens + 64).toBeLessThanOrEqual(2048);
    }
  });

  it("accepts manual memories through 1024 tokens and rejects larger edits without replacing them", async () => {
    const rec = await chat();
    const text = "Manual Parser decision ".padEnd(4096, "x");
    await memory.edit(rec.id, text);
    expect((await storage.load(rec.id))!.memory?.text ?? "").toBe(text);
    await expect(memory.edit(rec.id, text + "x")).rejects.toThrow("at most 1024 tokens");
    expect((await storage.load(rec.id))!.memory?.text ?? "").toBe(text);
  });

  it("persists recalled contents after the answer and retains earlier turn cards on reopening", async () => {
    const rec = await chat();
    const end = beginForeground(); releases.push(end);
    memory.enqueue(rec.id);
    expect(await memory.creations(rec.id)).toMatchObject([{ messageTs: 2, status: "queued", operation: "create" }]);
    end();
    await generated(rec.id);
    const snapshots = rankMemories("parser", await storage.records(), "new-chat");
    const metadata = memoryMetadata(snapshots[0]);
    const recalled = recallMemory(metadata.name, metadata.id, await storage.records(), "new-chat");
    expect(await memory.creations(rec.id)).toMatchObject([
      { messageTs: 2, status: "created", operation: "create", text: recalled.text, generatedAt: recalled.generatedAt }
    ]);
    rec.messages.push({ role: "user", content: "next", ts: 3 }, { role: "assistant", content: "next answer", ts: 4 });
    await storage.save(rec); // stale session saves preserve background history
    const pause = beginForeground(); releases.push(pause);
    let finish!: (text: string) => void;
    mocks.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    memory.enqueue(rec.id);
    expect((await memory.creations(rec.id)).at(-1)).toMatchObject({ messageTs: 4, status: "queued", operation: "update" });
    pause();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect((await memory.creations(rec.id)).at(-1)).toMatchObject({ messageTs: 4, status: "generating", operation: "update" });
    finish("Parser updated memory");
    await vi.waitFor(async () => expect((await memory.creations(rec.id)).map(item => item.status)).toEqual(["created", "created"]));
    const reopened = new WorkspaceMemory(() => storage);
    expect((await reopened.creations(rec.id)).map(item => [item.messageTs, item.operation])).toEqual([[2, "create"], [4, "update"]]);
    await reopened.dispose();
    expect((await storage.fork(rec)).memoryCreations).toBeUndefined();
    rec.messages = rec.messages.slice(0, 1);
    await storage.save(rec);
    expect(await memory.creations(rec.id)).toEqual([]);
  });

  it("finishes active memory before a chat turn and defers other queued memories", async () => {
    const first = await chat(); const second = await chat("second");
    let finish!: (text: string) => void;
    mocks.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    memory.enqueue(first.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    memory.enqueue(second.id);
    const waiting = vi.fn();
    let acquired = false;
    const turn = memory.beginChatTurn(new AbortController().signal, waiting).then(release => {
      releases.push(release); acquired = true; return release;
    });
    expect(waiting).toHaveBeenCalledOnce();
    expect(await memory.creations(first.id)).toMatchObject([{ messageTs: 2, status: "generating", operation: "create" }]);
    expect(acquired).toBe(false);
    expect(mocks.complete.mock.calls[0][2].aborted).toBe(false);
    finish("Parser memory");
    const release = await turn;
    expect(foregroundBusy()).toBe(true);
    expect((await storage.load(first.id))!.memory!.text).toBe("Parser memory");
    expect(mocks.complete).toHaveBeenCalledOnce();
    release();
    await generated(second.id);
  });

  it("saves the completed answer's memory even when a follow-up is accepted during generation", async () => {
    const rec = await chat();
    const revision = transcriptRevision(rec);
    let finish!: (text: string) => void;
    mocks.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    memory.enqueue(rec.id, false, 2);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const turn = memory.beginChatTurn(new AbortController().signal, vi.fn());
    rec.messages.push({ role: "user", content: "Next request", ts: 3 });
    await storage.save(rec);
    expect(await memory.creations(rec.id)).toMatchObject([{ messageTs: 2, status: "generating", operation: "create" }]);
    finish("Parser memory for the previous answer");
    releases.push(await turn);
    const saved = (await storage.load(rec.id))!;
    expect(saved.messages.at(-1)).toMatchObject({ role: "user", content: "Next request" });
    expect(saved.memory).toMatchObject({ text: "Parser memory for the previous answer", sourceRevision: revision, enabled: true });
    expect(await memory.creations(rec.id)).toEqual([expect.objectContaining({ messageTs: 2, status: "created", text: saved.memory!.text })]);
    await storage.save(rec);
    expect((await storage.load(rec.id))!.memoryCreations).toEqual(saved.memoryCreations);
  });

  it("excludes a follow-up saved before the generation source is loaded", async () => {
    const rec = await chat();
    const revision = transcriptRevision(rec);
    const release = beginForeground(); releases.push(release);
    memory.enqueue(rec.id, false, 2);
    rec.messages.push({ role: "user", content: "FOLLOW_UP_SENTINEL", ts: 3 });
    await storage.save(rec);
    release();
    await generated(rec.id);
    expect(JSON.stringify(mocks.complete.mock.calls)).not.toContain("FOLLOW_UP_SENTINEL");
    expect((await storage.load(rec.id))!.memory!.sourceRevision).toBe(revision);
    expect(await memory.creations(rec.id)).toEqual([expect.objectContaining({ messageTs: 2, status: "created" })]);
  });

  it("keeps delayed automatic memory on its Act answer when a newer Plan response exists", async () => {
    const rec = await chat();
    rec.messages[0].mode = "act";
    const revision = transcriptRevision(rec);
    const release = beginForeground(); releases.push(release);
    memory.enqueue(rec.id, false, 2);
    rec.messages.push(
      { role: "user", content: "PLAN_REQUEST_SENTINEL", mode: "plan", ts: 3 },
      { role: "assistant", content: "PLAN_RESPONSE_SENTINEL", ts: 4 }
    );
    rec.mode = "plan";
    rec.pendingPlanMessageTs = 4;
    rec.planning = true;
    await storage.save(rec);
    release();
    await generated(rec.id);
    expect(JSON.stringify(mocks.complete.mock.calls)).not.toContain("PLAN_REQUEST_SENTINEL");
    expect(JSON.stringify(mocks.complete.mock.calls)).not.toContain("PLAN_RESPONSE_SENTINEL");
    expect((await storage.load(rec.id))!.memory!.sourceRevision).toBe(revision);
    expect(await memory.creations(rec.id)).toEqual([expect.objectContaining({ messageTs: 2, status: "created" })]);
  });

  it("drops an automatic job whose final answer was removed instead of summarizing a replacement plan", async () => {
    const rec = await chat();
    const release = beginForeground(); releases.push(release);
    memory.enqueue(rec.id, false, 2);
    rec.messages = [
      { role: "user", content: "Plan instead", mode: "plan", ts: 3 },
      { role: "assistant", content: "Proposed plan", ts: 4 }
    ];
    await storage.save(rec);
    release();
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("missing"));
    expect(mocks.complete).not.toHaveBeenCalled();
    expect((await storage.load(rec.id))!.memory).toBeUndefined();
    expect(await memory.creations(rec.id)).toEqual([]);
  });

  it("keeps a queued card attached to the completed answer during the next turn's tool calls", async () => {
    const rec = await chat();
    const release = beginForeground(); releases.push(release);
    memory.enqueue(rec.id, false, 2);
    rec.messages.push({ role: "user", content: "next request", ts: 3 }, { role: "assistant", content: "Checking files", ts: 4 });
    await storage.save(rec);
    expect(await memory.creations(rec.id)).toMatchObject([{ messageTs: 2, status: "queued", operation: "create" }]);
    memory.reset();
  });

  it("cancels a waiting turn without aborting memory generation or leaking a reservation", async () => {
    const first = await chat(); const second = await chat("second");
    let finish!: (text: string) => void;
    mocks.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    memory.enqueue(first.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    memory.enqueue(second.id);
    const controller = new AbortController();
    const turn = memory.beginChatTurn(controller.signal, vi.fn());
    controller.abort();
    await expect(turn).rejects.toThrow();
    expect(foregroundBusy()).toBe(false);
    expect(mocks.complete.mock.calls[0][2].aborted).toBe(false);
    finish("Parser memory");
    await generated(second.id);
  });

  it("releases waiting turns after memory failure", async () => {
    const rec = await chat();
    let fail!: (error: Error) => void;
    mocks.complete.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    memory.enqueue(rec.id);
    await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    const turn = memory.beginChatTurn(new AbortController().signal, vi.fn());
    fail(new Error("offline"));
    const release = await turn; releases.push(release);
    expect((await memory.creations(rec.id))[0]).toMatchObject({ messageTs: 2, status: "failed" });
    expect(foregroundBusy()).toBe(true);
  });

  it.each(["", "Existing Parser summary"])("retains the operation after failure and retry with prior contents %j", async text => {
    const rec = await chat();
    if (text) await storage.updateMemory(rec.id, () => ({
      text, sourceRevision: "0".repeat(64), generatedAt: 1, enabled: true, manual: false
    }));
    const operation = text ? "update" : "create";
    mocks.complete.mockRejectedValueOnce(new Error("offline"));
    memory.enqueue(rec.id);
    await vi.waitFor(async () => expect((await memory.creations(rec.id))[0]).toMatchObject({ status: "failed", operation }));
    let finish!: (text: string) => void;
    mocks.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    memory.enqueue(rec.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect((await memory.creations(rec.id))[0]).toMatchObject({ status: "generating", operation });
    finish("Parser retry succeeded");
    await vi.waitFor(async () => expect((await memory.creations(rec.id))[0]).toMatchObject({ status: "created", operation }));
  });

  it("keeps manual creation inactive and preserves activation across editing and regeneration", async () => {
    const rec = await chat();
    await memory.edit(rec.id, "Manual Parser decision");
    expect((await storage.load(rec.id))!.memory!.enabled).toBe(false);
    for (const enabled of [false, true]) {
      await memory.setEnabled(rec.id, enabled);
      await memory.edit(rec.id, "Manual Parser decision");
      expect((await storage.load(rec.id))!.memory!.enabled).toBe(enabled);
      await memory.regenerate(rec.id);
      await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("ready"));
      expect((await storage.load(rec.id))!.memory!.enabled).toBe(enabled);
    }
  });

  it("uses bounded visible transcript chunks without tools, reasoning, or imported memories", async () => {
    const rec = await chat("parser ".repeat(6000) + ' password="hidden-secret"');
    rec.messages.push({ role: "tool", content: "RAW_TOOL_SENTINEL", ts: 3 });
    rec.messages[1].reasoningContent = "REASONING_SENTINEL";
    rec.contextMessages = [{ role: "system", content: "CONTEXT_SENTINEL", ts: 4 }];
    rec.recalledMemories = [{ sourceId: rec.id, title: "Imported", text: "IMPORTED_SENTINEL", generatedAt: 1, sourceRevision: transcriptRevision(rec) }];
    const text = await generateMemory(rec, mocks.settings.endpoint, "test", new AbortController().signal);
    expect(Math.ceil(text.length / 4)).toBeLessThanOrEqual(MEMORY_SUMMARY_TOKENS);
    expect(mocks.complete.mock.calls.length).toBeGreaterThan(1);
    for (const [, request] of mocks.complete.mock.calls) {
      const raw = JSON.stringify(request.messages);
      for (const forbidden of ["RAW_TOOL_SENTINEL", "REASONING_SENTINEL", "IMPORTED_SENTINEL", "CONTEXT_SENTINEL", "hidden-secret"]) expect(raw).not.toContain(forbidden);
      expect(request.background).toBe(true);
      expect(raw.length / 4 + request.max_tokens).toBeLessThan(8192);
    }
  });
  it("defers background work during foreground activity and retries preempted generation", async () => {
    mocks.settings.memoryEnabled = false;
    const rec = await chat();
    const end = beginForeground(); releases.push(end);
    await memory.regenerate(rec.id);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mocks.complete).not.toHaveBeenCalled();
    mocks.complete.mockImplementationOnce((_endpoint, _req, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    end();
    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(1));
    const pause = beginForeground(); releases.push(pause);
    await vi.waitFor(() => expect(mocks.complete.mock.calls[0][2].aborted).toBe(true));
    pause();
    await generated(rec.id);
    expect(mocks.complete).toHaveBeenCalledTimes(2);
  });
  it("ignores stale generation results and never overwrites a manual edit", async () => {
    const rec = await chat();
    let finish!: (text: string) => void;
    mocks.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    memory.enqueue(rec.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    rec.messages[0].content = "changed request";
    await storage.save(rec);
    finish("Old Parser decision");
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("missing"));
    expect((await storage.load(rec.id))!.memory).toBeUndefined();
    mocks.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    memory.enqueue(rec.id);
    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(2));
    await memory.edit(rec.id, "Manual Parser decision");
    finish("Generated Parser decision");
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("manual"));
    await storage.save(rec); // stale live session must preserve the manual edit
    expect((await storage.load(rec.id))!.memory!.text).toBe("Manual Parser decision");
  });
  it("exposes failures for retry and cancelling does not create a memory", async () => {
    const rec = await chat();
    mocks.complete.mockRejectedValueOnce(new Error("server offline"));
    memory.enqueue(rec.id);
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("failed"));
    expect((await storage.load(rec.id))!.messages).toEqual(rec.messages);
    await memory.regenerate(rec.id);
    await generated(rec.id);
    memory.reset();
    const second = await chat("second"); memory.enqueue(second.id); memory.reset();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await storage.load(second.id))!.memory).toBeUndefined();
  });
  it("keeps previous manual text inspectable when explicit regeneration fails", async () => {
    mocks.settings.memoryEnabled = false;
    const rec = await chat();
    await memory.edit(rec.id, "Manual Parser decision to retain");
    mocks.complete.mockRejectedValueOnce(new Error("server offline"));
    await memory.regenerate(rec.id);
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("failed"));
    expect((await storage.load(rec.id))!.memory!.text).toBe("Manual Parser decision to retain");
    await memory.regenerate(rec.id);
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("ready"));
    expect((await storage.load(rec.id))!.memory!.text).toBe("Parser uses exact revisions. Verified by tests.");
  });

  it("finishes summaries already queued while workspace memories were enabled", async () => {
    const rec = await chat(); memory.enqueue(rec.id);
    mocks.settings.memoryEnabled = false; memory.settingsChanged();
    await generated(rec.id);
    expect(mocks.complete).toHaveBeenCalledOnce();
  });
  it("does not revisit turn-completion eligibility during active generation", async () => {
    const rec = await chat();
    let finish!: (text: string) => void;
    mocks.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    memory.enqueue(rec.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    mocks.settings.memoryEnabled = false; memory.settingsChanged();
    expect(mocks.complete.mock.calls[0][2].aborted).toBe(false);
    finish("Parser decision");
    await generated(rec.id);
    expect(mocks.complete).toHaveBeenCalledOnce();
  });
  it("restarts active generation with the new model when settings change", async () => {
    const rec = await chat();
    mocks.complete.mockImplementationOnce((_endpoint, _req, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    memory.enqueue(rec.id);
    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledOnce());
    mocks.settings.model = "replacement"; memory.settingsChanged();
    await generated(rec.id);
    expect(mocks.complete.mock.calls[0][2].aborted).toBe(true);
    expect(mocks.complete.mock.calls[1][1].model).toBe("replacement");
  });
  it("skips individually excluded chats when context loading is disabled", async () => {
    mocks.settings.memoryEnabled = false;
    const rec = await chat();
    await memory.setEnabled(rec.id, false);
    memory.enqueue(rec.id);
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("stale"));
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
describe("workspace memory persistence", () => {
  it("rejects a save if the workspace changes during memory validation", async () => {
    const rec = await chat();
    const originalStorage = storage;
    let finish!: (tokens: number) => void;
    mocks.tokenize.mockImplementationOnce(() => new Promise<number>(resolve => { finish = resolve; }));
    const editing = memory.edit(rec.id, "A memory awaiting token validation");
    const rejected = expect(editing).rejects.toThrow("active workspace changed");
    await vi.waitFor(() => expect(finish).toBeDefined());
    storage = new ChatStorage(path.join(dir, "other-workspace"), path.join(dir, "chats"));
    finish(12);
    await rejected;
    expect((await originalStorage.load(rec.id))?.memory).toBeUndefined();
  });

  it("reports a failed save if its chat is deleted during validation", async () => {
    const rec = await chat();
    let finish!: (tokens: number) => void;
    mocks.tokenize.mockImplementationOnce(() => new Promise<number>(resolve => { finish = resolve; }));
    const editing = memory.edit(rec.id, "A memory whose chat is being deleted");
    const rejected = expect(editing).rejects.toThrow("chat is no longer available");
    await vi.waitFor(() => expect(finish).toBeDefined());
    await storage.delete(rec.id);
    finish(12);
    await rejected;
    expect(await storage.load(rec.id)).toBeUndefined();
  });

  it("lists memories and validates recalled snapshots without loading transcripts", async () => {
    const rec = await chat();
    await storage.updateMemory(rec.id, current => ({ text: "Parser decision", sourceRevision: transcriptRevision(current), generatedAt: 1, enabled: true, manual: false }));
    const load = vi.spyOn(storage, "load");
    const items = await memory.list();
    expect(items[0]).toMatchObject({ status: "ready", usable: true });
    const sources = await storage.metadata(true);
    const snapshots = rankMemories("parser", sources, "other");
    expect(await activeSnapshots(storage, snapshots)).toHaveLength(1);
    expect(load).not.toHaveBeenCalled();
  });

  it("reports eligibility for the cloud icon using the same rules as retrieval", async () => {
    const rec = await chat();
    expect((await memory.list())[0]).toMatchObject({ enabled: false, status: "missing", usable: false });
    await storage.updateMemory(rec.id, current => ({ text: "Parser decision", sourceRevision: transcriptRevision(current), generatedAt: 1, enabled: true, manual: false }));
    expect((await memory.list())[0]).toMatchObject({ status: "ready", usable: true });
    await memory.setEnabled(rec.id, false);
    expect((await memory.list())[0]).toMatchObject({ enabled: false, usable: false });
    await memory.setEnabled(rec.id, true);
    rec.messages[0].content = "Changed request";
    await storage.save(rec);
    expect((await memory.list())[0]).toMatchObject({ status: "stale", usable: false });
    await memory.edit(rec.id, "Manual Parser decision");
    expect((await memory.list())[0]).toMatchObject({ status: "manual", usable: true });
    await storage.updateMemory(rec.id, current => ({ ...current.memory!, error: "Generation failed" }));
    expect((await memory.list())[0]).toMatchObject({ status: "failed", usable: false });
    await storage.updateMemory(rec.id, current => ({ ...current.memory!, error: undefined, text: " " }));
    expect((await memory.list())[0].usable).toBe(false);
  });

  it("isolates workspace retrieval and removes excluded/deleted sources from snapshots", async () => {
    const rec = await chat(); await memory.edit(rec.id, "Parser decisions");
    await memory.setEnabled(rec.id, true);
    const candidates = await storage.records();
    const snapshots = rankMemories("parser", candidates, "new-chat");
    expect(await activeSnapshots(storage, snapshots)).toHaveLength(1);
    const other = new ChatStorage(path.join(dir, "other"), path.join(dir, "chats"));
    expect(await other.records()).toEqual([]);
    expect(await activeSnapshots(other, snapshots)).toEqual([]);
    await memory.setEnabled(rec.id, false);
    expect(await activeSnapshots(storage, snapshots)).toEqual([]);
    await memory.setEnabled(rec.id, true);
    await storage.delete(rec.id);
    expect(await activeSnapshots(storage, snapshots)).toEqual([]);
  });
  it("forks without inheriting a summary or recalled memory sources", async () => {
    const rec = await chat(); await memory.edit(rec.id, "Parser decisions");
    await memory.setEnabled(rec.id, true);
    const loaded = (await storage.load(rec.id))!;
    loaded.recalledMemories = rankMemories("parser", [loaded], "other");
    const fork = await storage.fork(loaded);
    expect(fork.memory).toBeUndefined(); expect(fork.recalledMemories).toBeUndefined();
  });
});

describe("durable memory attempts", () => {
  it("keeps a fresh successful memory eligible when regeneration fails", async () => {
    const rec = await chat();
    await memory.enqueue(rec.id); await generated(rec.id);
    const successful = (await storage.load(rec.id))!.memory;
    mocks.complete.mockRejectedValueOnce(new Error("server echoed password=private"));
    await memory.regenerate(rec.id);
    await vi.waitFor(async () => expect((await memory.list())[0]).toMatchObject({ status: "failed", usable: true }));
    const saved = (await storage.load(rec.id))!;
    expect(saved.memory).toEqual(successful);
    expect(saved.memoryAttempt?.diagnostic).toMatchObject({ stage: "generation", cause: "unavailable" });
    expect(JSON.stringify(saved)).not.toContain("private");
    expect(rankMemories("parser", [saved], "other")).toHaveLength(1);
  });

  it("preserves manual provenance while a replacement is pending or failed", async () => {
    const rec = await chat();
    await memory.edit(rec.id, "Manual Parser decision");
    await memory.setEnabled(rec.id, true);
    const previous = (await storage.load(rec.id))!.memory;
    const end = beginForeground(); releases.push(end);
    await memory.regenerate(rec.id);
    expect((await storage.load(rec.id))!.memory).toEqual(previous);
    mocks.complete.mockRejectedValueOnce(new Error("invalid response")); end();
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("failed"));
    expect((await storage.load(rec.id))!.memory).toEqual(previous);
  });

  it("retries transient failures twice and persists the exhausted diagnostics", async () => {
    const { StreamFailure } = await import("../src/llm/completion.js");
    await memory.dispose(); memory = new WorkspaceMemory(() => storage, 1, { retryDelay: () => 1 });
    const rec = await chat();
    mocks.complete.mockRejectedValue(new StreamFailure("secret server body", { cause: "unexpected_eof", completionEvidence: "none", completionTokens: 23 }));
    await memory.enqueue(rec.id);
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("failed"));
    expect(mocks.complete).toHaveBeenCalledTimes(3);
    const attempt = (await storage.load(rec.id))!.memoryAttempt!;
    expect(attempt).toMatchObject({ retries: 2, requests: 3, state: "failed", diagnostic: { stage: "generation", cause: "unexpected_eof", attempt: 3, completion: { completionTokens: 23 } } });
    await memory.dispose(); memory = new WorkspaceMemory(() => storage, 1);
    await memory.list();
    expect((await memory.creations(rec.id))[0]).toMatchObject({ status: "failed", attemptId: attempt.id });
    expect(mocks.complete).toHaveBeenCalledTimes(3);
  });

  it.each([400, 401, 403, 404])("does not automatically retry HTTP %i", async httpStatus => {
    const { StreamFailure } = await import("../src/llm/completion.js");
    const rec = await chat();
    mocks.complete.mockRejectedValue(new StreamFailure("secret", { cause: "server_error", httpStatus }));
    await memory.enqueue(rec.id);
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("failed"));
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect((await storage.load(rec.id))!.memoryAttempt?.diagnostic?.completion?.httpStatus).toBe(httpStatus);
  });

  it("releases a waiting foreground turn before a scheduled retry", async () => {
    const { StreamFailure } = await import("../src/llm/completion.js");
    let fail!: (error: Error) => void;
    const rec = await chat();
    mocks.complete.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    await memory.enqueue(rec.id);
    await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    const turn = memory.beginChatTurn(new AbortController().signal, vi.fn());
    fail(new StreamFailure("offline", { cause: "transport" }));
    releases.push(await turn);
    expect((await storage.load(rec.id))!.memoryAttempt?.state).toBe("retry_wait");
    expect(mocks.complete).toHaveBeenCalledOnce();
  });

  it("rejects stale and duplicate retry actions", async () => {
    const rec = await chat();
    mocks.complete.mockRejectedValueOnce(new Error("bad output"));
    await memory.enqueue(rec.id);
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("failed"));
    const attempt = (await storage.load(rec.id))!.memoryAttempt!;
    await memory.retry(rec.id, "stale-attempt");
    expect((await storage.load(rec.id))!.memoryAttempt?.id).toBe(attempt.id);
    const end = beginForeground(); releases.push(end);
    await memory.retry(rec.id, attempt.id);
    const fresh = (await storage.load(rec.id))!.memoryAttempt!;
    await memory.retry(rec.id, attempt.id);
    expect((await storage.load(rec.id))!.memoryAttempt?.id).toBe(fresh.id);
    expect(fresh.id).not.toBe(attempt.id); end();
    await generated(rec.id);
    expect(mocks.complete).toHaveBeenCalledTimes(2);
  });

  it("resumes queued jobs after reload and does not revive cancelled ones", async () => {
    const end = beginForeground(); releases.push(end);
    const first = await chat(); const second = await chat("second");
    await memory.enqueue(first.id);
    await memory.dispose(); memory = new WorkspaceMemory(() => storage, 1);
    expect((await memory.creations(first.id))[0].status).toBe("queued");
    await memory.cancelAll();
    await memory.enqueue(second.id);
    await memory.dispose(); memory = new WorkspaceMemory(() => storage, 1);
    await memory.list(); end();
    await generated(second.id);
    expect((await storage.load(first.id))!.memoryAttempt?.state).toBe("cancelled");
    expect((await storage.load(first.id))!.memory).toBeUndefined();
    expect(mocks.complete).toHaveBeenCalledOnce();
  });

  it("resumes validated chunks after preemption and reload without resummarizing them", async () => {
    const rec = await chat("Parser long transcript. ".repeat(2200));
    mocks.complete.mockResolvedValueOnce("Parser checkpoint one").mockImplementationOnce((_endpoint, _req, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    await memory.enqueue(rec.id);
    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(2));
    const checkpoint = (await storage.load(rec.id))!.memoryAttempt!.checkpoint!;
    expect(checkpoint.summary).toBe("Parser checkpoint one");
    const end = beginForeground(); releases.push(end);
    await vi.waitFor(async () => expect((await storage.load(rec.id))!.memoryAttempt?.state).toBe("queued"));
    expect((await storage.load(rec.id))!.memoryAttempt?.retries).toBe(0);
    await memory.dispose(); memory = new WorkspaceMemory(() => storage, 1);
    await memory.list(); end();
    await generated(rec.id);
    const resumed = JSON.parse(mocks.complete.mock.calls[2][1].messages[1].content);
    expect(resumed.priorDraft).toBe(checkpoint.summary);
    expect(resumed.conversation).toBe(JSON.parse(mocks.complete.mock.calls[1][1].messages[1].content).conversation);
  });

  it("retries a failed final save using validated output without another model request", async () => {
    const rec = await chat();
    const original = storage.maintainMemory.bind(storage);
    let failed = false;
    const write = vi.spyOn(storage, "maintainMemory").mockImplementation((id, update) => original(id, current => {
      const changed = update(current);
      if (current.memoryAttempt?.state === "succeeded" && !failed) { failed = true; throw new Error("disk full with secret path"); }
      return changed;
    }));
    await memory.enqueue(rec.id);
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("failed"));
    const attempt = (await storage.load(rec.id))!.memoryAttempt!;
    expect(attempt.diagnostic).toMatchObject({ stage: "storage", cause: "storage", retryable: false });
    expect(attempt.checkpoint?.complete).toBe(true);
    write.mockRestore();
    await memory.dispose(); memory = new WorkspaceMemory(() => storage, 1);
    await memory.retry(rec.id, attempt.id);
    await generated(rec.id);
    expect(mocks.complete).toHaveBeenCalledOnce();
  });

  it("reports failures even if recording their status also fails", async () => {
    const reportError = vi.fn();
    await memory.dispose(); memory = new WorkspaceMemory(() => storage, 1, { reportError });
    const rec = await chat();
    const original = storage.maintainMemory.bind(storage);
    const write = vi.spyOn(storage, "maintainMemory").mockImplementation((id, update) => original(id, current => {
      const changed = update(current);
      if (["succeeded", "failed"].includes(current.memoryAttempt?.state ?? "")) throw new Error("disk full");
      return changed;
    }));
    await memory.enqueue(rec.id);
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(expect.stringContaining("could not be saved")));
    const card = (await memory.creations(rec.id))[0];
    expect(card).toMatchObject({ status: "failed", diagnostic: { stage: "storage" } });
    write.mockRestore();
    await memory.retry(rec.id, card.attemptId!);
    await generated(rec.id);
    expect(mocks.complete).toHaveBeenCalledOnce();
  });

  it("keeps the retry budget across a reload during backoff", async () => {
    const { StreamFailure } = await import("../src/llm/completion.js");
    await memory.dispose(); memory = new WorkspaceMemory(() => storage, 1, { retryDelay: () => 100 });
    const rec = await chat();
    mocks.complete.mockRejectedValue(new StreamFailure("offline", { cause: "transport" }));
    await memory.enqueue(rec.id);
    await vi.waitFor(async () => expect((await storage.load(rec.id))!.memoryAttempt).toMatchObject({ state: "retry_wait", retries: 1 }));
    await memory.dispose(); memory = new WorkspaceMemory(() => storage, 1, { retryDelay: () => 1 });
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("failed"));
    expect(mocks.complete).toHaveBeenCalledTimes(3);
  });

  it("bounds total active work independently of the per-request timeout", async () => {
    await memory.dispose(); memory = new WorkspaceMemory(() => storage, 1, { budgetMs: 200 });
    const rec = await chat();
    mocks.complete.mockImplementationOnce((_endpoint, _req, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    await memory.enqueue(rec.id);
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("failed"));
    expect((await storage.load(rec.id))!.memoryAttempt?.diagnostic).toMatchObject({ cause: "budget", retryable: false });
    expect(mocks.complete).toHaveBeenCalledOnce();
  });

  it("requires exact tokenization and preserves the failing stage", async () => {
    const rec = await chat("Unique tokenizer failure input: 漢字漢字");
    mocks.tokenize.mockRejectedValue(new Error("tokenizer not supported"));
    await memory.enqueue(rec.id);
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("failed"));
    expect((await storage.load(rec.id))!.memoryAttempt?.diagnostic).toMatchObject({ stage: "tokenization", retryable: false });
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});

describe("memory recovery invalidation", () => {
  it("preserves retry allowances and the previous summary when a backend switch invalidates a checkpoint", async () => {
    const { memorySignature, newMemoryAttempt } = await import("../src/chat/memoryJobs.js");
    const rec = await chat();
    await memory.dispose();
    const attempt = newMemoryAttempt(rec, memorySignature(mocks.settings.endpoint, mocks.settings.model, "llama.cpp"), true)!;
    attempt.retries = 2;
    attempt.requests = 3;
    attempt.checkpoint = { summary: "Incompatible checkpoint", offset: 4 };
    await storage.maintainMemory(rec.id, current => {
      current.memoryAttempt = attempt;
      current.memory = { text: "Last successful memory", generatedAt: 1, sourceRevision: transcriptRevision(rec), enabled: true, manual: false };
      return true;
    });
    mocks.settings.serverType = "vllm";
    mocks.complete.mockRejectedValueOnce(new Error("Model unavailable"));
    memory = new WorkspaceMemory(() => storage, 1);
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("failed"));
    const saved = (await storage.load(rec.id))!;
    expect(saved.memory?.text).toBe("Last successful memory");
    expect(saved.memoryAttempt).toMatchObject({ retries: 2, requests: 4, signature: memorySignature(mocks.settings.endpoint, mocks.settings.model, "vllm") });
    expect(saved.memoryAttempt?.checkpoint).toBeUndefined();
    expect(JSON.parse(mocks.complete.mock.calls[0][1].messages[1].content).priorDraft).toBe("");
  });

  it("retains a compatible completed legacy llama.cpp checkpoint after reload", async () => {
    const { legacyMemorySignature, newMemoryAttempt } = await import("../src/chat/memoryJobs.js");
    const { memoryInput } = await import("../src/chat/memoryGeneration.js");
    const rec = await chat();
    await memory.dispose();
    const attempt = newMemoryAttempt(rec, legacyMemorySignature(mocks.settings.endpoint, mocks.settings.model), true)!;
    attempt.checkpoint = { summary: "Parser legacy checkpoint", offset: memoryInput(rec).length, complete: true };
    attempt.retries = 1;
    await storage.maintainMemory(rec.id, current => { current.memoryAttempt = attempt; return true; });
    memory = new WorkspaceMemory(() => storage, 1);
    await generated(rec.id);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect((await storage.load(rec.id))?.memoryAttempt?.retries).toBe(1);
  });

  it("discards checkpoints when the model changes", async () => {
    const rec = await chat("Parser source for model invalidation. ".repeat(2000));
    mocks.complete.mockResolvedValueOnce("Parser first checkpoint").mockRejectedValueOnce(new Error("bad response"));
    await memory.enqueue(rec.id);
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("failed"));
    const attempt = (await storage.load(rec.id))!.memoryAttempt!;
    expect(attempt.checkpoint?.summary).toBe("Parser first checkpoint");
    mocks.settings.model = "replacement-model";
    await memory.retry(rec.id, attempt.id);
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("ready"));
    const first = JSON.parse(mocks.complete.mock.calls[0][1].messages[1].content);
    const restarted = JSON.parse(mocks.complete.mock.calls[2][1].messages[1].content);
    expect(restarted).toEqual(first);
    expect(mocks.complete.mock.calls[2][1].model).toBe("replacement-model");
  });

  it("does not retry a failed card against an edited source", async () => {
    const rec = await chat();
    mocks.complete.mockRejectedValueOnce(new Error("bad output"));
    await memory.enqueue(rec.id);
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("failed"));
    const attempt = (await storage.load(rec.id))!.memoryAttempt!;
    rec.messages[0].content = "Changed source"; await storage.save(rec);
    await memory.retry(rec.id, attempt.id);
    expect(mocks.complete).toHaveBeenCalledOnce();
    await memory.regenerate(rec.id); await generated(rec.id);
    expect(mocks.complete.mock.calls[1][1].messages[1].content).toContain("Changed source");
  });

  it("counts a process interruption against the saved recovery limit", async () => {
    const rec = await chat(); const end = beginForeground(); releases.push(end);
    await memory.enqueue(rec.id);
    await storage.maintainMemory(rec.id, current => {
      current.memoryAttempt = { ...current.memoryAttempt!, state: "generating", retries: 2, requests: 3, startedAt: Date.now() }; return true;
    });
    await memory.dispose(); memory = new WorkspaceMemory(() => storage, 1);
    await memory.list(); end();
    expect((await storage.load(rec.id))!.memoryAttempt).toMatchObject({ state: "failed", retries: 3, diagnostic: { cause: "unexpected_eof" } });
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});

it("keeps a job resumable when foreground preemption races a checkpoint write", async () => {
  const rec = await chat();
  const original = storage.maintainMemory.bind(storage);
  let pause: (() => void) | undefined;
  const write = vi.spyOn(storage, "maintainMemory").mockImplementation((id, update) => original(id, current => {
    if (!pause && current.memoryAttempt?.state === "generating" && current.memoryAttempt.requests === 1 && mocks.complete.mock.calls.length === 1) {
      pause = beginForeground(); releases.push(pause);
    }
    return update(current);
  }));
  await memory.enqueue(rec.id);
  await vi.waitFor(async () => expect((await storage.load(rec.id))!.memoryAttempt).toMatchObject({ state: "queued", checkpoint: { complete: true } }));
  write.mockRestore(); pause!();
  await generated(rec.id);
  expect(mocks.complete).toHaveBeenCalledOnce();
});

it("suspends jobs in their own workspace and resumes them when returning", async () => {
  const first = await chat(); const original = storage;
  const end = beginForeground(); releases.push(end);
  await memory.enqueue(first.id);
  memory.suspend();
  storage = new ChatStorage(path.join(dir, "another-workspace"), path.join(dir, "chats"));
  await memory.restore();
  const second = await chat("Second workspace Parser");
  await memory.enqueue(second.id); end(); await generated(second.id);
  expect((await original.load(first.id))!.memoryAttempt?.state).toBe("queued");
  expect(mocks.complete).toHaveBeenCalledOnce();
  memory.suspend(); storage = original; await memory.restore();
  await generated(first.id);
  expect(mocks.complete).toHaveBeenCalledTimes(2);
});
