import type { CompletionDiagnostics } from "../../../llm/completion.js";
import { chevronIcon } from "../../icons.js";
import { renderToolOutputSurface } from "./toolOutputSurface.js";

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export function renderInterruptionDetails(diagnostics?: CompletionDiagnostics): string {
  if (!diagnostics) return "";
  const rows = [
    ["Cause", diagnostics.cause], ["Finish reason", diagnostics.finishReason],
    ["Completion evidence", diagnostics.completionEvidence],
    ["Server prompt tokens", diagnostics.promptTokens], ["Server output tokens", diagnostics.completionTokens]
  ].filter(([, value]) => value !== undefined);
  if (!rows.length) return "";
  const details = rows.map(([label, value]) => `<div>${label}: ${escape(String(value))}</div>`).join("");
  return `<details class="interruption-details"><summary class="disclosure-trigger">Details <span class="disclosure-icon">${chevronIcon()}</span></summary>${renderToolOutputSurface(details, false)}</details>`;
}
