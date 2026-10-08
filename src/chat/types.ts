/** Shared chat data shapes; independent of storage and session implementations. */
import type { ChatMemory, MemoryCreation, MemorySnapshot } from "./memory.js";
import type { ToolCallingProfile } from "../llm/toolCallingProfile.js";
import type { FileUndoSnapshot } from "./fileUndo.js";
import type { FileChangeSummary } from "./fileChanges.js";
import type { ChatMode } from "./mode.js";
import type { ReasoningEffort } from "./reasoningEffort.js";

/** Optional presentation payload, never sent to the model as tool content. */
export interface ChatToolResultDisplay {
  displayResult?: string;
}

/** Host-owned process identity, display command, and current Stop availability. */
export interface ChatToolProcess {
  processJobId?: string;
  processCommand?: string;
  processRunning?: boolean;
  /** Display-only output, kept separate from the model's stream-labeled result. */
  processOutput?: string;
  processExitCode?: number;
}

export type Role = "user" | "assistant" | "tool" | "system";

export type StoredToolStatus = "executed" | "failed" | "rejected";

export interface ChatAttachment {
  id: string;
  fileName: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "text/plain";
  byteLength: number;
  /** Safe asset suffix; generic pasted text is stored as txt but has no fileType. */
  extension: string;
  /** Original text-file suffix, absent for generic pasted text or extensionless files. */
  fileType?: string;
}

export interface ChatMessage {
  role: Role;
  /** Harness note about a user-requested file undo; hidden from the transcript UI. */
  fileUndoNotice?: boolean;
  content: string;
  /** Display-only terminal response; never included in model context. */
  interruption?: { reason: string; mode: ChatMode; reasoningEffort: ReasoningEffort };
  /** Mode selected when a user message was submitted; absent in older history. */
  mode?: ChatMode;
  /** User guidance injected into the current turn without changing its mode. */
  steering?: boolean;
  /** Native model reasoning associated with this assistant response. */
  reasoningContent?: string;
  /** Parser events captured during this assistant turn (text, thought, toolCall, summary). */
  events?: unknown[];
  /** Tool call this message corresponds to (when role === "tool"). */
  toolCall?: {
    id?: string;
    name: string;
    argsJson: string;
    /** Final UI outcome, retained so restored summaries do not imply failed work succeeded. */
    status?: StoredToolStatus;
    /** Retains the Created/Edited distinction for write_file across reloads. */
    createsNewFile?: boolean;
    /** Display command for process checks and stops, retained across reloads. */
    processCommand?: string;
    processOutput?: string;
    processExitCode?: number;
    /** Exact change made by this call, independent of later edits to the same file. */
    fileChange?: FileChangeSummary;
    /** Host-only data, excluded from model prompts and webview payloads. */
    fileUndo?: FileUndoSnapshot;
    fileUndoState?: "available" | "undone";
  } & ChatToolResultDisplay;
  /** File changes made during this assistant turn. */
  fileChanges?: FileChangeSummary[];
  /** Chat-owned image or text assets supplied by the user or a view_image tool result. */
  attachments?: ChatAttachment[];
  tokens?: number;
  ts: number;
}

export interface ChatRecord {
  id: string;
  workspaceRoot: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  toolCallingMode: ToolCallingProfile;
  mode: ChatMode;
  /** Completed plan awaiting an explicit acceptance or revision request. */
  pendingPlanMessageTs?: number;
  /** Planning holds queued requests through all revisions until acceptance or cancellation. */
  planning?: boolean;
  reasoningEffort: ReasoningEffort;
  /** Complete saved transcript; compaction never rewrites these messages. */
  messages: ChatMessage[];
  /** Model-only history after compaction, memory loading, or attachment expansion. */
  contextMessages?: ChatMessage[];
  memory?: ChatMemory;
  memoryCreations?: MemoryCreation[];
  /** Memories explicitly recalled by tools, for the UI disclosure only. */
  recalledMemories?: MemorySnapshot[];
  /** Memories loaded at chat start, for the UI disclosure; contents live in contextMessages. */
  initialMemories?: MemorySnapshot[];
  /** Token count of the model context, not the full transcript. */
  totalTokens: number;
  /** Model whose tokenizer produced the cached per-message token counts. */
  tokenizerModel?: string;
}
