import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { assertInsideWorkspace } from "../tools/workspaceGuard.js";
import type { ChatMessage } from "./storage.js";

/** Full, host-only snapshots; null distinguishes a new file from an empty file. */
export interface FileUndoSnapshot {
  path: string;
  previous: string | null;
  next: string;
}

export function turnFileEdits(messages: ChatMessage[], userTs: number, filePath?: string): ChatMessage[] {
  const start = messages.findIndex(message => message.role === "user" && !message.steering && message.ts === userTs);
  if (start < 0) return [];
  const end = messages.findIndex((message, index) => index > start && message.role === "user" && !message.steering);
  return messages.slice(start + 1, end < 0 ? undefined : end)
    .filter(message => message.role === "tool" && message.toolCall?.status === "executed" && message.toolCall.fileChange
      && (filePath === undefined || message.toolCall.fileChange.path === filePath));
}

/** Refuse incomplete legacy history and intervening edits, rather than guessing. */
export function fileUndoPlan(messages: ChatMessage[]): FileUndoSnapshot[] {
  const files = new Map<string, FileUndoSnapshot>();
  if (!messages.length) throw new Error("There are no file edits to undo in this response.");
  for (const message of messages) {
    const call = message.toolCall;
    if (call?.fileUndoState === "undone") continue;
    const snapshot = call?.fileUndo;
    if (!snapshot || call?.fileUndoState !== "available" || typeof snapshot.path !== "string"
      || (snapshot.previous !== null && typeof snapshot.previous !== "string") || typeof snapshot.next !== "string") {
      throw new Error("Undo is unavailable because complete, lossless file snapshots were not saved for this response.");
    }
    const existing = files.get(snapshot.path);
    if (existing) {
      if (existing.next !== snapshot.previous) throw new Error(`Cannot undo ${snapshot.path}: it changed between the response's edits.`);
      existing.next = snapshot.next;
    } else files.set(snapshot.path, { ...snapshot });
  }
  if (!files.size) throw new Error("These file edits have already been undone.");
  return [...files.values()];
}

async function content(file: string): Promise<string | null> {
  try {
    const bytes = await fs.readFile(file);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(`Cannot undo ${path.basename(file)}: its contents are no longer UTF-8 text.`);
    return text;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Preflight every file before changing any, then roll back a failed batch. */
export async function undoFiles(
  workspaceRoot: string,
  changes: FileUndoSnapshot[],
  check: (absolute: string) => void | Promise<void> = () => undefined
): Promise<{ undonePaths: string[]; error?: string }> {
  const plans: { change: FileUndoSnapshot; absolute: string; mode: number }[] = [];
  const paths = new Set<string>();
  for (const change of changes) {
    const absolute = await assertInsideWorkspace(workspaceRoot, change.path);
    if (paths.has(absolute)) throw new Error(`Cannot undo duplicate file target: ${change.path}.`);
    paths.add(absolute);
    await check(absolute);
    if (await content(absolute) !== change.next) throw new Error(`Cannot undo ${change.path}: it has changed since this response. No files were changed.`);
    plans.push({ change, absolute, mode: (await fs.stat(absolute)).mode });
  }
  const applied: typeof plans = [];
  const replace = async (plan: typeof plans[number], expected: string | null, next: string | null): Promise<void> => {
    const { absolute, change, mode } = plan;
    if (await assertInsideWorkspace(workspaceRoot, change.path) !== absolute) throw new Error(`The target of ${change.path} changed.`);
    await check(absolute);
    if (await content(absolute) !== expected) throw new Error(`${change.path} changed while undoing. Its newer contents were preserved.`);
    if (next === null) { await fs.unlink(absolute); return; }
    const temporary = path.join(path.dirname(absolute), `.locality-undo-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, next, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await fs.chmod(temporary, mode & 0o777);
      await check(absolute);
      if (await assertInsideWorkspace(workspaceRoot, change.path) !== absolute || await content(absolute) !== expected) {
        throw new Error(`${change.path} changed while undoing. Its newer contents were preserved.`);
      }
      await fs.rename(temporary, absolute);
    } finally { await fs.unlink(temporary).catch(() => undefined); }
  };
  try {
    for (const plan of plans) {
      await replace(plan, plan.change.next, plan.change.previous);
      applied.push(plan);
    }
    return { undonePaths: applied.map(plan => plan.change.path) };
  } catch (error) {
    const remaining = new Set(applied.map(plan => plan.change.path));
    for (const plan of applied.reverse()) {
      try { await replace(plan, plan.change.previous, plan.change.next); remaining.delete(plan.change.path); }
      catch { /* Never overwrite a concurrent edit to repair an incomplete undo. */ }
    }
    const detail = remaining.size
      ? ` Only these files were undone: ${[...remaining].join(", ")}.`
      : " No file edits were undone.";
    return { undonePaths: [...remaining], error: (error as Error).message + detail };
  }
}
