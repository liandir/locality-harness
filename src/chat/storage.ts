import type { ChatAttachment, ChatMessage, ChatRecord } from "./types.js";
export type { Role, StoredToolStatus, ChatAttachment, ChatMessage, ChatRecord } from "./types.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validMemory, validMemoryCreation, validSnapshot, type ChatMemory, type MemoryCreation } from "./memory.js";
import { WorkspaceChatIndex } from "./chatIndex.js";
import { makeChatHeader, parseChatRecord, readChatHeader, writeChatFile, type ChatHeader, type IndexedChat } from "./chatFile.js";
import { isValidChatId, normalizeWorkspaceRoot } from "./storagePaths.js";
export { isValidChatId } from "./storagePaths.js";
import { MAX_MEMORY_COUNT } from "./memoryLimits.js";
import { randomUUID } from "node:crypto";
import { normalizeToolCallingProfile, type ToolCallingProfile } from "../llm/toolCallingProfile.js";
import type { FileChangeSummary } from "./fileChanges.js";
import { attachmentFileType, isImageAttachment, MAX_TEXT_ATTACHMENT_BYTES } from "./attachments.js";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "./attachmentLimits.js";
import { normalizeChatMode } from "./mode.js";
import {
  DEFAULT_REASONING_EFFORT,
  normalizeReasoningEffort,
  type ReasoningEffort
} from "./reasoningEffort.js";

export const CHATS_DIR = ".locality";
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const VISION_TOKEN_RESERVE = 4096;

export type { FileChangeSummary };
export type { TodoItem } from "./todos.js";

export class ChatStorage {
  private index: WorkspaceChatIndex;
  constructor(
    private workspaceRoot: string,
    private storageRoot = path.join(os.homedir(), CHATS_DIR)
  ) {
    this.workspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    this.index = new WorkspaceChatIndex(path.resolve(storageRoot), this.workspaceRoot, id => this.readHeader(id));
  }

  private dir(): string {
    return this.storageRoot;
  }

  attachmentsRoot(): string {
    return path.join(this.dir(), "attachments");
  }

  attachmentPath(chatId: string, attachment: ChatAttachment): string {
    if (!isValidChatId(chatId) || !isValidAttachment(attachment)) throw new Error("Invalid attachment reference.");
    return path.join(this.attachmentsRoot(), chatId, `${attachment.id}.${attachment.extension}`);
  }

