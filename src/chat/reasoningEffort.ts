import type { GenerationPolicy } from "../llm/requestPolicy.js";
export type ReasoningEffort = "none" | "default" | `effort:${string}`;

export function generationReasoning(effort: ReasoningEffort, efforts: ReasoningEfforts, budget: number | null): GenerationPolicy["reasoning"] {
  const selected = availableReasoningEffort(effort, efforts);
  return { mode: selected === "none" ? "off" : "default", effort: reasoningEffortValue(selected), budgetTokens: budget ?? undefined };
}
export type ReasoningEfforts = Record<string, string>;

export const REASONING_NONE = "none" as const;
export const REASONING_DEFAULT = "default" as const;
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = REASONING_DEFAULT;
export const DEFAULT_REASONING_EFFORTS: ReasoningEfforts = {
  Low: "low",
  Medium: "medium",
  High: "high"
};
export const WORKSPACE_REASONING_EFFORT_KEY = "locality.workspaceReasoningEffort";

export interface ReasoningEffortChoice {
  label: string;
  effort: ReasoningEffort;
}

export interface ReasoningRequestOverrides {
  reasoning_effort?: string;
  chat_template_kwargs?: Record<string, unknown>;
}

/** Sanitize the user-editable label -> llama.cpp value dictionary. */
export function normalizeReasoningEfforts(value: unknown): ReasoningEfforts {
  const source = isRecord(value) ? value : DEFAULT_REASONING_EFFORTS;
  const normalized: ReasoningEfforts = {};
  const seenValues = new Set<string>();
  for (const [rawLabel, rawValue] of Object.entries(source)) {
    const label = rawLabel.trim();
    const effortValue = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!label || !effortValue || isBuiltInLabel(label) || seenValues.has(effortValue)) continue;
    normalized[label] = effortValue;
    seenValues.add(effortValue);
  }
  return normalized;
}

export function reasoningEffortChoices(efforts: ReasoningEfforts): ReasoningEffortChoice[] {
  return [
    { label: "Default", effort: REASONING_DEFAULT },
    ...Object.entries(efforts).map(([label, value]) => ({
      label,
      effort: effortSelection(value)
    }))
  ];
}

/** Validate a saved built-in or configurable reasoning selection. */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  if (value === REASONING_NONE || value === REASONING_DEFAULT) return value;
  if (typeof value === "string" && value.startsWith("effort:") && value.length > "effort:".length) {
    return value as ReasoningEffort;
  }
  return DEFAULT_REASONING_EFFORT;
}

/** Fall back to Default when a saved configurable value is no longer offered. */
export function availableReasoningEffort(value: unknown, efforts: ReasoningEfforts): ReasoningEffort {
  const normalized = normalizeReasoningEffort(value);
  if (normalized === REASONING_NONE || normalized === REASONING_DEFAULT) return normalized;
  return Object.values(efforts).includes(reasoningEffortValue(normalized) ?? "")
    ? normalized
    : REASONING_DEFAULT;
}

export function reasoningEffortLabel(effort: ReasoningEffort, efforts: ReasoningEfforts): string {
  if (effort === REASONING_NONE) return "None";
  if (effort === REASONING_DEFAULT) return "Default";
  const value = reasoningEffortValue(effort);
  return Object.entries(efforts).find(([, configured]) => configured === value)?.[0] ?? "Default";
}

/** Convert the selected menu item into the two independent llama.cpp API fields. */
export function reasoningRequestOverrides(
  effort: ReasoningEffort,
  efforts: ReasoningEfforts
): ReasoningRequestOverrides {
  const available = availableReasoningEffort(effort, efforts);
  if (available === REASONING_NONE) {
    return { chat_template_kwargs: { enable_thinking: false } };
  }
  if (available === REASONING_DEFAULT) return {};
  return { reasoning_effort: reasoningEffortValue(available) };
}

function effortSelection(value: string): ReasoningEffort {
  return `effort:${value}`;
}

function reasoningEffortValue(effort: ReasoningEffort): string | undefined {
  return effort.startsWith("effort:") ? effort.slice("effort:".length) : undefined;
}

function isBuiltInLabel(label: string): boolean {
  const normalized = label.toLowerCase();
  return normalized === "none" || normalized === "default";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
