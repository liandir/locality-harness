import type { LlmMessage } from "./client.js";

export type ResponseOutputItem =
  | { type: "message"; id?: string; role: "assistant"; status?: string; phase?: string; content: ({ type: "output_text"; text: string; annotations?: unknown[] } | { type: "refusal"; refusal: string })[] }
  | { type: "reasoning"; id?: string; status?: string | null; summary: { type: "summary_text"; text: string }[]; content?: { type: "reasoning_text"; text: string }[]; encrypted_content?: string }
  | { type: "function_call"; id?: string; status?: string; call_id: string; name: string; arguments: string };

/** Completed output only. Never sent to the webview or used as server-side state. */
export interface ResponseHistory {
  source: string;
  output: ResponseOutputItem[];
  /** Snapshot of rendered text, which can omit plan boundary markers. */
  text?: string;
}

export function responseItem(value: unknown): ResponseOutputItem | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : undefined;
  const status = typeof item.status === "string" ? item.status : undefined;
  if (status && status !== "completed") return;
  if (item.type === "function_call" && typeof item.call_id === "string" && item.call_id
    && typeof item.name === "string" && item.name && typeof item.arguments === "string") {
    return { type: "function_call", id, status, call_id: item.call_id, name: item.name, arguments: item.arguments };
  }
  if (item.type === "message" && item.role === "assistant" && Array.isArray(item.content)) {
    const content: Extract<ResponseOutputItem, { type: "message" }>["content"] = [];
    for (const part of item.content) {
      if (part?.type === "output_text" && typeof part.text === "string") content.push({ type: "output_text", text: part.text, annotations: [] });
      else if (part?.type === "refusal" && typeof part.refusal === "string") content.push({ type: "refusal", refusal: part.refusal });
      else return;
    }
    return { type: "message", role: "assistant", id, status, phase: typeof item.phase === "string" ? item.phase : undefined, content };
  }
  if (item.type === "reasoning" && Array.isArray(item.summary)
    && item.summary.every(part => part?.type === "summary_text" && typeof part.text === "string")
    && (item.content == null || (Array.isArray(item.content) && item.content.every(part => part?.type === "reasoning_text" && typeof part.text === "string")))) {
    return { type: "reasoning", id, status,
      summary: item.summary.map(part => ({ type: "summary_text", text: part.text })),
      content: (item.content as { text: string }[] | undefined)?.map(part => ({ type: "reasoning_text", text: part.text })),
      encrypted_content: typeof item.encrypted_content === "string" ? item.encrypted_content : undefined };
  }
}

export function normalizeResponseHistory(value: unknown): ResponseHistory | undefined {
  if (!value || typeof value !== "object") return;
  const history = value as ResponseHistory;
  if (typeof history.source !== "string" || !Array.isArray(history.output)) return;
  const output = history.output.map(responseItem);
  if (output.some(item => !item)) return;
  return { source: history.source, output: output as ResponseOutputItem[], ...(typeof history.text === "string" ? { text: history.text } : {}) };
}

export function responseText(output: ResponseOutputItem[]): string {
  return output.flatMap(item => item.type === "message" ? item.content.map(part => part.type === "output_text" ? part.text : part.refusal) : []).join("");
}

export function responseReasoning(history: ResponseHistory): string | undefined {
  return history.output.flatMap(item => item.type === "reasoning" ? item.content?.map(part => part.text) ?? [] : []).join("") || undefined;
}

export function responseIsCommentary(history?: ResponseHistory): boolean {
  return history?.output.filter(item => item.type === "message").at(-1)?.phase === "commentary";
}

function canonicalArguments(value: string): string {
  try { return JSON.stringify(JSON.parse(value)); } catch { return value; }
}

/** A compacted/edited message must not resurrect the original native payload. */
export function replayResponseHistory(message: LlmMessage, source: string): ResponseOutputItem[] | undefined {
  const history = normalizeResponseHistory(message.responseHistory);
  if (!history || history.source !== source || (history.text ?? responseText(history.output)) !== message.content) return;
  const calls = history.output.filter(item => item.type === "function_call");
  if (calls.length !== (message.tool_calls?.length ?? 0) || calls.some((call, index) => {
    const expected = message.tool_calls![index];
    return call.call_id !== expected.id || call.name !== expected.function.name
      || canonicalArguments(call.arguments) !== canonicalArguments(expected.function.arguments);
  })) return;
  return history.output;
}
