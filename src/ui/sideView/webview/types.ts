import type { ChatTab, SideTab } from "../../messaging.js";
import type { MemoryListItem } from "../../../chat/memory.js";
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
  endpointMetadata?: { modelAlias: string; contextSize: number; supportsVision: boolean };
  serverModels: { id: string }[];
  openTabs: ChatTab[];
  version: string;
  memories: MemoryListItem[];
  memoryError?: string;
  memorySettingError?: string;
}
