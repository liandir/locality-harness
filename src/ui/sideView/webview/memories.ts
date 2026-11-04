import MarkdownIt from "markdown-it";
import { escapeHtml as esc } from "../../html.js";
import { memoryIcon, pencilIcon, plusIcon, searchIcon, trashIcon } from "../../icons.js";
import { checkIcon, closeIcon } from "../../chatView/webview/icons.js";
import type { ChatContextAction } from "../../chatContextMenu.js";
import type { ManagedMemory, MemoryEditor, SideToExt } from "../../messaging.js";
import type { SideViewState } from "./types.js";

const md = new MarkdownIt({ html: false, breaks: true });
const draftId = (key: string): string => `draft:${key}`;
const editorFor = (state: SideViewState, id: string): MemoryEditor | undefined => state.memoryPanel.editors.find(editor => editor.id === id || draftId(editor.key) === id);

export function renderMemories(state: SideViewState, ago: (ts: number) => string): string {
  const query = (state.memorySearch ?? "").trim().toLowerCase();
  const notes = state.memories.filter(note => !query || (note.name + " " + note.contents).toLowerCase().includes(query));
  const drafts = state.memoryPanel.editors.filter(editor => !editor.id);
  // Keep an unsaved edit recoverable even if another window deletes its note.
  const missing = state.memoryPanel.editors.filter(editor => editor.id && !state.memories.some(note => note.id === editor.id));
  const rows = [...drafts, ...missing].map(editor => renderEntry(state, undefined, editor, ago))
    .concat(notes.map(note => renderEntry(state, note, editorFor(state, note.id), ago)));
  return `<div class="panel chats-panel memories-panel">
    <section class="panel-section"><button id="newMemory" class="action-btn welcome-button icon-label">${plusIcon()}<span>Create new memory</span></button></section>
    <section class="panel-section"><h3>Find</h3><div class="search-box">${searchIcon()}<input id="memorySearch" type="search" aria-label="Search memories" placeholder="Search memories" value="${esc(state.memorySearch ?? "")}" /></div></section>
    <section class="panel-section"><h3>Memories</h3>
      ${state.memoryError ? `<p class="memory-error" role="alert">${esc(state.memoryError)}</p>` : ""}
      ${(state.memoryWarnings ?? []).map(warning => `<p class="memory-error" role="alert">${esc(warning)}</p>`).join("")}
      ${rows.length ? `<ul class="chat-list">${rows.join("")}</ul>` : `<p class="empty-state">${query ? "No matching memories." : "No memories yet."}</p>`}
      ${state.memories.length || drafts.length ? `<button id="clearMemories" class="action-btn wide-button danger icon-label clear-chats" ${state.memoryPanel.editors.some(editor => editor.busy) ? "disabled" : ""}>${trashIcon()}<span>Clear all memories</span></button>` : ""}
    </section>
  </div>`;
}

function editorActions(editor: MemoryEditor, naming: boolean): string {
  return `<div class="memory-edit-actions">
    <button class="action-btn icon-btn icon-btn-compact" id="memory-cancel-${editor.key}" type="button" data-memory-cancel="${editor.key}" data-tip="Cancel edit" aria-label="Cancel edit" ${editor.busy ? "disabled" : ""}>${closeIcon()}</button>
    <button class="action-btn icon-btn icon-btn-compact" id="memory-save-${editor.key}" type="button" data-memory-save="${editor.key}" data-tip="${naming ? "Confirm name" : "Save memory"}" aria-label="${naming ? "Confirm name" : "Save memory"}" ${editor.busy ? "disabled" : ""}>${checkIcon()}</button>
  </div>`;
}

function renderEntry(state: SideViewState, note: ManagedMemory | undefined, editor: MemoryEditor | undefined, ago: (ts: number) => string): string {
  const id = note?.id ?? (editor!.id || draftId(editor!.key));
  const active = !!editor && editor.key === state.memoryPanel.activeKey;
  const name = note?.name ?? editor!.name;
  const enabled = note?.enabled ?? false;
  const naming = active && editor.mode === "name";
  const dot = `<span class="chat-running-dot memory-enabled-dot${enabled ? " enabled" : ""}" aria-label="${enabled ? "Active memory" : "Inactive memory"}"></span>`;
  const header = naming ? `<div class="memory-name-row">${dot}<input id="memory-name-${editor.key}" data-memory-name="${editor.key}" type="text" maxlength="200" aria-label="Memory name" placeholder="Memory name" value="${esc(editor.draftName)}" ${editor.busy ? "disabled" : ""} />${editorActions(editor, true)}</div>`
    : `<div class="chat-row memory-row disclosure-trigger" id="memory-row-${esc(id)}" data-memory-open="${esc(id)}" data-memory-context="${esc(id)}" tabindex="0" role="button" aria-expanded="${active}">
      ${dot}<span class="chat-row-title">${esc(name || "New memory")}</span>${note ? `<time>${ago(note.updatedAt)}</time>` : ""}
      <button class="icon-btn icon-btn-compact delete" type="button" data-memory-delete="${esc(id)}" data-tip="Delete" aria-label="Delete memory">${trashIcon()}</button>
    </div>`;
  const contents = !active || naming ? "" : `<div class="memory-details">
    ${editor.mode === "edit" ? `<textarea id="memory-contents-${editor.key}" class="memory-content-input" data-memory-contents="${editor.key}" aria-label="Memory contents" rows="6" maxlength="20000" ${editor.busy ? "disabled" : ""}>${esc(editor.draftContents)}</textarea>${editorActions(editor, false)}`
      : `<div class="memory-markdown">${editor.contents ? md.render(editor.contents) : `<p class="muted">No contents yet.</p>`}</div>
        <div class="memory-edit-actions"><button class="icon-btn" id="memory-edit-${esc(id)}" type="button" data-memory-edit="${esc(id)}" data-tip="Edit memory" aria-label="Edit memory">${pencilIcon()}</button></div>`}
  </div>`;
  return `<li class="chat-entry memory-entry${active ? " expanded" : ""}">${header}${contents}${active && editor.error ? `<p class="memory-error" role="alert">${esc(editor.error)}</p>` : ""}</li>`;
}

