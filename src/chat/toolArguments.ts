/** Compatibility argument normalization, before tool validation and approval. */
import type { InsertTextArgs, ReadFileArgs, ReplaceRangeArgs } from "../tools/fsTools.js";

export type PreparedWriteArgs =
  | { kind: "write_file"; path: string; content: string }
  | { kind: "create_file"; path: string; content: string }
  | { kind: "edit_file"; path: string; baseRevision: string; edits: { oldText: string; newText: string }[] }
  | ({ kind: "insert_text" } & InsertTextArgs)
  | ({ kind: "replace_range" } & ReplaceRangeArgs);

/**
 * The call packed several argument objects into one array. Executing just the
 * first (and silently dropping the rest) would desync the model's beliefs from
 * the file system, so this is surfaced as a distinct, recoverable error.
 */
export class MultipleToolArgsError extends Error {
  constructor(count: number) {
    super(
      `received ${count} separate argument objects in a single tool call. ` +
        `Each tool call takes exactly one JSON object of arguments — emit one tool call per action instead.`
    );
    this.name = "MultipleToolArgsError";
  }
}

export function normalizeToolArgs(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("\"")) {
      try { return normalizeToolArgs(JSON.parse(trimmed)); } catch (err) {
        if (err instanceof MultipleToolArgsError) throw err;
        /* fall through */
      }
    }
    return {};
  }
  if (Array.isArray(value)) {
    if (value.length > 1) throw new MultipleToolArgsError(value.length);
    if (value.length === 1) return normalizeToolArgs(value[0]);
    return {};
  }
  if (!value || typeof value !== "object") return {};
  const obj = value as Record<string, unknown>;
  // Unwrap compatibility envelopes only when they are actually envelopes.
  // A real tool parameter named `args` must remain intact.
  const keys = Object.keys(obj);
  const wrapper = ["arguments", "args", "input", "parameters"].find(key =>
    key in obj && (keys.length === 1 || (key === "arguments" && keys.every(name => name === "name" || name === "arguments")))
  );
  if (wrapper) return normalizeToolArgs(obj[wrapper]);
  return obj;
}

/**
 * Argument source for update_todos: a bare (multi-element) array of todos is a
 * legitimate shape that normalizeToolArgs cannot represent, so fall back to
 * the raw JSON parse whenever it yields an array; otherwise use the already-
 * normalized record (which correctly unwraps `{arguments: {todos: [...]}}`).
 */
export function todoArgsSource(argsJson: string, normalized: Record<string, unknown>): unknown {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* fall through to the normalized record */ }
  return normalized;
}

export function normalizeWriteToolArgs(toolName: string, args: Record<string, unknown>, rawArgsJson?: string): PreparedWriteArgs {
  if (toolName === "write_file") {
    return { kind: "write_file", ...normalizeWriteFileArgs(args, rawArgsJson) };
  }
  if (toolName === "create_file") {
    return { kind: "create_file", ...normalizeWriteFileArgs(args, rawArgsJson) };
  }
  if (toolName === "edit_file") {
    const path = args.path;
    const baseRevision = args.baseRevision;
    const edits = args.edits;
    if (typeof path !== "string" || typeof baseRevision !== "string" || !Array.isArray(edits)) {
      throw new Error("edit_file requires path, baseRevision, and an edits array.");
    }
    return {
      kind: "edit_file",
      path,
      baseRevision,
      edits: edits as { oldText: string; newText: string }[]
    };
  }
  if (toolName === "insert_text") {
    return { kind: "insert_text", ...normalizeInsertTextArgs(args, rawArgsJson) };
  }
  if (toolName === "replace_range") {
    return { kind: "replace_range", ...normalizeReplaceRangeArgs(args, rawArgsJson) };
  }
  throw new Error(`Unknown write tool: ${toolName}`);
}

function normalizeWriteFileArgs(args: Record<string, unknown>, rawArgsJson?: string): { path: string; content: string } {
  const normalized = normalizeToolArgs(args);
  const recovered = rawArgsJson ? recoverWriteFileArgsFromRaw(rawArgsJson) : {};
  const pathValue = normalized.path
    ?? normalized.file_path
    ?? normalized.filePath
    ?? normalized.filepath
    ?? normalized.filename
    ?? normalized.fileName
    ?? normalized.file
    ?? recovered.path;
  const contentValue = normalized.content
    ?? normalized.text
    ?? normalized.contents
    ?? normalized.body
    ?? normalized.new_content
    ?? normalized.newContent
    ?? normalized.value
    ?? recovered.content;
  if (typeof pathValue !== "string" || pathValue.trim() === "") {
    throw new Error(buildWriteArgsError("path", normalized, rawArgsJson, "path, file_path, filePath, filename"));
  }
  if (typeof contentValue !== "string") {
    throw new Error(buildWriteArgsError("string content", normalized, rawArgsJson, "content, contents, text, body"));
  }
  return { path: pathValue, content: contentValue };
}

