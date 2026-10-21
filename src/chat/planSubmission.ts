import type { ParsedEvent } from "../llm/parser/types.js";
import { validateToolArguments } from "../tools/toolDefinitions.js";

export type ParsedToolCall = Extract<ParsedEvent, { kind: "toolCall" }>;

/** A submission is a transaction over the complete generation, not a prose heuristic. */
export function validatePlanSubmission(calls: ParsedToolCall[]): { markdown: string } | { error: string } {
  if (calls.length !== 1 || calls[0].name !== "submit_plan") {
    return { error: "Emit submit_plan on its own, without any other tool calls." };
  }
  try {
    const args: unknown = JSON.parse(calls[0].argsJson);
    const error = validateToolArguments("submit_plan", args);
    if (error) return { error };
    const markdown = (args as { markdown: string }).markdown.trim();
    return markdown ? { markdown } : { error: "markdown must contain a completed implementation plan." };
  } catch {
    return { error: "submit_plan arguments must be valid JSON." };
  }
}
