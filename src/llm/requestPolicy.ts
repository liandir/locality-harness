/** Task policy belongs to the harness; adapters only translate these options. */
export interface GenerationPolicy {
  task: "chat" | "compaction" | "title" | "commit";
  maxOutputTokens?: number;
  reasoning?: {
    mode: "default" | "off" | "prefer-off";
    effort?: string;
    budgetTokens?: number;
  };
  reportProgress?: boolean;
}

export interface PromptMeasurement {
  tokens: number;
  accuracy: "exact";
}

/** Headroom for prompt fitting. Interactive requests leave the generation limit to the server. */
export function outputTokenReserve(contextSize: number, maxTokens?: number): number {
  return maxTokens ?? Math.max(1, Math.min(4096, Math.floor(contextSize / 4)));
}

/** Keep a small explicit reserve in addition to the exact input and output budgets. */
export function promptSafetyMargin(contextSize: number, _accuracy: PromptMeasurement["accuracy"]): number {
  return Math.max(1, Math.ceil(contextSize * 0.01));
}

export function promptBudget(contextSize: number, outputTokens: number, accuracy: PromptMeasurement["accuracy"]): number {
  return Math.max(0, contextSize - outputTokens - promptSafetyMargin(contextSize, accuracy));
}
