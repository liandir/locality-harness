import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryPanel } from "../src/ui/memoryPanel.js";
import { WorkspaceMemory } from "../src/chat/workspaceMemory.js";
import { noteRevision } from "../src/chat/memoryStore.js";
import type { MemoryPanelState } from "../src/ui/messaging.js";

let directory: string, root: string, memory: WorkspaceMemory, panel: MemoryPanel, state: MemoryPanelState;
const active = () => state.editors.find(editor => editor.key === state.activeKey)!;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "locality-memory-panel-"));
  root = path.join(directory, "one"); await fs.mkdir(root);
  memory = new WorkspaceMemory(() => root);
  state = { editors: [] };
  panel = new MemoryPanel(memory, value => { state = structuredClone(value); });
});
afterEach(async () => { memory.dispose(); await fs.rm(directory, { recursive: true, force: true }); });

describe("inline workspace memories", () => {
  it("names a new draft before editing contents and only persists a complete note", async () => {
    panel.create(); const key = active().key;
    expect(active().mode).toBe("name");
    await panel.save(key); expect(active().error).toContain("name");
    panel.update(key, { name: "Parser" }); await panel.save(key);
    expect(active()).toMatchObject({ name: "Parser", mode: "edit", draftContents: "" });
    expect((await memory.list()).memories).toEqual([]);
    panel.update(key, { contents: "Use **grammar versions**." });
    panel.refresh(); expect(active().draftContents).toContain("grammar versions");
    await panel.save(key);
    expect(active()).toMatchObject({ name: "Parser", mode: "view", contents: "Use **grammar versions**." });
    expect((await memory.list()).memories).toHaveLength(1);
    expect(active().id).toBeDefined();
  });
  it("preserves edits across collapse, another selection, and sidebar reload", async () => {
    const one = (await memory.current()!.save({ name: "Parser", contents: "First" })).note;
    const two = (await memory.current()!.save({ name: "Colors", contents: "Second" })).note;
    await panel.open(one.id, "edit"); const key = active().key;
    panel.update(key, { contents: "Unsaved changes" }); panel.close(key);
    await panel.open(two.id, "view"); await panel.open(one.id, "edit"); panel.refresh();
    expect(active()).toMatchObject({ key, draftContents: "Unsaved changes" });
    panel.cancel(key); expect(active()).toMatchObject({ mode: "view", contents: "First", draftContents: "First" });
    expect((await memory.current()!.get(one.id)).contents).toBe("First");
  });
  it("retains failed saves and rejects stale revisions after an external edit", async () => {
    const store = memory.current()!;
    const note = (await store.save({ name: "Parser", contents: "Original" })).note;
    await panel.open(note.id, "edit"); const key = active().key;
    panel.update(key, { contents: "My edit" });
    vi.spyOn(store, "save").mockRejectedValueOnce(new Error("Disk is full"));
    await panel.save(key); expect(active()).toMatchObject({ mode: "edit", draftContents: "My edit", error: "Disk is full", busy: false });
    await store.save({ ...note, contents: "External edit" }, noteRevision(note));
    panel.reconcile((await store.list()).memories);
    await panel.save(key); expect(active().error).toContain("changed");
    expect((await store.get(note.id)).contents).toBe("External edit");
    panel.cancel(key); await panel.open(note.id, "edit");
    expect(active().draftContents).toBe("External edit");
    panel.update(key, { contents: "Stale editor action" }); await panel.save(key);
    expect((await store.get(note.id)).contents).toBe("External edit");
  });
  it("refreshes viewed notes but keeps drafts recoverable after external deletion", async () => {
    const store = memory.current()!, note = (await store.save({ name: "Parser", contents: "Original" })).note;
    await panel.open(note.id, "view");
    const updated = (await store.save({ ...note, contents: "External" }, noteRevision(note))).note;
    panel.reconcile([updated]); expect(active().contents).toBe("External");
    await panel.open(note.id, "edit"); const key = active().key;
    panel.update(key, { contents: "Unsaved" });
    await store.delete(updated.id, noteRevision(updated)); panel.reconcile([]);
    expect(active()).toMatchObject({ draftContents: "Unsaved", error: expect.stringContaining("no longer exists") });
    await panel.save(key); expect((await store.list()).memories).toEqual([]);
    expect(active().draftContents).toBe("Unsaved");
  });
  it("clears drafts on workspace changes and ignores old save actions", async () => {
    panel.create(); const key = active().key;
    panel.update(key, { name: "Parser" }); await panel.save(key);
    panel.update(key, { contents: "Should not cross workspaces" });
    root = path.join(directory, "two"); await fs.mkdir(root);
    panel.refresh(); await panel.save(key);
    expect(state).toEqual({ editors: [], activeKey: undefined });
    expect((await memory.list()).memories).toEqual([]);
  });
  it("does not let a delayed open replace the latest selection", async () => {
    const store = memory.current()!;
    const first = (await store.save({ name: "One", contents: "First" })).note;
    const second = (await store.save({ name: "Two", contents: "Second" })).note;
    let release!: (note: typeof first) => void;
    vi.spyOn(store, "get").mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const opening = panel.open(first.id, "view");
    await panel.open(second.id, "view"); release(first); await opening;
    expect(active().id).toBe(second.id);
    vi.mocked(store.get).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const removedOpening = panel.open(first.id, "view");
    panel.remove(first.id); release(first); await removedOpening;
    expect(active().id).toBe(second.id);
    expect(state.editors.some(editor => editor.id === first.id)).toBe(false);
  });
});
