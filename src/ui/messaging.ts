/**
 * Webview commands and presentation messages. Session events and chat data
 * live in shared chat contracts, independently of their host implementations.
 */
import type { MemoryListItem } from "../chat/memory.js";
import type { UiEvent } from "../chat/events.js";
import type { ChatAttachment } from "../chat/types.js";
import type { ReasoningEffort } from "../chat/reasoningEffort.js";
import type { ChatMode } from "../chat/mode.js";

export type {
  ChatContextState, ChatUserMessage, ChatPlanFinal, ChatPlanningState,
  ChatTurnPreparation, ChatTurnWorkStarted, ChatMemoryCreations,
  ChatContextActivity, ChatTurnEnd, ChatTurnAbort, ChatResponseDiscarded
} from "../chat/events.js";
export type { ChatToolResultDisplay, ChatToolProcess } from "../chat/types.js";

export interface UiQueuedMessage {
  id: string;
  text: string;
  mode: ChatMode;
  attachments?: UiAttachment[];
}

// --- Side view (welcome / chats / settings) ---

export type SideTab = "welcome" | "chats" | "settings";
export const SETTINGS_SECTIONS = ["model", "tools", "chat", "automation", "user", "reset"] as const;
export type SettingsSection = typeof SETTINGS_SECTIONS[number];
export type WorkspacePathType = "file" | "directory" | "other" | "missing";

export interface ChatTab { id: string; title: string; running?: boolean; open?: boolean }

export type SideToExt =
  | { type: "ready" }
  | { type: "newChat" }
  | { type: "openChat"; id: string }
  | { type: "renameChat"; id: string }
  | { type: "deleteChat"; id: string }
  | { type: "clearChats" }
  | { type: "openTab"; tab: SideTab }
  | { type: "setSettingsSectionExpanded"; section: SettingsSection; expanded: boolean }
  | { type: "openGithub" }
  | { type: "saveSetting"; key: string; value: unknown }
  | { type: "setReasoningEffort"; effort: ReasoningEffort }
  | { type: "validateEndpoint"; url: string; requestId?: number }
  | { type: "validateWebSearch"; endpoint: string; apiKey: string }
  | { type: "editUserSettingsJson" }
  | { type: "editWorkspacePrompts" }
  | { type: "restoreDefaultGeneratedPrompts" }
  | { type: "resetAllDefaults" }
  | { type: "listMemories" }
  | { type: "editMemory"; id: string; text: string }
  | { type: "setMemoryEnabled"; id: string; enabled: boolean }
  | { type: "regenerateMemory"; id: string }
  | { type: "summarizeExistingChats" }
  | { type: "cancelMemoryGeneration" };

export type ExtToSide =
  | { type: "settingsSections"; expanded: SettingsSection[] }
  | { type: "revealMemory"; id: string }
  | { type: "memories"; memories: MemoryListItem[] }
  | { type: "memoryError"; error: string }
  | { type: "settings"; settings: Record<string, unknown>; reasoningEffort: ReasoningEffort; resetDrafts?: boolean }
  | { type: "reasoningEffort"; effort: ReasoningEffort }
  | { type: "webSearchSettings"; endpoint: string; apiKey: string; verified: boolean; error?: string; reset?: boolean }
  | { type: "webSearchValidation"; ok: boolean; error?: string; endpoint?: string }
  | { type: "appInfo"; version: string }
  | { type: "chats"; chats: { id: string; title: string; updatedAt: number }[] }
  | { type: "focusTab"; tab: SideTab }
  | { type: "endpointValidation"; requestId?: number; ok: boolean; error?: string; resolved?: string[]; metadata?: { modelAlias: string; contextSize: number; supportsVision: boolean }; models?: { id: string }[]; selectedModel?: string }
  | { type: "settingSaved"; key: string; ok: boolean; error?: string }
  | { type: "openTabs"; tabs: ChatTab[] };

// --- Chat view ---