  async importAttachment(chatId: string, sourcePath: string, options: { allowImages?: boolean; imageOnly?: boolean } = {}): Promise<ChatAttachment> {
    if (!isValidChatId(chatId)) throw new Error("Invalid chat id.");
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) throw new Error("Choose an image or text file.");
    if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error("Attachments must be 10 MiB or smaller.");
    const bytes = await fs.readFile(sourcePath);
    return this.importAttachmentBytes(chatId, path.basename(sourcePath), bytes, options);
  }

  async importAttachmentBytes(chatId: string, fileName: string, bytes: Uint8Array, options: { allowImages?: boolean; imageOnly?: boolean } = {}): Promise<ChatAttachment> {
    if (!isValidChatId(chatId)) throw new Error("Invalid chat id.");
    if (!validAttachmentName(fileName)) throw new Error("Invalid attachment file name.");
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("Attachments must be 10 MiB or smaller.");
    const suppliedExtension = attachmentFileType(fileName);
    const canonicalExtension = suppliedExtension === "jpeg" ? "jpg" : suppliedExtension;
    const image = detectImage(bytes);
    if (image && options.allowImages === false) throw new Error("Image input is unavailable: the server has not reported vision support. Load a vision model with its matching --mmproj.");
    if (!image && options.imageOnly) throw new Error("Choose a valid JPEG, PNG, or WebP image.");
    let kind: Pick<ChatAttachment, "mimeType" | "extension" | "fileType">;
    if (image) {
      if (canonicalExtension !== undefined && canonicalExtension !== image.extension) throw new Error("The image contents do not match its file extension.");
      kind = image;
    } else if (["jpg", "png", "webp"].includes(canonicalExtension ?? "")) {
      throw new Error("Choose a valid JPEG, PNG, or WebP image.");
    } else {
      if (/^(gif|bmp|tiff?|ico|avif|heic|pdf|docx?|xlsx?|pptx?|zip|gz|7z|rar|exe|dll|so|woff2?|ttf|mp[34]|mov|wav)$/i.test(suppliedExtension ?? "")) {
        throw new Error("Choose a text/code file or a JPEG, PNG, or WebP image.");
      }
      if (bytes.byteLength > MAX_TEXT_ATTACHMENT_BYTES) throw new Error("Text files must be 1 MiB or smaller.");
      decodeAttachmentText(bytes);
      kind = { mimeType: "text/plain", extension: suppliedExtension ?? "txt", fileType: suppliedExtension };
    }
    const attachment: ChatAttachment = { id: randomUUID(), fileName, byteLength: bytes.byteLength, ...kind };
    const dir = path.join(this.attachmentsRoot(), chatId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.attachmentPath(chatId, attachment), bytes, { flag: "wx" });
    return attachment;
  }

  async attachmentText(chatId: string, attachment: ChatAttachment): Promise<string> {
    if (attachment.mimeType !== "text/plain") throw new Error("This attachment is not text.");
    const bytes = await fs.readFile(this.attachmentPath(chatId, attachment));
    if (bytes.byteLength > MAX_TEXT_ATTACHMENT_BYTES) throw new Error("Text files must be 1 MiB or smaller.");
    return decodeAttachmentText(bytes);
  }

  async attachmentDataUrl(chatId: string, attachment: ChatAttachment): Promise<string> {
    if (!isImageAttachment(attachment)) throw new Error("This attachment is not an image.");
    const bytes = await fs.readFile(this.attachmentPath(chatId, attachment));
    const kind = detectImage(bytes);
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES || !kind
        || kind.extension !== attachment.extension || kind.mimeType !== attachment.mimeType) {
      throw new Error("Stored image attachment is invalid.");
    }
    return `data:${attachment.mimeType};base64,${bytes.toString("base64")}`;
  }

  async deleteAttachment(chatId: string, attachment: ChatAttachment): Promise<void> {
    try { await fs.unlink(this.attachmentPath(chatId, attachment)); } catch { /* already absent */ }
  }

  async pruneAttachments(rec: ChatRecord): Promise<void> {
    if (!isValidChatId(rec.id)) return;
    const keep = new Set(rec.messages.flatMap(message => message.attachments ?? []).map(item => `${item.id}.${item.extension}`));
    const dir = path.join(this.attachmentsRoot(), rec.id);
    let entries: string[];
    try { entries = await fs.readdir(dir); } catch { return; }
    await Promise.all(entries.filter(entry => !keep.has(entry)).map(async entry => {
      if (/^[0-9a-f-]+\.(?:jpg|png|webp)$/i.test(entry)) {
        try { await fs.unlink(path.join(dir, entry)); } catch { /* ignore races */ }
      }
    }));
    try { await fs.rmdir(dir); } catch { /* retained files or already absent */ }
  }

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir(), { recursive: true });
  }

  async list(): Promise<{ id: string; title: string; updatedAt: number }[]> {
    try { return (await this.metadata()).map(({ id, title, updatedAt }) => ({ id, title, updatedAt })); }
    catch { return []; }
  }

  async metadata(reconcile = false): Promise<ChatHeader[]> {
    if (reconcile) await this.index.reconcile();
    return this.index.list();
  }

  async rebuildWorkspaceIndex(): Promise<number> {
    return (await this.index.rebuild()).chats.length;
  }

  watch(onChange: () => void): { dispose(): void } { return this.index.watch(onChange); }

  /** Called under the workspace write lock; legacy conversion cannot race a save. */
  private async readHeader(id: string): Promise<IndexedChat | undefined> {
    const file = path.join(this.dir(), id + ".json");
    const indexed = await readChatHeader(file);
    if (indexed) {
      if (indexed.header.id !== id) throw new Error("Chat header does not match its filename.");
      return indexed;
    }
    const raw = parseChatRecord(await fs.readFile(file, "utf8"));
    const rec = this.withWorkspace(raw, id);
    if (!this.belongsToWorkspace(rec)) return undefined;
    // Preserve all original fields and transcript data during the one-time conversion.
    await writeChatFile(file, raw, makeChatHeader(rec));
    return readChatHeader(file);
  }

  async load(id: string): Promise<ChatRecord | undefined> {
    if (!isValidChatId(id)) return undefined;
    try {
      await this.ensureDir();
      const raw = await fs.readFile(path.join(this.dir(), id + ".json"), "utf-8");
      const rec = this.withWorkspace(parseChatRecord(raw), id);
      return this.belongsToWorkspace(rec) ? rec : undefined;
    } catch {
      return undefined;
    }
  }

  private serialize<T>(id: string, task: () => Promise<T>): Promise<T> {
    return this.index.change(id, task);
  }

  private async writeRecord(rec: ChatRecord): Promise<void> {
    await writeChatFile(path.join(this.dir(), rec.id + ".json"), rec);
  }

  async save(rec: ChatRecord): Promise<void> {
    if (!isValidChatId(rec.id)) throw new Error(`Invalid chat id: ${rec.id}`);
    await this.ensureDir();
    await this.serialize(rec.id, async () => {
      const existing = await this.load(rec.id);
      // Memory maintenance is independent of the live session's transcript.
      // A session save must never overwrite a newer manual/background summary.
      if (existing) {
        rec.memory = existing.memory;
        rec.memoryCreations = existing.memoryCreations?.filter(item =>
          rec.messages.some(message => message.role === "assistant" && message.ts === item.messageTs));
      }
      rec.workspaceRoot = this.workspaceRoot;
      rec.updatedAt = Date.now();
      await this.writeRecord(rec);
    });
  }

  async updateMemory(id: string, update: (rec: ChatRecord) => ChatMemory | undefined, messageTs?: number): Promise<boolean> {
    if (!isValidChatId(id)) return false;
    return this.serialize(id, async () => {
      const rec = await this.load(id);
      if (!rec) return false;
      const memory = update(rec);
      if (!memory) return false;
      const operation = rec.memory?.text.trim() ? "update" : "create";
      rec.memory = memory;
      if (messageTs !== undefined && rec.messages.some(message => message.role === "assistant" && message.ts === messageTs)) {
        const creation: MemoryCreation = memory.error
          ? { messageTs, operation, status: "failed", error: memory.error }
          : { messageTs, operation, status: "created", text: memory.text, generatedAt: memory.generatedAt };
        rec.memoryCreations = [...(rec.memoryCreations ?? []).filter(item => item.messageTs !== messageTs), creation];
      }
      await this.writeRecord(rec);
      return true;
    });
  }

  /** Full records are only for operations that need transcript contents. */
  async records(): Promise<ChatRecord[]> {
    const records = await Promise.all((await this.list()).map(chat => this.load(chat.id)));
    return records.filter((rec): rec is ChatRecord => !!rec);
  }

  async delete(id: string): Promise<void> {
    if (!isValidChatId(id)) return;
    await this.serialize(id, async () => {
      const entry = await this.readHeader(id);
      if (!entry || entry.header.workspaceRoot !== this.workspaceRoot) return;
      await fs.unlink(path.join(this.dir(), id + ".json"));
      await fs.rm(path.join(this.attachmentsRoot(), id), { recursive: true, force: true });
    }).catch(() => undefined);
  }

  /** Delete every chat belonging to this storage instance's workspace. */
  async deleteAll(): Promise<void> {
    const chats = await this.list();
    await Promise.all(chats.map(chat => this.delete(chat.id)));
  }

  /** Clone a conversation through the response to one user message. */
  async fork(rec: ChatRecord, throughUserMessageTs?: number): Promise<ChatRecord> {
    let end = rec.messages.length;
    if (throughUserMessageTs !== undefined) {
      const userIndex = rec.messages.findIndex(
        message => message.role === "user" && message.ts === throughUserMessageTs
      );
      if (userIndex >= 0) {
        const nextUser = rec.messages.findIndex(
          (message, index) => index > userIndex && message.role === "user" && !message.steering
        );
        end = nextUser >= 0 ? nextUser : rec.messages.length;
      }
    }

    const forked = this.newRecord(rec.toolCallingMode);
    forked.title = rec.title;
    forked.mode = rec.mode;
    forked.reasoningEffort = normalizeReasoningEffort(rec.reasoningEffort);
    forked.messages = structuredClone(rec.messages.slice(0, end));
    if (forked.messages.some(message => message.role === "assistant" && message.ts === rec.pendingPlanMessageTs)) {
      forked.pendingPlanMessageTs = rec.pendingPlanMessageTs;
    }
    if (end === rec.messages.length && rec.planning) forked.planning = true;
    // A historical fork must not inherit a summary containing later turns.
    if (end === rec.messages.length && rec.contextMessages) {
      forked.contextMessages = structuredClone(rec.contextMessages);
      forked.initialMemories = rec.initialMemories && structuredClone(rec.initialMemories);
      forked.tokenizerModel = rec.tokenizerModel;
    } else if (rec.contextMessages) {
      // Transcript token caches can predate the model used by the compacted
      // context. Historical forks must count their rebuilt context afresh.
      for (const message of forked.messages) delete message.tokens;
    } else {
      forked.tokenizerModel = rec.tokenizerModel;
    }
    forked.totalTokens = modelMessages(forked).reduce(
      (total, message) => total + (message.tokens ?? 0),
      0
    );
    try {
      for (const attachment of forked.messages.flatMap(message => message.attachments ?? [])) {
        const destDir = path.join(this.attachmentsRoot(), forked.id);
        await fs.mkdir(destDir, { recursive: true });
        await fs.copyFile(this.attachmentPath(rec.id, attachment), this.attachmentPath(forked.id, attachment));
      }
      await this.save(forked);
    } catch (error) {
      await fs.rm(path.join(this.attachmentsRoot(), forked.id), { recursive: true, force: true });
      throw error;
    }
    return forked;
  }

  /** Delete empty chats in this workspace, rechecking under the write lock. */
  async deleteEmpty(exceptId?: string): Promise<void> {
    for (const chat of await this.metadata()) {
      if (chat.id === exceptId || chat.messageCount) continue;
      await this.serialize(chat.id, async () => {
        const current = await this.readHeader(chat.id);
        if (!current || current.header.workspaceRoot !== this.workspaceRoot || current.header.messageCount) return;
        await fs.unlink(path.join(this.dir(), chat.id + ".json"));
        await fs.rm(path.join(this.attachmentsRoot(), chat.id), { recursive: true, force: true });
      });
    }
  }

  newRecord(
    toolCallingMode: ToolCallingProfile,
    reasoningEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT
  ): ChatRecord {
    const now = Date.now();
    return {
      id: randomUUID(),
      workspaceRoot: this.workspaceRoot,
      createdAt: now,
      updatedAt: now,
      title: "New chat",
      toolCallingMode,
      mode: "act",
      reasoningEffort,
      messages: [],
      totalTokens: 0
    };
  }

  private belongsToWorkspace(rec: ChatRecord): boolean {
    return normalizeWorkspaceRoot(rec.workspaceRoot ?? "") === this.workspaceRoot;
  }

  private withWorkspace(rec: ChatRecord, id: string): ChatRecord {
    const normalizeMessages = (messages: ChatMessage[]): ChatMessage[] => messages.map(message => {
      const attachments = Array.isArray(message.attachments)
        ? message.attachments.filter(isValidAttachment).slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
        : undefined;
      return attachments?.length ? { ...message, attachments } : { ...message, attachments: undefined };
    });
    const messages = normalizeMessages(Array.isArray(rec.messages) ? rec.messages : []);
    return {
      ...rec,
      id,
      workspaceRoot: normalizeWorkspaceRoot(rec.workspaceRoot ?? ""),
      toolCallingMode: normalizeToolCallingProfile(rec.toolCallingMode),
      mode: normalizeChatMode(rec.mode),
      reasoningEffort: normalizeReasoningEffort(rec.reasoningEffort),
      messages,
      memory: validMemory(rec.memory) ? rec.memory : undefined,
      memoryCreations: Array.isArray(rec.memoryCreations) ? rec.memoryCreations.filter(validMemoryCreation) : undefined,
      recalledMemories: Array.isArray(rec.recalledMemories) ? rec.recalledMemories.filter(validSnapshot).slice(-MAX_MEMORY_COUNT) : undefined,
      initialMemories: Array.isArray(rec.initialMemories) ? rec.initialMemories.filter(validSnapshot).slice(-MAX_MEMORY_COUNT) : undefined,
      contextMessages: Array.isArray(rec.contextMessages) ? normalizeMessages(rec.contextMessages) : undefined
    } as ChatRecord;
  }
}

