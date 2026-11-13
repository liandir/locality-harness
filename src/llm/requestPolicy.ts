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
  accuracy: "exact" | "estimated";
}

export function outputTokenReserve(contextSize: number, maxTokens?: number): number {
  return maxTokens ?? Math.max(1, Math.min(4096, Math.floor(contextSize / 4)));
}

/** Estimates need headroom, but never manufacture space in a small context. */
export function promptSafetyMargin(contextSize: number, accuracy: PromptMeasurement["accuracy"]): number {
  return Math.max(1, Math.ceil(contextSize * (accuracy === "exact" ? 0.01 : 0.05)));
}

export function promptBudget(contextSize: number, outputTokens: number, accuracy: PromptMeasurement["accuracy"]): number {
  return Math.max(0, contextSize - outputTokens - promptSafetyMargin(contextSize, accuracy));
}
