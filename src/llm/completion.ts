/** Transport facts only: never infer a server crash from an incomplete response. */
export interface CompletionDiagnostics {
  cause?: "unexpected_eof" | "transport" | "server_error" | "protocol_error" | "generation_limit" | "no_answer" | "plan_incomplete" | "user_cancel";
  httpStatus?: number;
  finishReason?: string;
  completionEvidence?: "finish_reason" | "done" | "response_completed" | "response_incomplete" | "none";
  promptTokens?: number;
  completionTokens?: number;
}

export class StreamFailure extends Error {
  constructor(message: string, readonly diagnostics: CompletionDiagnostics) {
    super(message);
    this.name = "StreamFailure";
  }
}

export class GenerationLengthError extends StreamFailure {
  constructor(diagnostics: CompletionDiagnostics = {}) {
    const message = diagnostics.finishReason === "max_output_tokens"
      ? "The response reached its output token limit before the model finished. Reasoning and the visible reply share this limit."
      : `The server stopped generation at its output or context limit (${diagnostics.completionEvidence === "response_incomplete" ? "response incomplete" : 'finish_reason="length"'}). Compact context or adjust the server generation limits before continuing.`;
    super(message, {
      cause: "generation_limit", finishReason: "length", completionEvidence: "finish_reason", ...diagnostics
    });
    this.name = "GenerationLengthError";
  }
}

/** Server error bodies can contain request contents; retain only a bounded explanation. */
export function serverErrorMessage(value: unknown): string {
  if (typeof value !== "string") return "The server reported an error during generation.";
  return value.replace(/https?:\/\/\S+/gi, "[endpoint]")
    .replace(/(?:bearer\s+|(?:api[_-]?key|token|password)\s*[:=]\s*)[^\s,;]+/gi, "[redacted]")
    .replace(/[\r\n\t]+/g, " ").slice(0, 300);
}
