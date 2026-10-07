import { readFeatureSettings, featureSettingKeys } from "../build/settings.js";
import * as vscode from "vscode";
import { DEFAULT_MEMORY_MAX_COUNT, MAX_MEMORY_COUNT } from "../chat/memoryLimits.js";
import { normalizeToolCallingProfile, type ToolCallingProfile } from "../llm/toolCallingProfile.js";
import { normalizeReasoningEfforts, type ReasoningEfforts } from "../chat/reasoningEffort.js";
import { isReasoningBudget } from "../chat/reasoningBudget.js";

const NS = "locality";

export const DEFAULT_TITLE_PROMPT =
  "Summarize the user message in 2-6 words. Output ONLY the summary.";
export const DEFAULT_COMMIT_MESSAGE_PROMPT =
  "Write a concise Git commit message. Use an imperative subject line and add a short body only when it materially improves clarity.";

export interface HarnessSettings {
  endpoint: string;
  model: string;
  toolCallingMode: ToolCallingProfile;
  temperature: number;
  topK: number;
  topP: number;
  reasoningBudget: number | null;
  reasoningEfforts: ReasoningEfforts;
  titlePrompt: string;
  commitMessagePrompt: string;
  showThinking: boolean;
  steerWithEnter: boolean;
  autoCompact: boolean;
  memoryEnabled: boolean;
  memoryMaxCount: number;
  autoCompactThresholdPercent: number;
  tailBudgetPercent: number;
  maxMessageTokensPercent: number;
  templateOverheadTokensPerMessage: number;
  autoapproveReads: boolean;
  autoapproveWrites: boolean;
  readToolsEnabled?: boolean;
  editToolsEnabled?: boolean;
  commandToolsEnabled?: boolean;
  webRequestsEnabled?: boolean;
  autoapproveCommands?: boolean;
  autoapproveSafeCommands?: boolean;
  safeCommandPatterns?: unknown;
  webSearchEndpoint?: string;
  webSearchMaxResults?: number;
  /** Host-derived capability flag, never a configurable permission. */
  webToolsEnabled?: boolean;
  autoapproveWebSearch?: boolean;
}

export type AutoApprovalSetting = Extract<keyof HarnessSettings, `autoapprove${string}`>;

