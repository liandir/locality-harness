import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore, noteRevision } from "../src/chat/memoryStore.js";
import { WorkspaceMemory } from "../src/chat/workspaceMemory.js";
import { ChatStorage } from "../src/chat/storage.js";
import { writeAtomic } from "../src/chat/chatFile.js";
import { transcriptRevision } from "../src/chat/memory.js";
import { rankWorkspaceNotes, searchWorkspaceNotes } from "../src/chat/workspaceNotes.js";
vi.mock("../src/chat/chatFile.js", async original => {
  const actual = await original<typeof import("../src/chat/chatFile.js")>();
  return { ...actual, writeAtomic: vi.fn(actual.writeAtomic) };
});
let root: string, store: MemoryStore;
const disposables: { dispose(): void }[] = [];
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "locality-notes-")); store = new MemoryStore(root); });
afterEach(async () => { disposables.splice(0).forEach(d => d.dispose()); vi.clearAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
const input = { name: "Parser cache", contents: "Use grammar version in parser cache keys." };

describe("workspace note storage", () => {
  it("creates lazily, stores independent versioned JSON, and reuses exact duplicates across windows", async () => {
    expect(await store.list()).toEqual({ memories: [], warnings: [] });
    await expect(fs.stat(path.join(root, ".locality"))).rejects.toMatchObject({ code: "ENOENT" });
    const other = new MemoryStore(root);
    const results = await Promise.all([store.save(input), other.save(input)]);
    expect(results.map(result => result.operation).sort()).toEqual(["created", "unchanged"]);
    expect(results[0].note.id).toBe(results[1].note.id);
    const note = results[0].note;
    expect(JSON.parse(await fs.readFile(path.join(root, ".locality/memories", note.id + ".json"), "utf8"))).toEqual(note);
    expect(Object.keys(note).sort()).toEqual(["version", "id", "name", "contents", "createdAt", "updatedAt", "enabled"].sort());
    expect((await store.save({ ...input, contents: "A different fact" })).note.id).not.toBe(note.id);
  });
  it("requires a current recall, preserves identity and state, and rejects simultaneous stale updates", async () => {
    let note = (await store.save(input)).note;
    await expect(store.save({ ...input, id: note.id })).rejects.toThrow("Recall");
    await store.setEnabled(note.id, false, noteRevision(note));
    note = await store.get(note.id);
    const updates = await Promise.allSettled([
      store.save({ id: note.id, name: "New title", contents: "First update" }, noteRevision(note)),
      new MemoryStore(root).save({ id: note.id, name: "Other title", contents: "Second update" }, noteRevision(note))
    ]);
    expect(updates.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const saved = await store.get(note.id);
    expect(saved).toMatchObject({ id: note.id, createdAt: note.createdAt, enabled: false });
    expect(saved.updatedAt).toBeGreaterThan(note.updatedAt);
    await expect(store.delete(note.id, noteRevision(note))).rejects.toThrow("Recall");
    await store.delete(note.id, noteRevision(saved));
    await expect(store.get(note.id)).rejects.toThrow("no longer exists");
  });
  it.each([{ name: " ", contents: "Valid" }, { name: "a".repeat(201), contents: "Valid" }, { name: "Valid", contents: " " }, { name: "Valid", contents: "a".repeat(20001) }])("rejects invalid note input without writing", async value => {
    await expect(store.save(value)).rejects.toThrow();
    expect((await store.list()).memories).toEqual([]);
  });
  it("redacts secrets, preserves successful content after failed writes, and detects external edits", async () => {
    const note = (await store.save({ ...input, contents: 'password="keep-secret" Bearer abc.def' })).note;
    expect(note.contents).not.toContain("keep-secret"); expect(note.contents).not.toContain("abc.def");
    vi.mocked(writeAtomic).mockRejectedValueOnce(new Error("disk full"));
    await expect(store.save({ ...input, id: note.id }, noteRevision(note))).rejects.toThrow("disk full");
    expect(await store.get(note.id)).toEqual(note);
    const file = path.join(root, ".locality/memories", note.id + ".json");
    await fs.writeFile(file, JSON.stringify({ ...note, contents: "External change" }));
    await expect(store.save({ ...input, id: note.id }, noteRevision(note))).rejects.toThrow("Recall");
    expect((await store.get(note.id)).contents).toBe("External change");
  });
  it("excludes corrupt, oversized, mismatched, and invalid-version records individually without overwriting them", async () => {
    const note = (await store.save(input)).note;
    const directory = path.join(root, ".locality/memories");
    await fs.writeFile(path.join(directory, "broken.json"), "{");
    await fs.writeFile(path.join(directory, "11111111-1111-1111-1111-111111111111.json"), JSON.stringify({ ...note, version: 2 }));
    await fs.writeFile(path.join(directory, "22222222-2222-2222-2222-222222222222.json"), " ".repeat(150_001));
    await fs.writeFile(path.join(directory, "33333333-3333-3333-3333-333333333333.json"), JSON.stringify(note));
    await fs.writeFile(path.join(directory, "44444444-4444-4444-4444-444444444444.json"), JSON.stringify({ ...note, id: "44444444-4444-4444-4444-444444444444", chatId: "legacy" }));
    const listing = await store.list();
    expect(listing.memories).toEqual([note]); expect(listing.warnings).toHaveLength(5);
    await store.save({ name: "Unrelated", contents: "Note" });
    expect(await fs.readFile(path.join(directory, "broken.json"), "utf8")).toBe("{");
    await expect(store.save({ ...input, id: "11111111-1111-1111-1111-111111111111" }, "anything")).rejects.toThrow("Invalid memory record");
  });
  it("blocks invalid IDs and directory symlinks escaping the workspace", async () => {
    await expect(store.get("../outside")).rejects.toThrow("Invalid memory ID");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "locality-notes-outside-"));
    try {
      await fs.mkdir(path.join(root, ".locality"));
      await fs.symlink(outside, path.join(root, ".locality/memories"), "junction");
      await expect(store.save(input)).rejects.toThrow("outside the workspace");
      await expect(store.list()).rejects.toThrow("outside the workspace");
      expect(await fs.readdir(outside)).toEqual([]);
    } finally { await fs.rm(path.join(root, ".locality/memories"), { force: true }); await fs.rm(outside, { recursive: true, force: true }); }
  });
  it("watches lazy directories and external edits and isolates workspace changes", async () => {
    let active = root;
    const service = new WorkspaceMemory(() => active); disposables.push(service);
    const changed = vi.fn(); disposables.push(service.onChange(changed));
    await new Promise(resolve => setTimeout(resolve, 100));
    const note = (await store.save(input)).note;
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 100)); changed.mockClear();
    await fs.writeFile(path.join(root, ".locality/memories", note.id + ".json"), JSON.stringify({ ...note, contents: "External" }));
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect((await service.list()).memories[0].contents).toBe("External");
    active = path.join(root, "other"); await fs.mkdir(active); service.workspaceChanged();
    expect((await service.list()).memories).toEqual([]);
  });
  it("never imports legacy summaries or resumes jobs, and clearing chats preserves notes", async () => {
    const chats = new ChatStorage(root, path.join(root, "old-chats"));
    const chat = chats.newRecord("native");
    chat.memory = { text: "Legacy summary", sourceRevision: transcriptRevision(chat), generatedAt: 1, enabled: true, manual: false };
    await chats.save(chat);
    expect((await store.list()).memories).toEqual([]);
    const note = (await store.save(input)).note;
    await chats.deleteAll();
    expect(await store.get(note.id)).toEqual(note);
  });
});