function open(state: SideViewState, send: (message: SideToExt) => void, id: string, mode: MemoryEditor["mode"]): void {
  const editor = editorFor(state, id);
  if (id.startsWith("draft:") && editor) send({ type: "openMemoryDraft", key: editor.key, mode });
  else if (mode === "name") {
    const note = state.memories.find(note => note.id === id);
    if (note) send({ type: "renameMemory", id, revision: note.revision });
  } else send({ type: "openMemory", id, readonly: mode === "view" });
}
function remove(state: SideViewState, send: (message: SideToExt) => void, id: string): void {
  const note = state.memories.find(note => note.id === id), editor = editorFor(state, id);
  if (note) send({ type: "deleteMemory", id, revision: note.revision });
  else if (editor) send({ type: "discardMemoryDraft", key: editor.key });
}
export function memoryContextActions(state: SideViewState, send: (message: SideToExt) => void, id: string): ChatContextAction[] {
  const note = state.memories.find(note => note.id === id), busy = editorFor(state, id)?.busy;
  return [
    { label: "View memory", icon: memoryIcon, disabled: busy, run: id => open(state, send, id, "view") },
    { label: "Edit memory", icon: pencilIcon, disabled: busy, run: id => open(state, send, id, "edit") },
    { label: note?.enabled ? "Disable memory" : "Enable memory", icon: checkIcon, disabled: !note || busy,
      run: () => { if (note) send({ type: "setMemoryEnabled", id, enabled: !note.enabled, revision: note.revision }); } },
    { label: "Rename memory", icon: pencilIcon, disabled: busy, run: id => open(state, send, id, "name") },
    { label: "Delete memory", icon: trashIcon, destructive: true, separatorBefore: true, disabled: busy, run: id => remove(state, send, id) }
  ];
}
export function bindMemories(root: HTMLElement, state: SideViewState, send: (message: SideToExt) => void, render: () => void): void {
  root.querySelector("#clearMemories")?.addEventListener("click", () => send({ type: "clearMemories" }));
  root.querySelector("#newMemory")?.addEventListener("click", () => { state.memorySearch = ""; send({ type: "newMemory" }); });
  root.querySelector<HTMLInputElement>("#memorySearch")?.addEventListener("input", event => {
    state.memorySearch = (event.target as HTMLInputElement).value; render();
  });
  root.querySelectorAll<HTMLElement>("[data-memory-open]").forEach(row => {
    const activate = (): void => {
      const id = row.dataset.memoryOpen!, editor = editorFor(state, id);
      if (editor && editor.key === state.memoryPanel.activeKey) send({ type: "closeMemoryEditor", key: editor.key });
      else open(state, send, id, "view");
    };
    row.addEventListener("click", event => { if (!(event.target as HTMLElement).closest("button")) activate(); });
    row.addEventListener("keydown", event => { if (event.target === row && ["Enter", " "].includes(event.key)) { event.preventDefault(); activate(); } });
  });
  for (const action of ["edit", "delete"] as const) root.querySelectorAll<HTMLElement>(`[data-memory-${action}]`).forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      const id = button.getAttribute(`data-memory-${action}`)!;
      if (action === "edit") open(state, send, id, "edit"); else remove(state, send, id);
    });
  });
  for (const field of ["name", "contents"] as const) root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(`[data-memory-${field}]`).forEach(input => {
    const key = input.getAttribute(`data-memory-${field}`)!;
    const update = (): void => {
      const editor = state.memoryPanel.editors.find(editor => editor.key === key);
      if (!editor) return;
      if (field === "name") editor.draftName = input.value; else editor.draftContents = input.value;
      send({ type: "memoryDraft", key, [field]: input.value });
    };
    input.addEventListener("input", update);
    input.addEventListener("keydown", event => {
      const keyboard = event as KeyboardEvent;
      if (keyboard.key === "Escape") { event.preventDefault(); send({ type: "cancelMemoryEditor", key }); }
      else if (keyboard.key === "Enter" && (field === "name" || keyboard.ctrlKey || keyboard.metaKey)) {
        event.preventDefault(); update(); send({ type: "saveMemoryEditor", key });
      }
    });
  });
  root.querySelectorAll<HTMLElement>("[data-memory-save]").forEach(button => button.addEventListener("click", () => {
    const key = button.dataset.memorySave!;
    const name = root.querySelector<HTMLInputElement>(`#memory-name-${key}`)?.value;
    const contents = root.querySelector<HTMLTextAreaElement>(`#memory-contents-${key}`)?.value;
    send({ type: "memoryDraft", key, name, contents });
    send({ type: "saveMemoryEditor", key });
  }));
  root.querySelectorAll<HTMLElement>("[data-memory-cancel]").forEach(button => button.addEventListener("click", () => send({ type: "cancelMemoryEditor", key: button.dataset.memoryCancel! })));
}
