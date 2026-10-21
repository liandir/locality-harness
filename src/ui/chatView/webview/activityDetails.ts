import type { CompletionDiagnostics } from "../../../llm/completion.js";
import { chevronIcon } from "../../icons.js";
import { renderToolOutputSurface } from "./toolOutputSurface.js";

type DetailRow = [string, string | number | undefined];
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export function completionDetailRows(diagnostics?: CompletionDiagnostics): DetailRow[] {
  return diagnostics ? [
    ["Cause", diagnostics.cause], ["HTTP status", diagnostics.httpStatus], ["Finish reason", diagnostics.finishReason],
    ["Completion evidence", diagnostics.completionEvidence],
    ["Server prompt tokens", diagnostics.promptTokens], ["Server output tokens", diagnostics.completionTokens]
  ] : [];
}
/** Embedded details reuse their parent's surface; standalone details get the shared card. */
export function renderActivityDetails(rows: DetailRow[], embedded = false): string {
  const visible = rows.filter(([, value]) => value !== undefined);
  if (!visible.length) return "";
  const contents = visible.map(([label, value]) => `<div>${escape(label)}: ${escape(String(value))}</div>`).join("");
  const body = embedded ? `<div class="activity-detail-contents">${contents}</div>` : renderToolOutputSurface(contents, false);
  return `<details class="activity-details"><summary class="disclosure-trigger">Details <span class="disclosure-icon">${chevronIcon()}</span></summary>${body}</details>`;
}