function normalizeInsertTextArgs(args: Record<string, unknown>, rawArgsJson?: string): InsertTextArgs {
  const normalized = normalizeToolArgs(args);
  const pathValue = normalized.path
    ?? normalized.file_path
    ?? normalized.filePath
    ?? normalized.filepath
    ?? normalized.filename
    ?? normalized.fileName
    ?? normalized.file;
  const lineValue = normalized.line
    ?? normalized.lineNumber
    ?? normalized.line_number
    ?? normalized.beforeLine
    ?? normalized.before_line;
  const textValue = normalized.text
    ?? normalized.content
    ?? normalized.insert
    ?? normalized.value;
  const expectedLineValue = normalized.expectedLine
    ?? normalized.expected_line
    ?? normalized.currentLine
    ?? normalized.current_line
    ?? normalized.anchor;
  if (typeof pathValue !== "string" || pathValue.trim() === "") {
    throw new Error(buildToolArgsError("insert_text", "path", normalized, rawArgsJson, "path, file_path, filePath, filename"));
  }
  const line = normalizeLineNumber(lineValue);
  if (line === undefined) {
    throw new Error(buildToolArgsError("insert_text", "integer line", normalized, rawArgsJson, "line, lineNumber, line_number"));
  }
  if (typeof textValue !== "string") {
    throw new Error(buildToolArgsError("insert_text", "string text", normalized, rawArgsJson, "text, content, insert, value"));
  }
  if (typeof expectedLineValue !== "string") {
    throw new Error(buildToolArgsError(
      "insert_text",
      "string expectedLine safety precondition",
      normalized,
      rawArgsJson,
      "expectedLine"
    ));
  }
  return { path: pathValue, line, expectedLine: expectedLineValue, text: textValue };
}

function normalizeReplaceRangeArgs(args: Record<string, unknown>, rawArgsJson?: string): ReplaceRangeArgs {
  const normalized = normalizeToolArgs(args);
  const pathValue = normalized.path
    ?? normalized.file_path
    ?? normalized.filePath
    ?? normalized.filepath
    ?? normalized.filename
    ?? normalized.fileName
    ?? normalized.file;
  const startValue = normalized.startLine
    ?? normalized.start_line
    ?? normalized.start
    ?? normalized.fromLine
    ?? normalized.from_line;
  const endValue = normalized.endLine
    ?? normalized.end_line
    ?? normalized.end
    ?? normalized.toLine
    ?? normalized.to_line;
  const contentValue = normalized.content
    ?? normalized.text
    ?? normalized.replacement
    ?? normalized.value;
  const expectedContentValue = normalized.expectedContent
    ?? normalized.expected_content
    ?? normalized.oldContent
    ?? normalized.old_content
    ?? normalized.currentContent
    ?? normalized.current_content;
  if (typeof pathValue !== "string" || pathValue.trim() === "") {
    throw new Error(buildToolArgsError("replace_range", "path", normalized, rawArgsJson, "path, file_path, filePath, filename"));
  }
  const startLine = normalizeLineNumber(startValue);
  const endLine = normalizeLineNumber(endValue);
  if (startLine === undefined) {
    throw new Error(buildToolArgsError("replace_range", "integer startLine", normalized, rawArgsJson, "startLine, start_line, start"));
  }
  if (endLine === undefined) {
    throw new Error(buildToolArgsError("replace_range", "integer endLine", normalized, rawArgsJson, "endLine, end_line, end"));
  }
  if (typeof contentValue !== "string") {
    throw new Error(buildToolArgsError("replace_range", "string content", normalized, rawArgsJson, "content, text, replacement, value"));
  }
  if (typeof expectedContentValue !== "string") {
    throw new Error(buildToolArgsError(
      "replace_range",
      "string expectedContent safety precondition",
      normalized,
      rawArgsJson,
      "expectedContent"
    ));
  }
  return { path: pathValue, startLine, endLine, expectedContent: expectedContentValue, content: contentValue };
}

export function normalizeAskUserQuestionArgs(
  args: Record<string, unknown>,
  rawArgsJson?: string
): { question: string; suggestions: string[] } {
  const normalized = normalizeToolArgs(args);
  const questionValue = normalized.question ?? normalized.prompt ?? normalized.text ?? normalized.q;
  if (typeof questionValue !== "string" || questionValue.trim() === "") {
    throw new Error(buildToolArgsError("ask_user_question", "question", normalized, rawArgsJson, "question"));
  }
  const suggestions = normalizeSuggestionList(
    normalized.suggestions ?? normalized.options ?? normalized.choices ?? normalized.answers
  );
  if (suggestions.length < 2) {
    throw new Error(
      `ask_user_question requires at least 2 distinct non-empty suggestions; received ${suggestions.length}. ` +
        `Provide a "suggestions" array of 2-3 short strings — the user can also type their own answer.`
    );
  }
  return { question: questionValue.trim(), suggestions };
}

