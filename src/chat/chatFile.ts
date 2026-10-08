import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ChatRecord } from "./types.js";
import { transcriptRevision, validMemory, type ChatMemory } from "./memory.js";
import { isValidChatId, normalizeWorkspaceRoot } from "./storagePaths.js";

export interface ChatHeader {
  version: 1;
  id: string;
  workspaceRoot: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  revision: string;
  memory?: ChatMemory;
}

export interface FileFingerprint { size: number; mtimeMs: number; ctimeMs: number; ino: number }
export interface IndexedChat { header: ChatHeader; file: FileFingerprint }

const HEADER_PREFIX = '{"header":';
const MAX_HEADER_BYTES = 512 * 1024;

export function fingerprint(stat: Stats): FileFingerprint {
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino };
}

export function sameFile(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
}

export function makeChatHeader(rec: ChatRecord): ChatHeader {
  return {
    version: 1, id: rec.id, workspaceRoot: normalizeWorkspaceRoot(rec.workspaceRoot),
    title: typeof rec.title === "string" ? rec.title : "New chat",
    createdAt: validTime(rec.createdAt) ? rec.createdAt : 0,
    updatedAt: validTime(rec.updatedAt) ? rec.updatedAt : 0,
    messageCount: rec.messages.length, revision: transcriptRevision(rec),
    memory: validMemory(rec.memory) ? rec.memory : undefined
  };
}

export function validChatHeader(value: unknown): value is ChatHeader {
  if (!value || typeof value !== "object") return false;
  const h = value as ChatHeader;
  return h.version === 1 && typeof h.id === "string" && isValidChatId(h.id)
    && typeof h.workspaceRoot === "string" && h.workspaceRoot === normalizeWorkspaceRoot(h.workspaceRoot)
    && typeof h.title === "string" && validTime(h.createdAt) && validTime(h.updatedAt)
    && Number.isSafeInteger(h.messageCount) && h.messageCount >= 0
    && typeof h.revision === "string" && /^[a-f0-9]{64}$/.test(h.revision)
    && (h.memory === undefined || validMemory(h.memory));
}

function validTime(value: number): boolean { return Number.isFinite(value) && value >= 0 && value <= 8640000000000000; }

/** Read a bounded prefix, never deserialize a versioned chat's transcript. */
export async function readChatHeader(file: string): Promise<IndexedChat | undefined> {
  const handle = await fs.open(file, "r");
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    while (size < MAX_HEADER_BYTES) {
      const chunk = Buffer.alloc(Math.min(4096, MAX_HEADER_BYTES - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      const bytes = chunk.subarray(0, bytesRead);
      if (!size && !bytes.toString("utf8").startsWith(HEADER_PREFIX)) return undefined;
      const end = bytes.indexOf(10);
      chunks.push(end < 0 ? bytes : bytes.subarray(0, end));
      size += bytesRead;
      if (end < 0) continue;
      const line = Buffer.concat(chunks).toString("utf8");
      const parsed = JSON.parse(line.slice(0, -1) + "}") as { header?: unknown };
      if (!line.endsWith(",") || !validChatHeader(parsed.header)) throw new Error("Invalid chat header.");
      return { header: parsed.header, file: fingerprint(await handle.stat()) };
    }
    throw new Error("Invalid or oversized chat header.");
  } finally { await handle.close(); }
}

export function parseChatRecord(raw: string): ChatRecord {
  const parsed = JSON.parse(raw) as ChatRecord & { header?: unknown };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid chat file.");
  const { header, ...rec } = parsed;
  if (header === undefined) return rec;
  if (!validChatHeader(header)) throw new Error("Unsupported or invalid chat header.");
  return { ...rec, id: header.id, title: header.title, workspaceRoot: header.workspaceRoot,
    createdAt: header.createdAt, updatedAt: header.updatedAt };
}

export async function writeChatFile(file: string, rec: ChatRecord, header = makeChatHeader(rec)): Promise<void> {
  const firstLine = HEADER_PREFIX + JSON.stringify(header) + ",\n";
  if (Buffer.byteLength(firstLine) > MAX_HEADER_BYTES) throw new Error("Chat metadata is too large.");
  // Retain the existing top-level fields for compatibility with older readers.
  await writeAtomic(file, firstLine + JSON.stringify(rec, null, 2).slice(2));
}

export async function writeAtomic(file: string, contents: string): Promise<void> {
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => undefined); }
}
