import { randomUUID } from "node:crypto";
import { noteRevision, type MemoryStore } from "../chat/memoryStore.js";
import type { WorkspaceMemory } from "../chat/workspaceMemory.js";
import type { WorkspaceNote } from "../chat/workspaceNotes.js";
import type { MemoryEditor, MemoryPanelState } from "./messaging.js";

/** Host-owned inline editors. Drafts survive sidebar reloads and stay in their workspace. */
export class MemoryPanel {
  private store?: MemoryStore;
  private editors = new Map<string, MemoryEditor>();
  private activeKey?: string;
  private openGeneration = 0;
  constructor(private memory: WorkspaceMemory, private publish: (panel: MemoryPanelState) => void) {}

  private current(): MemoryStore | undefined {
    const store = this.memory.current();
    if (store !== this.store) {
      this.store = store;
      this.editors.clear();
      this.activeKey = undefined;
      this.openGeneration++;
    }
    return store;
  }
  refresh(): void {
    this.current();
    this.publish({ editors: [...this.editors.values()].map(editor => ({ ...editor })), activeKey: this.activeKey });
  }
  create(): void {
    if (!this.current()) throw new Error("Open a workspace before creating a memory.");
    this.openGeneration++;
    let editor = [...this.editors.values()].find(editor => !editor.id);
    if (!editor) {
      editor = { key: randomUUID(), name: "", contents: "", mode: "name", draftName: "", draftContents: "" };
      this.editors.set(editor.key, editor);
    }
    this.activeKey = editor.key;
    this.refresh();
  }
  async open(id: string, mode: MemoryEditor["mode"]): Promise<void> {
    const store = this.current();
    const generation = ++this.openGeneration;
    if (!store) throw new Error("Open a workspace to view memories.");
    let editor = [...this.editors.values()].find(editor => editor.id === id);
    if (editor?.busy) return;
    if (!editor || (editor.mode === "view" && editor.draftContents === editor.contents && editor.draftName === editor.name)) {
      const previousKey = editor?.key;
      const note = await store.get(id);
      if (store !== this.current() || generation !== this.openGeneration) return;
      if (previousKey) this.editors.delete(previousKey);
      editor = this.fromNote(note, mode);
      this.editors.set(editor.key, editor);
    } else editor.mode = mode;
    this.activeKey = editor.key;
    this.refresh();
  }
  private fromNote(note: WorkspaceNote, mode: MemoryEditor["mode"], key: string = randomUUID()): MemoryEditor {
    return { key, id: note.id, name: note.name, contents: note.contents, revision: noteRevision(note),
      mode, draftName: note.name, draftContents: note.contents };
  }
  update(key: string, draft: { name?: string; contents?: string }): void {
    this.current();
    const editor = this.editors.get(key);
    if (!editor || editor.busy) return;
    if (editor.mode === "name" && typeof draft.name === "string") editor.draftName = draft.name.slice(0, 201);
    if (editor.mode === "edit" && typeof draft.contents === "string") editor.draftContents = draft.contents.slice(0, 20_001);
  }
  activateDraft(key: string, mode: MemoryEditor["mode"]): void {
    this.current();
    this.openGeneration++;
    const editor = this.editors.get(key);
    if (!editor || editor.id || editor.busy) return;
    editor.mode = editor.name ? mode : "name";
    this.activeKey = key;
    this.refresh();
  }
  async save(key: string): Promise<void> {
    const store = this.current(), editor = this.editors.get(key);
    if (!store || !editor || editor.busy || editor.mode === "view") return;
    const naming = editor.mode === "name";
    const name = naming ? editor.draftName.trim() : editor.name;
    if (!name || name.length > 200) {
      editor.error = "Enter a name with 1–200 characters.";
      this.refresh(); return;
    }
    if (naming && !editor.id) {
      editor.name = name; editor.draftName = name; editor.mode = "edit"; editor.error = undefined;
      this.refresh(); return;
    }
    editor.busy = true; editor.error = undefined; this.refresh();
    try {
      const result = await store.save({ id: editor.id, name, contents: naming ? editor.contents : editor.draftContents }, editor.revision);
      if (store !== this.current() || this.editors.get(key) !== editor) return;
      const saved = this.fromNote(result.note, "view", key);
      if (naming && editor.draftContents !== editor.contents) saved.draftContents = editor.draftContents;
      this.editors.set(key, saved);
      this.memory.changed();
    } catch (error) {
      if (store !== this.current() || this.editors.get(key) !== editor) return;
      editor.busy = false;
      editor.error = error instanceof Error ? error.message : "Could not save this memory.";
    }
    this.refresh();
  }
  cancel(key: string): void {
    this.current();
    const editor = this.editors.get(key);
    if (!editor || editor.busy) return;
    if (!editor.id && !editor.name) { this.editors.delete(key); this.activeKey = undefined; }
    else {
      editor.draftName = editor.name; editor.draftContents = editor.contents;
      editor.mode = "view"; editor.error = undefined;
    }
    this.refresh();
  }
  close(key: string): void {
    this.current();
    this.openGeneration++;
    if (this.activeKey === key) this.activeKey = undefined;
    this.refresh();
  }
  remove(id: string): void {
    this.current();
    this.openGeneration++;
    for (const [key, editor] of this.editors) if (editor.id === id || key === id) {
      if (editor.busy) continue;
      this.editors.delete(key);
      if (this.activeKey === key) this.activeKey = undefined;
    }
    this.refresh();
  }
  reconcile(notes: WorkspaceNote[]): void {
    this.current();
    for (const [key, editor] of this.editors) {
      if (!editor.id || editor.busy) continue;
      const note = notes.find(note => note.id === editor.id);
      const clean = editor.mode === "view" && editor.draftName === editor.name && editor.draftContents === editor.contents;
      if (note && clean) this.editors.set(key, this.fromNote(note, "view", key));
      else if (!note && clean) {
        this.editors.delete(key);
        if (this.activeKey === key) this.activeKey = undefined;
      } else if (!note) editor.error = "This memory no longer exists. Your draft is still available to copy.";
    }
    this.refresh();
  }
}
