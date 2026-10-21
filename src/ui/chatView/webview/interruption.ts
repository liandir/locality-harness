import type { CompletionDiagnostics } from "../../../llm/completion.js";

/** Keep stopped responses readable in one message; raw diagnostic objects stay in storage. */
export function interruptionMessage(reason: string, diagnostics?: CompletionDiagnostics): string {
  if (!diagnostics || diagnostics.cause === "user_cancel") return reason;
  const details: string[] = [];
  if (diagnostics.httpStatus !== undefined && !reason.includes(String(diagnostics.httpStatus))) details.push(`HTTP ${diagnostics.httpStatus}`);
  if (diagnostics.finishReason && !reason.includes(diagnostics.finishReason)) details.push(`finish reason: ${diagnostics.finishReason}`);
  if (diagnostics.completionEvidence === "none" && !/confirm|incomplete|before complet/i.test(reason)) details.push("the server did not confirm completion");
  if (diagnostics.promptTokens !== undefined) details.push(`server input: ${diagnostics.promptTokens} tokens`);
  if (diagnostics.completionTokens !== undefined) details.push(`server output: ${diagnostics.completionTokens} tokens`);
  return details.length ? `${reason} (${details.join("; ")})` : reason;
}
