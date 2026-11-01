import type { ServerMetadata } from "../../../llm/serverTypes.js";
import type { ChatTab, SideTab } from "../../messaging.js";
import type { ManagedMemory } from "../../messaging.js";
import type { ReasoningEffort } from "../../../chat/reasoningEffort.js";

export interface SideViewState {
  tab: SideTab;
  search: string;
  chats: { id: string; title: string; updatedAt: number }[];
  settings: Record<string, unknown>;
  reasoningEffort: ReasoningEffort;
  reasoningEffortError?: string;
  reasoningBudgetError?: string;
  endpointMsg?: { ok?: boolean; text: string };
  endpointDraft?: string;
  endpointTesting?: boolean;
  endpointSubmitted?: string;
  endpointRequestId?: number;
  endpointMetadata?: ServerMetadata;
  serverApiKeyDraft?: string;
  hasServerApiKey?: boolean;
  serverModels: { id: string }[];
  openTabs: ChatTab[];
  version: string;
  memories: ManagedMemory[];
  memorySearch?: string;
  memoryWarnings?: string[];
  memoryError?: string;
  memorySettingError?: string;
}