function validAttachmentName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 255
    && name !== "." && name !== ".." && !/[\\/]/.test(name) && !Array.from(name).some(char => char.charCodeAt(0) < 32) && name === path.basename(name);
}

export function isValidAttachment(value: unknown): value is ChatAttachment {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ChatAttachment>;
  if (typeof item.id !== "string" || !isValidChatId(item.id) || !validAttachmentName(item.fileName)
      || !Number.isInteger(item.byteLength) || (item.byteLength ?? -1) < 0) return false;
  if (item.mimeType === "text/plain") {
    return (item.byteLength ?? 0) <= MAX_TEXT_ATTACHMENT_BYTES
      && item.extension === (attachmentFileType(item.fileName) ?? "txt")
      && item.fileType === attachmentFileType(item.fileName);
  }
  return (item.byteLength ?? 0) > 0 && (item.byteLength ?? 0) <= MAX_ATTACHMENT_BYTES
    && ((item.mimeType === "image/jpeg" && item.extension === "jpg")
      || (item.mimeType === "image/png" && item.extension === "png")
      || (item.mimeType === "image/webp" && item.extension === "webp"));
}

/** Decode common Unicode text encodings and reject binary/control data. */
function decodeAttachmentText(bytes: Uint8Array): string {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    for (const char of text) {
      const code = char.charCodeAt(0);
      if (code < 9 || code === 11 || (code > 13 && code < 32)) throw new Error("binary");
    }
    return text;
  } catch {
    throw new Error("Choose a UTF-8 or UTF-16 text/code file; binary files are not supported.");
  }
}

function detectImage(bytes: Uint8Array): Pick<ChatAttachment, "mimeType" | "extension"> | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
      && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return undefined;
}

export function titleFromFirstMessage(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  const words = oneLine.split(" ").filter(Boolean).slice(0, 6);
  if (words.length === 1) return `${words[0]} chat`;
  const fallback = words.join(" ");
  return fallback || "New chat";
}

/** The transcript and model context share an array until the first compaction. */
export function modelMessages(rec: ChatRecord): ChatMessage[] {
  // Rebuilt histories (for example an edited chat or historical fork) may
  // contain terminal cards even when their separate context was discarded.
  if (!rec.contextMessages && rec.messages.some(message => message.interruption)) {
    rec.contextMessages = rec.messages.filter(message => !message.interruption);
  }
  return rec.contextMessages ?? rec.messages;
}

export function appendChatMessage(rec: ChatRecord, message: ChatMessage): void {
  rec.messages.push(message);
  if (rec.contextMessages) rec.contextMessages.push(structuredClone(message));
}