export function readSettings(): HarnessSettings {
  const cfg = vscode.workspace.getConfiguration(NS);
  const reasoningBudget = cfg.get<unknown>("reasoningBudget");
  return {
    endpoint: cfg.get<string>("endpoint") ?? "http://localhost:8080/v1",
    model: cfg.get<string>("model")?.trim() || "local",
    toolCallingMode: normalizeToolCallingProfile(cfg.get<unknown>("toolCallingMode")),
    temperature: clampNumber(cfg.get<number>("temperature") ?? 0.8, 0, 2, 0.8),
    topK: Math.round(clampNumber(cfg.get<number>("topK") ?? 40, 0, Number.MAX_SAFE_INTEGER, 40)),
    topP: clampNumber(cfg.get<number>("topP") ?? 0.95, 0, 1, 0.95),
    reasoningBudget: isReasoningBudget(reasoningBudget) ? reasoningBudget : null,
    reasoningEfforts: normalizeReasoningEfforts(cfg.get<unknown>("reasoningEfforts")),
    titlePrompt: cfg.get<string>("titlePrompt")?.trim() || DEFAULT_TITLE_PROMPT,
    commitMessagePrompt: cfg.get<string>("commitMessagePrompt")?.trim() || DEFAULT_COMMIT_MESSAGE_PROMPT,
    showThinking: cfg.get<boolean>("showThinking") ?? false,
    steerWithEnter: cfg.get<boolean>("steerWithEnter") === true,
    memoryEnabled: cfg.inspect?.<boolean>("memoryEnabled")?.workspaceValue === true,
    memoryMaxCount: Math.floor(clampNumber(cfg.get<number>("memoryMaxCount") ?? DEFAULT_MEMORY_MAX_COUNT, 1, MAX_MEMORY_COUNT, DEFAULT_MEMORY_MAX_COUNT)),
    autoCompact: cfg.get<boolean>("autoCompact") ?? true,
    autoCompactThresholdPercent: clampPercent(cfg.get<number>("autoCompactThresholdPercent") ?? 80),
    tailBudgetPercent: clampNumber(Math.round(cfg.get<number>("tailBudgetPercent") ?? 30), 5, 60, 30),
    maxMessageTokensPercent: clampNumber(Math.round(cfg.get<number>("maxMessageTokensPercent") ?? 25), 5, 50, 25),
    templateOverheadTokensPerMessage: clampNumber(Math.round(cfg.get<number>("templateOverheadTokensPerMessage") ?? 4), 0, 64, 4),
    autoapproveReads: cfg.get<boolean>("autoapproveReads") ?? true,
    autoapproveWrites: cfg.get<boolean>("autoapproveWrites") ?? false,
    readToolsEnabled: cfg.get<boolean>("readToolsEnabled") !== false,
    editToolsEnabled: cfg.get<boolean>("editToolsEnabled") !== false,
    ...readFeatureSettings(cfg)
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 80;
  return Math.min(95, Math.max(50, Math.round(value)));
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export async function writeSetting<K extends keyof HarnessSettings>(
  key: K,
  value: HarnessSettings[K],
  scope: "global" | "effective" = "global"
): Promise<void> {
  if (!SETTING_KEYS.includes(key)) throw new Error("Setting is unavailable in this edition.");
  if (key === "reasoningBudget" && !isReasoningBudget(value)) {
    throw new Error("Enter a positive whole number or leave the reasoning budget empty for unlimited reasoning.");
  }
  const cfg = vscode.workspace.getConfiguration(NS);
  let target = key === "memoryEnabled" || key === "memoryMaxCount" ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  if (scope === "effective") {
    const inspected = cfg.inspect(key);
    if (inspected?.workspaceFolderValue !== undefined) target = vscode.ConfigurationTarget.WorkspaceFolder;
    else if (inspected?.workspaceValue !== undefined) target = vscode.ConfigurationTarget.Workspace;
  }
  await cfg.update(key, value, target);
}

/** Every harness setting key; maps 1:1 to the package.json configuration properties. */
export const SETTING_KEYS: (keyof HarnessSettings)[] = [
  "endpoint",
  "model",
  "toolCallingMode",
  "temperature",
  "topK",
  "topP",
  "reasoningBudget",
  "reasoningEfforts",
  "titlePrompt",
  "commitMessagePrompt",
  "showThinking",
  "steerWithEnter",
  "autoCompact",
  "memoryEnabled",
  "memoryMaxCount",
  "autoCompactThresholdPercent",
  "tailBudgetPercent",
  "maxMessageTokensPercent",
  "templateOverheadTokensPerMessage",
  "autoapproveReads",
  "autoapproveWrites",
  "readToolsEnabled",
  "editToolsEnabled",
  ...featureSettingKeys as (keyof HarnessSettings)[]
];

/** Seed effective generated-text instructions into workspace JSON for editing. */
export async function seedGeneratedPromptsIfUnset(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(NS);
  const effective = readSettings();
  for (const key of ["titlePrompt", "commitMessagePrompt"] as const) {
    if (cfg.inspect<string>(key)?.workspaceValue !== undefined) continue;
    await cfg.update(key, effective[key], vscode.ConfigurationTarget.Workspace);
  }
}

/** Restore both generated-text instruction settings to their defaults. */
export async function restoreDefaultGeneratedPrompts(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(NS);
  await cfg.update("titlePrompt", DEFAULT_TITLE_PROMPT, vscode.ConfigurationTarget.Workspace);
  await cfg.update("commitMessagePrompt", DEFAULT_COMMIT_MESSAGE_PROMPT, vscode.ConfigurationTarget.Workspace);
}

/** Reset every harness setting to its default by clearing the user override. */
export async function resetAllSettings(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(NS);
  for (const key of SETTING_KEYS) {
    await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
    await cfg.update(key, undefined, vscode.ConfigurationTarget.Workspace);
  }
}

export function onSettingsChange(handler: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(NS)) handler();
  });
}
