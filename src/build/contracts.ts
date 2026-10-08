import type { SecretStorage } from "vscode";
import type { AutoApprovalSetting, HarnessSettings } from "../config/settings.js";
import type { UiEvent } from "../chat/events.js";
import type { ChatToolProcess, ChatToolResultDisplay } from "../chat/types.js";

export type FeatureResultUpdate = ChatToolProcess & { status?: "failed" };

export interface FeatureContext {
  workspaceRoot: string;
  secrets?: SecretStorage;
  emit(event: UiEvent): void;
  appendResult(name: string, args: string, result: string, metadata: ChatToolProcess): Promise<unknown>;
  updateResult?(toolId: string, metadata: FeatureResultUpdate): void;
}

export interface FeatureRuntime {
  tools: readonly string[];
  autoApprovalSetting?: AutoApprovalSetting;
  autoApprovalScope?: "global";
  category(name: string): "command" | "process" | "search";
  needsApproval(settings: HarnessSettings): boolean;
  prepare(name: string, args: Record<string, unknown>, settings: HarnessSettings): Promise<ChatToolProcess>;
  execute(name: string, args: Record<string, unknown>, toolId: string, signal?: AbortSignal): Promise<{ result: string } & ChatToolProcess & ChatToolResultDisplay>;
  action?(id: string): Promise<void>;
  cancel?(): void;
  endTurn?(): Promise<void>;
}
