import { completionDetailRows, renderActivityDetails } from "./activityDetails.js";
import type MarkdownIt from "markdown-it";
import { renderMemoryDate } from "../../memoryDate.js";
import { memoryIcon } from "../../icons.js";
import type { MemoryCreation } from "../../../chat/memory.js";
import { renderToolOutputSurface } from "./toolOutputSurface.js";

export function renderMemoryCreation(creation: MemoryCreation, md: MarkdownIt, disclosureIcon: string): string {
  const active = creation.status === "generating";
  const updating = creation.operation === "update";
  const label = creation.status === "created" ? (updating ? "Updated memory" : "Created memory")
    : creation.status === "failed" ? (updating ? "Memory update failed" : "Memory creation failed")
    : creation.status === "cancelled" ? "Memory generation cancelled"
    : creation.status === "retry_wait" ? "Memory retry scheduled"
    : updating ? "Updating memory" : "Creating memory";
  const contents = creation.status === "created"
    ? renderMemoryContents(creation.text ?? "", creation.generatedAt ?? 0, md)
    : `<div class="${creation.status === "failed" ? "tool-error-result" : "assistant-markdown"}">${md.utils.escapeHtml(
      creation.error ?? (creation.status === "queued" ? "Waiting for the model to be idle." : creation.status === "cancelled" ? "This memory job was cancelled." : "Saving a summary for future chats.")
    )}</div>`;
  const escape = md.utils.escapeHtml;
  const diagnostic = creation.diagnostic;
  const details = diagnostic ? renderActivityDetails([
    ["Stage", diagnostic.stage], ["Cause", diagnostic.cause], ["Attempt", diagnostic.attempt],
    ...completionDetailRows(diagnostic.completion).filter(([label]) => label !== "Cause")
  ], true) : "";
  const retry = creation.status === "failed" && creation.attemptId
    ? `<button class="action-btn" type="button" data-retry-memory="${escape(creation.attemptId)}">Retry</button>` : "";
  return `<summary class="tool-head disclosure-trigger${active ? " active-tool-head" : ""}"><span class="tool-icon" aria-hidden="true">${memoryIcon()}</span><span class="tool-name">${label}</span>${disclosureIcon}</summary>
    <div class="tool-expanded">${renderToolOutputSurface(contents + details + retry, creation.status === "failed")}</div>`;
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
  if (toolName === "recall_memory") {
    const contents = parsed.contents;
    return isMetadata(parsed) && typeof contents === "string"
      ? renderMemoryContents(contents, Date.parse(parsed.date), md)
      : "";
  }
  if (toolName !== "search_memories" || !Array.isArray(parsed.memories) || !parsed.memories.every(isMetadata)) return "";
  const escape = md.utils.escapeHtml;
  const rows = parsed.memories.map(memory =>
    `<li class="tool-filelist-item tool-memory-item"><span class="tool-filelist-icon" aria-hidden="true">${memoryIcon()}</span>
      <div class="tool-memory-entry"><button type="button" class="tool-path-link tool-memory-name memory-source-link" data-open-memory-chat="${escape(memory.id)}">${escape(memory.name)}</button>
        <div class="memory-date">${renderMemoryDate(Date.parse(memory.date))}</div></div></li>`
  ).join("");
  const list = rows ? `<ul class="tool-filelist">${rows}</ul>`
    : `<div class="tool-filelist tool-filelist-empty">no matches</div>`;
  const truncated = parsed.truncated === true && typeof parsed.total === "number" && Number.isFinite(parsed.total)
    ? `<div class="memory-date">Showing ${parsed.memories.length} of ${parsed.total} matches</div>` : "";
  return list + truncated;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMetadata(value: unknown): value is { name: string; id: string; date: string } {
  return isObject(value) && typeof value.name === "string" && typeof value.id === "string"
    && typeof value.date === "string" && Number.isFinite(Date.parse(value.date));
}