describe("independent note retrieval", () => {
  it("ranks names, paths and camelCase terms, caps matches, and excludes disabled/unrelated notes", async () => {
    const first = (await store.save(input)).note;
    const second = (await store.save({ name: "Storage", contents: "src/chat/storage.ts uses saveRecord." })).note;
    expect(rankWorkspaceNotes("parser", [first, second])).toEqual([first]);
    expect(rankWorkspaceNotes("saveRecord storage.ts", [first, second])).toEqual([second]);
    expect(rankWorkspaceNotes("please continue", [first, second])).toEqual([]);
    expect(rankWorkspaceNotes("parser", [{ ...first, enabled: false }])).toEqual([]);
    const search = searchWorkspaceNotes("parser storage", [first, second], 1);
    expect(search).toMatchObject({ total: 2, truncated: true }); expect(search.memories).toHaveLength(1);
    expect(JSON.stringify(search)).not.toContain("contents");
  });
});

it("refuses a queued mutation when its workspace or turn is no longer active", async () => {
  const { withStorageLock } = await import("../src/chat/storageLock.js");
  const note = (await store.save(input)).note;
  let active = true;
  const guarded = new MemoryStore(root, () => active);
  let entered!: () => void, release!: () => void;
  const acquired = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const lock = withStorageLock(path.join(root, ".locality/memories/.lock"), async () => { entered(); await hold; });
  await acquired;
  const pending = guarded.save({ ...input, contents: "Late change", id: note.id }, noteRevision(note));
  const rejected = expect(pending).rejects.toThrow("cancelled or its workspace changed");
  active = false; release(); await lock; await rejected;
  expect(await store.get(note.id)).toEqual(note);
});
