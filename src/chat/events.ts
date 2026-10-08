/** Session events shared by the host, feature facades, and webviews. */
import type { ChatAttachment, ChatRecord, ChatToolProcess } from "./types.js";
import type { ChatMode } from "./mode.js";
import type { ReasoningEffort } from "./reasoningEffort.js";
import type { MemoryCreation, MemorySnapshot } from "./memory.js";
import type { FileChangeSummary } from "./fileChanges.js";

/** Model-context size sent with chatLoaded, independently of the visible transcript. */
export interface ChatContextState {
  contextMessageCount?: number;
}

export interface ChatUserMessage {
  kind: "userMessage";
  messageId: string;
  messageTs: number;
  text: string;
  mode: ChatMode;
  steering?: boolean;
  attachments?: ChatAttachment[];
}

export interface ChatPlanFinal {
  kind: "planFinal";
  messageId: string;
  messageTs: number;
  markdown: string;
}

export interface ChatPlanningState {
  kind: "planningState";
  active: boolean;
  pendingPlanMessageTs?: number;
}

export interface ChatTurnPreparation {
  kind: "turnPreparing";
  /** Memory preparation is silent; its creation card remains visible above the new message. */
  reason: "server" | "title" | "context" | "memory";
}

export interface ChatTurnWorkStarted {
  kind: "turnWorkStarted";
  messageId: string;
  startedAt: number;
  /** Reopen the saved response after the host removes its terminal error. */
  continued?: boolean;
}

export interface ChatMemoryCreations {
  kind: "memoryCreations";
  /** Includes the create/update operation for both live cards and saved history. */
  creations: MemoryCreation[];
}

/** Authoritative list of activities whose results the model is still consuming. */
export interface ChatContextActivity {
  kind: "contextActivity";
  activityIds: string[];
}

/** Completed turn metadata; the answer time is absent for turns without a final answer. */
export interface ChatTurnEnd {
  kind: "turnEnd";
  messageId: string;
  /** Mode captured for this turn, independent of the current composer mode. */
  mode: ChatMode;
  messageTs?: number;
}

/** Terminal response timestamp comes from the saved host transcript. */
export interface ChatTurnAbort {
  kind: "abort";
  reason: string;
  messageTs?: number;
}

/** Remove only the unfinished output of a generation that will be retried. */
export interface ChatResponseDiscarded {
  kind: "responseDiscarded";
  messageId: string;
  textChars: number;
  thoughtChars: number;
  toolIds: string[];
}

/** Events the session emits to the chat webview. */
export type UiEvent =
  | ChatUserMessage
  | { kind: "visionCapability"; supported: boolean; endpoint?: string; model?: string }
  | ChatTurnPreparation
  | ChatContextActivity
  | ChatMemoryCreations
  | ChatTurnWorkStarted
  | { kind: "titleGenerationFinished" }
  | { kind: "turnStart"; messageId: string }
  | { kind: "text"; messageId: string; delta: string }
  | { kind: "thought"; messageId: string; delta: string }
  | { kind: "toolCallProgress"; toolId: string; messageId: string; toolName: string; path?: string; contentLines: number; added?: number; removed?: number; createsNewFile?: boolean; replacedLines?: number; startLine?: number; endLine?: number; line?: number }
  | ({ kind: "toolCallProposed"; toolId: string; messageId: string; toolName: string; argsJson: string; category: ToolCategory; approvalRequired: boolean; reason?: string; diffPreview?: string; createsNewFile?: boolean } & ChatToolProcess)
  | ({ kind: "toolCallOutput"; toolId: string; resultPreview: string } & ChatToolProcess)
  | ({ kind: "toolCallResolved"; toolId: string; status: "approved" | "rejected" | "executed" | "failed"; fileUndoState?: "available" | "undone"; fileUndoPath?: string; resultPreview?: string; diffPreview?: string; added?: number; removed?: number; createsNewFile?: boolean } & ChatToolProcess)
  | ({ kind: "processJobState"; toolId: string; jobId: string; running: boolean; resultPreview?: string; status?: "failed" } & ChatToolProcess)
  | { kind: "fileEditsUndone"; userMessageTs: number; paths: string[] }
  | { kind: "fileChanges"; messageId: string; changes: FileChangeSummary[] }
  | { kind: "summary"; messageId: string; text: string }
  | ChatPlanFinal
  | ChatPlanningState
  | ChatTurnAbort
  | { kind: "notice"; text: string }
  | ChatTurnEnd
  | ChatResponseDiscarded
  | { kind: "tokens"; total: number; limit: number }
  | { kind: "titleChanged"; title: string; animate: boolean }
  | ({ kind: "chatLoaded"; record: ChatRecord } & ChatContextState)
  | { kind: "memoriesUsed"; memories: MemorySnapshot[] }
  | { kind: "chatClosed" }
  | { kind: "compactStatus"; currentMessages: number; minMessages: number; available: boolean }
  | { kind: "compactStart"; compactId: string; source: "manual" | "auto"; beforeTokens: number; beforeMessages: number; keepTail: number }
  | { kind: "compactEnd"; compactId: string; source: "manual" | "auto"; status: "executed" | "failed"; beforeTokens: number; afterTokens?: number; beforeMessages: number; afterMessages?: number; keepTail: number; error?: string }
  | { kind: "chatModeChanged"; mode: ChatMode }
  | { kind: "reasoningEffortChanged"; effort: ReasoningEffort };

export type ToolCategory =
  | "read"      // gray, auto-approve via setting
  | "write"     // gray + approval, auto via setting
  | "todos"     // gray, no approval — UI/state only, available in Act
  | "command"   // purple, auto-approve via setting in Act
  | "question"  // gray, interactive — asks the user and waits for an answer
  | "search"    // external reference lookup
  | "process"   // gray, controls a previously approved chat-owned process
  | "forbidden" // red, abort
  | "unknown"   // red, abort
  | "modeViolation"; // red, abort