export type ChatToExt = (
  | { type: "openMemory"; id: string }
  | { type: "ready" }
  | { type: "send"; text: string; mode: ChatMode; attachmentIds?: string[] }
  | { type: "steerMessage"; text: string; mode: ChatMode; attachmentIds?: string[] }
  | { type: "queueMessage"; id: string; text: string; mode: ChatMode; attachmentIds?: string[] }
  | { type: "updateQueuedMessage"; id: string; text: string }
  | { type: "reorderQueuedMessages"; ids: string[] }
  | { type: "removeQueuedMessage"; id: string }
  | { type: "editMessage"; messageTs: number; text: string; mode: ChatMode; removeAttachmentIds?: string[] }
  | { type: "deleteMessage"; messageTs: number }
  | { type: "selectAttachment" }
  | { type: "pasteAttachments"; files: { fileName: string; dataUrl: string }[] }
  | { type: "pasteText"; text: string }
  | { type: "pasteFileUris"; uris: string[] }
  | { type: "openAttachment"; attachmentId: string }
  | { type: "requestAttachmentText"; attachmentId: string; requestId: number }
  | { type: "discardAttachment"; attachmentId: string }
  | { type: "forkChat"; throughUserMessageTs: number }
  | { type: "continueChat"; messageTs: number }
  | { type: "openChat"; id: string }
  | { type: "cancel" }
  | { type: "approveTool"; toolId: string; approved: boolean; autoApprove?: boolean }
  | { type: "answerQuestion"; toolId: string; answer: string }
  | { type: "skipQuestion"; toolId: string }
  | { type: "featureAction"; id: string }
  | { type: "setChatMode"; mode: ChatMode }
  | { type: "compactNow" }
  | { type: "compactInterruptAndRun" }
  | { type: "newChat" }
  | { type: "openChats" }
  | { type: "openSettings" }
  | { type: "acceptPlan"; messageTs: number }
  | { type: "revisePlan"; messageTs?: number; text: string }
  | { type: "cancelPlanning"; messageTs?: number }
  | { type: "classifyWorkspacePaths"; requestId: number; paths: string[] }
  | { type: "openFile"; path: string; line?: number }
  | { type: "reviewFile"; path: string }
  | { type: "reviewProposedFile"; path: string; content: string }
  | { type: "undoResponseFiles"; userMessageTs: number; path?: string }
  | { type: "requestToolDiff"; toolId: string }
  | { type: "saveDraft"; text: string }
  | { type: "closeChatTab"; id: string }
  | { type: "renameChat"; id?: string; title?: string }
  | { type: "deleteCurrent" }) & { chatId?: string };

export type ExtToChat = UiEvent
  /** Server metadata is independent of saved chat history; absent size means unknown. */
  | { type: "serverContext"; contextSize?: number }
  | { type: "fileUndoFinished"; userMessageTs: number }
  | { type: "chatTabs"; tabs: ChatTab[]; activeId?: string }
  | { type: "chatSnapshot"; id: string; events: ExtToChat[]; busy: boolean; draft: string }
  | { type: "settings"; mode: ChatMode; showThinking: boolean; steerWithEnter: boolean; autoCompact: boolean; autoCompactThresholdPercent: number; workspaceRoot?: string }
  | { type: "attachmentSelected"; attachment: UiAttachment }
  | { type: "attachmentText"; attachmentId: string; requestId: number; text?: string; error?: string }
  | { type: "attachmentImportState"; pending: boolean }
  | { type: "attachmentPasteFailed"; error: string }
  | { type: "attachmentCleared" }
  | { type: "workspacePathTypes"; requestId: number; entries: { path: string; pathType: WorkspacePathType }[] }
  | { type: "messageQueue"; messages: UiQueuedMessage[] }
  | { type: "recentChats"; chats: { id: string; title: string; updatedAt: number }[]; totalCount: number };

export type UiAttachment = ChatAttachment & { previewUri: string };
