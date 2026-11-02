import { completionDetailRows, renderActivityDetails } from "./activityDetails.js";
import { validMemoryId, type WorkspaceNote } from "../../../chat/workspaceNotes.js";
import type MarkdownIt from "markdown-it";
import { renderMemoryDate } from "../../memoryDate.js";
import { memoryIcon } from "../../icons.js";
import type { MemoryCreation } from "../../../chat/memory.js";
import { renderToolOutputSurface } from "./toolOutputSurface.js";

export function renderMemoryCreation(creation: MemoryCreation, md: MarkdownIt, disclosureIcon: string): string {
  const active = false;
  const updating = creation.operation === "update";
  const label = creation.status === "created" ? (updating ? "Updated memory" : "Created memory")
    : creation.status === "failed" ? (updating ? "Memory update failed" : "Memory creation failed")
    : creation.status === "cancelled" ? "Memory generation cancelled"
    : "Legacy memory generation stopped";
  const contents = creation.status === "created"
    ? renderMemoryContents(creation.text ?? "", creation.generatedAt ?? 0, md)
    : `<div class="${creation.status === "failed" ? "tool-error-result" : "assistant-markdown"}">${md.utils.escapeHtml(
      creation.error ?? "This historical memory job is no longer active."
    )}</div>`;
  const diagnostic = creation.diagnostic;
  const details = diagnostic ? renderActivityDetails([
    ["Stage", diagnostic.stage], ["Cause", diagnostic.cause], ["Attempt", diagnostic.attempt],
    ...completionDetailRows(diagnostic.completion).filter(([label]) => label !== "Cause")
  ], true) : "";
  return `<summary class="tool-head disclosure-trigger${active ? " active-tool-head" : ""}"><span class="tool-icon" aria-hidden="true">${memoryIcon()}</span><span class="tool-name">${label}</span>${disclosureIcon}</summary>
    <div class="tool-expanded">${renderToolOutputSurface(contents + details, creation.status === "failed")}</div>`;
}

export function renderMemoryContents(text: string, timestamp: number, md: MarkdownIt): string {
  return `<div class="memory-details"><div class="memory-date">${renderMemoryDate(timestamp)}</div>
    <div class="assistant-markdown">${md.render(text)}</div></div>`;
}

/** Return an empty string for incomplete/old results so the card can show its raw output. */
export function renderMemoryResult(toolName: string, result: string, md: MarkdownIt): string {
  let parsed: unknown;
  try { parsed = JSON.parse(result); } catch { return ""; }
  if (!isObject(parsed)) return "";
  if (toolName === "recall_memory" || toolName === "create_memory") {
    const contents = parsed.contents;
    return isMetadata(parsed) && typeof contents === "string"
      ? renderMemoryContents(contents, Date.parse(parsed.date), md)
      : "";
  }
  if (toolName !== "search_memories" || !Array.isArray(parsed.memories) || !parsed.memories.every(isMetadata)) return "";
  const escape = md.utils.escapeHtml;
  const rows = parsed.memories.map(memory =>
    `<li class="tool-filelist-item tool-memory-item"><span class="tool-filelist-icon" aria-hidden="true">${memoryIcon()}</span>
      <div class="tool-memory-entry">${validMemoryId(memory.id) ? `<button type="button" class="tool-path-link tool-memory-name memory-source-link" data-open-memory="${escape(memory.id)}">${escape(memory.name)}</button>` : `<span>${escape(memory.name)}</span>`}
        <div class="memory-date">${renderMemoryDate(Date.parse(memory.date))}</div></div></li>`
  ).join("");
  const list = rows ? `<ul class="tool-filelist">${rows}</ul>`
    : `<div class="tool-filelist tool-filelist-empty">no matches</div>`;
  const truncated = parsed.truncated === true && typeof parsed.total === "number" && Number.isFinite(parsed.total)
    ? `<div class="memory-date">Showing ${parsed.memories.length} of ${parsed.total} matches</div>` : "";
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter((warning): warning is string => typeof warning === "string")
    .map(warning => `<div class="tool-error-result" role="alert">${escape(warning)}</div>`).join("") : "";
  return list + truncated + warnings;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMetadata(value: unknown): value is { name: string; id: string; date: string } {
  return isObject(value) && typeof value.name === "string" && typeof value.id === "string"
    && typeof value.date === "string" && Number.isFinite(Date.parse(value.date));
}

export function renderLoadedMemories(notes: WorkspaceNote[], md: MarkdownIt, disclosureIcon: string): string {
  if (!notes.length) return "";
  const esc = md.utils.escapeHtml;
  const contents = notes.map(note => `<section class="loaded-memory"><button type="button" class="link-button" data-open-memory="${esc(note.id)}">${esc(note.name)}</button>${renderMemoryContents(note.contents, note.updatedAt, md)}</section>`).join("");
  return `<summary class="tool-head disclosure-trigger"><span class="tool-icon" aria-hidden="true">${memoryIcon()}</span><span class="tool-name">Loaded ${notes.length} ${notes.length === 1 ? "memory" : "memories"}</span>${disclosureIcon}</summary><div class="tool-expanded">${renderToolOutputSurface(contents, false)}</div>`;
}
