import type { CompletionDiagnostics } from "../../../llm/completion.js";
import { completionDetailRows, renderActivityDetails } from "./activityDetails.js";

export function renderInterruptionDetails(diagnostics?: CompletionDiagnostics): string {
  return renderActivityDetails(completionDetailRows(diagnostics));
}