function normalizeSuggestionList(value: unknown): string[] {
  let list = value;
  if (typeof list === "string") {
    const trimmed = list.trim();
    if (trimmed.startsWith("[")) {
      try { list = JSON.parse(trimmed); } catch { /* fall through to single-value handling */ }
    }
  }
  const raw = Array.isArray(list) ? list : list === undefined || list === null ? [] : [list];
  const out: string[] = [];
  for (const item of raw) {
    const text =
      typeof item === "string" ? item.trim()
      : typeof item === "number" || typeof item === "boolean" ? String(item)
      : "";
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

export function normalizeReadFileArgs(args: Record<string, unknown>, rawArgsJson?: string): ReadFileArgs {
  const normalized = normalizeToolArgs(args);
  const pathValue = normalized.path
    ?? normalized.file_path
    ?? normalized.filePath
    ?? normalized.filepath
    ?? normalized.filename
    ?? normalized.fileName
    ?? normalized.file;
  if (typeof pathValue !== "string" || pathValue.trim() === "") {
    throw new Error(buildToolArgsError("read_file", "path", normalized, rawArgsJson, "path, file_path, filePath, filename"));
  }
  const out: ReadFileArgs = { path: pathValue };
  const startRaw = normalized.startLine
    ?? normalized.start_line
    ?? normalized.start
    ?? normalized.fromLine
    ?? normalized.from_line
    ?? normalized.firstLine
    ?? normalized.first_line;
  const endRaw = normalized.endLine
    ?? normalized.end_line
    ?? normalized.end
    ?? normalized.toLine
    ?? normalized.to_line
    ?? normalized.lastLine
    ?? normalized.last_line;
  // A range key that was sent but does not parse is an error — silently
  // reading the whole file instead could blow the context the model was
  // trying to protect.
  if (startRaw !== undefined && startRaw !== null) {
    const startLine = normalizeLineNumber(startRaw);
    if (startLine === undefined) {
      throw new Error(buildToolArgsError("read_file", "integer startLine", normalized, rawArgsJson, "startLine, start_line, start"));
    }
    out.startLine = startLine;
  }
  if (endRaw !== undefined && endRaw !== null) {
    const endLine = normalizeLineNumber(endRaw);
    if (endLine === undefined) {
      throw new Error(buildToolArgsError("read_file", "integer endLine", normalized, rawArgsJson, "endLine, end_line, end"));
    }
    out.endLine = endLine;
  }
  return out;
}

function normalizeLineNumber(value: unknown): number | undefined {
  const n = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : NaN;
  return Number.isInteger(n) ? n : undefined;
}

function recoverWriteFileArgsFromRaw(raw: string): { path?: string; content?: string } {
  return {
    path: extractRawStringField(raw, ["path", "file_path", "filePath", "filepath", "filename", "fileName", "file"]),
    content: extractRawStringField(raw, ["content", "text", "contents", "body", "new_content", "newContent", "value"])
  };
}

function extractRawStringField(raw: string, keys: string[]): string | undefined {
  const allKeys = [
    "path", "file_path", "filePath", "filepath", "filename", "fileName", "file",
    "content", "text", "contents", "body", "new_content", "newContent", "value"
  ];
  const keyPattern = keys.map(escapeRegex).join("|");
  const startRe = new RegExp(`["'](${keyPattern})["']\\s*:\\s*["']`);
  const start = startRe.exec(raw);
  if (!start || start.index === undefined) return undefined;
  const valueStart = start.index + start[0].length;
  const nextFieldRe = new RegExp(`,\\s*["'](?:${allKeys.map(escapeRegex).join("|")})["']\\s*:`, "g");
  nextFieldRe.lastIndex = valueStart;
  const next = nextFieldRe.exec(raw);
  const valueEnd = next?.index ?? raw.lastIndexOf("}");
  const end = valueEnd > valueStart ? valueEnd : raw.length;
  let value = raw.slice(valueStart, end).trim();
  if (value.endsWith(",")) value = value.slice(0, -1).trimEnd();
  if (value.endsWith("\"") || value.endsWith("'")) value = value.slice(0, -1);
  return unescapeJsonishString(value);
}

function unescapeJsonishString(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/\r?\n/g, "\\n")}"`);
  } catch {
    return value
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildWriteArgsError(
  needed: string,
  normalized: Record<string, unknown>,
  rawArgsJson: string | undefined,
  expectedKeys: string
): string {
  return buildToolArgsError("write_file", needed, normalized, rawArgsJson, expectedKeys);
}

function buildToolArgsError(
  toolName: string,
  needed: string,
  normalized: Record<string, unknown>,
  rawArgsJson: string | undefined,
  expectedKeys: string
): string {
  const keys = Object.keys(normalized).join(", ") || "(none)";
  const raw = rawArgsJson ? rawArgsJson.slice(0, 400) : "";
  const rawHint = raw
    ? `\nRaw input received: ${raw}${rawArgsJson && rawArgsJson.length > 400 ? "..." : ""}`
    : "";
  return `${toolName} requires a ${needed}. Detected keys after normalization: ${keys}. Expected one of: ${expectedKeys}.${rawHint}`;
}
