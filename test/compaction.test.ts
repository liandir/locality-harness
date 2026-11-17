import { beforeEach, describe, expect, it, vi } from "vitest";
import { compact, validSummary, type CompactConfig } from "../src/chat/compactor.js";
import { GenerationLengthError, StreamFailure } from "../src/llm/completion.js";
import { appendChatMessage, ChatStorage } from "../src/chat/storage.js";
import { identifyMessages, historyGroups } from "../src/chat/contextHistory.js";
import type { ChatMessage } from "../src/chat/types.js";
import type { ChatCompletionRequest } from "../src/llm/client.js";

const mocks = vi.hoisted(() => ({ tokenize: vi.fn(), complete: vi.fn(), count: vi.fn() }));
vi.mock("../src/llm/client.js", () => ({ tokenize: mocks.tokenize, complete: mocks.complete }));
vi.mock("../src/llm/server.js", () => ({ countServerPrompt: mocks.count, serverCacheRevision: () => 0 }));
const summary = "GOAL: fix parser\nSTATE: parser.ts changed\nDONE: tests passed\nPENDING: documentation\nNEXT: update docs";
const count = (request: ChatCompletionRequest) => Math.ceil(JSON.stringify(request.messages).length / 4) + 20;
let seq = 0;
const msg = (role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role, content, ts: ++seq, id: `m${seq}`, ...extra });
const record = (messages = [msg("user", "old request"), msg("assistant", "old details ".repeat(500)), msg("user", "continue")]) => ({ ...new ChatStorage("/w").newRecord("native"), messages });
const config: CompactConfig = { limit: 1000, summaryContextLimit: 4096, thresholdPercent: 80, tailBudgetPercent: 30, maxMessageTokensPercent: 25,
  request: async messages => ({ messages: [{ role: "system", content: "Instructions and tools" }, ...messages.map(m => ({ role: m.role, content: `${m.content}\n${m.requestContext ?? ""}\n${m.toolCall?.argsJson ?? ""}` }))] }) };
beforeEach(() => {
  mocks.tokenize.mockReset().mockImplementation(async (_endpoint, text: string) => Math.ceil(text.length / 4));
  mocks.complete.mockReset().mockResolvedValue(summary);
  mocks.count.mockReset().mockImplementation(async (_endpoint, request: ChatCompletionRequest) => count(request));
});

describe("compaction transaction", () => {
  it("measures the complete request, preserves the transcript, and commits coverage", async () => {
    const rec = record(), original = structuredClone(rec.messages);
    const result = await compact("http://x", rec, new AbortController().signal, config);
    expect(result.kind).toBe("committed");
    expect(rec.messages).toEqual(original);
    expect(rec.contextMessages?.at(-1)?.id).toBe(original.at(-1)?.id);
    expect(rec.contextCheckpoint).toMatchObject({ version: 1, coveredIds: [original[0].id, original[1].id], protectedIds: [original[2].id], targetReached: true });
    expect(rec.totalTokens).toBe(count(await config.request(rec.contextMessages!)));
    expect(rec.totalTokens).toBeLessThan(config.limit);
    for (const [, request] of mocks.complete.mock.calls) expect(count(request) + request.generation.maxOutputTokens).toBeLessThan(config.summaryContextLimit);
  });

  it("uses the previous checkpoint plus only newly removed history", async () => {
    const rec = record();
    rec.messages[1].content += " ORIGINAL_SENTINEL";
    await compact("http://x", rec, new AbortController().signal, config);
    const covered = [...rec.contextCheckpoint!.coveredIds];
    appendChatMessage(rec, msg("assistant", "NEW_EVIDENCE ".repeat(400)));
    appendChatMessage(rec, msg("user", "next request"));
    mocks.complete.mockClear();
    expect((await compact("http://x", rec, new AbortController().signal, config)).kind).toBe("committed");
    const inputs = JSON.stringify(mocks.complete.mock.calls);
    expect(inputs).toContain(summary.replaceAll("\n", "\\n"));
    expect(inputs).toContain("NEW_EVIDENCE");
    expect(inputs).not.toContain("ORIGINAL_SENTINEL");
    expect(rec.contextCheckpoint?.coveredIds).toEqual(expect.arrayContaining(covered));
  });

  it("keeps the latest request, steering and unconsumed tool exchange together", async () => {
    const tool = msg("tool", "test failure", { exchangeId: "pending", toolCall: { id: "call", name: "run_command", argsJson: "{}", status: "failed" } });
    const assistant = msg("assistant", "Checking", { exchangeId: "pending" });
    const steering = msg("user", "preserve exports", { steering: true });
    const rec = { ...record(), unconsumedExchangeId: "pending" };
    rec.messages.push(tool, assistant, steering);
    expect((await compact("http://x", rec, new AbortController().signal, config)).kind).toBe("committed");
    expect(rec.contextMessages?.slice(-3).map(m => m.id)).toEqual([tool.id, assistant.id, steering.id]);
    expect(historyGroups([tool, assistant, steering]).map(g => g.length)).toEqual([2, 1]);
    expect(rec.contextCheckpoint?.protectedIds).toEqual(expect.arrayContaining([tool.id, assistant.id, steering.id]));
  });

  it("fails without truncating a protected oversized request", async () => {
    const rec = record(); rec.messages.at(-1)!.content = "x".repeat(20_000);
    const before = structuredClone(rec);
    expect(await compact("http://x", rec, new AbortController().signal, config)).toMatchObject({ kind: "failed", cause: "budget" });
    expect(rec).toEqual(before); expect(mocks.complete).not.toHaveBeenCalled();
  });

  it.each(["edit", "cancel", "save", "settings"])("preserves active context on %s", async failure => {
    const rec = record(), ac = new AbortController();
    mocks.complete.mockImplementation(async () => {
      if (failure === "edit") rec.messages[0].content = "edited";
      if (failure === "cancel") ac.abort();
      return summary;
    });
    const result = await compact("http://x", rec, ac.signal, { ...config,
      assertCurrent: () => { if (failure === "settings") throw new Error("Settings changed"); },
      commit: async (_candidate, assert, publish) => { assert(); if (failure === "save") throw new Error("Disk full"); publish(); }
    });
    expect(result).toMatchObject({ kind: "failed", cause: failure === "save" ? "storage" : failure === "cancel" ? "cancelled" : "conflict" });
    expect(rec.contextMessages).toBeUndefined(); expect(rec.contextCheckpoint).toBeUndefined();
  });

  it("skips histories with no meaningful reduction", async () => {
    const rec = record([msg("assistant", "ok"), msg("user", "go")]);
    expect(await compact("http://x", rec, new AbortController().signal, config)).toMatchObject({ kind: "skipped" });
    expect(rec.contextMessages).toBeUndefined();
  });

  it("assigns stable identities to legacy transcript/context copies", () => {
    const a = [{ role: "user" as const, content: "hi", ts: 1 }, { role: "user" as const, content: "hello", ts: 1 }];
    const b = structuredClone(a); identifyMessages(a); identifyMessages(b);
    expect(a).toEqual(b); expect(new Set(a.map(m => (m as ChatMessage).id)).size).toBe(2);
    const original = structuredClone(a); identifyMessages(a); expect(a).toEqual(original);
  });
});

describe("bounded summary generation", () => {
  it.each(["empty", "malformed", "length", "transient"])("recovers from %s without accepting partial output", async failure => {
    if (failure === "length") mocks.complete.mockRejectedValueOnce(new GenerationLengthError());
    else if (failure === "transient") mocks.complete.mockRejectedValueOnce(new StreamFailure("Disconnected", { cause: "transport" }));
    else mocks.complete.mockResolvedValueOnce(failure === "empty" ? "" : "GOAL: only one section");
    expect((await compact("http://x", record(), new AbortController().signal, config)).kind).toBe("committed");
    const first = mocks.complete.mock.calls[0][1], retry = mocks.complete.mock.calls[1][1];
    if (failure === "length") expect(retry.generation.maxOutputTokens).toBeGreaterThan(first.generation.maxOutputTokens);
    else expect(retry.generation.maxOutputTokens).toBe(first.generation.maxOutputTokens);
  });
  it.each(["empty", "length", "auth"])("preserves context on repeated %s failures", async failure => {
    if (failure === "empty") mocks.complete.mockResolvedValue("");
    else mocks.complete.mockRejectedValue(failure === "length" ? new GenerationLengthError() : new StreamFailure("HTTP 401", { cause: "server_error", httpStatus: 401 }));
    const rec = record(), before = structuredClone(rec);
    expect((await compact("http://x", rec, new AbortController().signal, config)).kind).toBe("failed");
    expect(rec).toEqual(before); expect(mocks.complete).toHaveBeenCalledTimes(failure === "auth" ? 1 : 3);
  });
  it("bounds successful write payloads but retains paths, status and original evidence", async () => {
    const argsJson = JSON.stringify({ path: "parser.ts", content: "X".repeat(50_000) });
    const tool = msg("tool", "Written parser.ts; 500 lines", { toolCall: { id: "w", name: "write_file", argsJson, status: "executed" } });
    const rec = record([msg("user", "old"), tool, msg("user", "continue")]);
    expect((await compact("http://x", rec, new AbortController().signal, config)).kind).toBe("committed");
    const input = JSON.stringify(mocks.complete.mock.calls);
    expect(input).toContain("parser.ts"); expect(input).toContain("executed"); expect(input).toContain("stored payload");
    expect(input).not.toContain("X".repeat(1000)); expect(rec.messages[1].toolCall?.argsJson).toBe(argsJson);
    expect(rec.contextCheckpoint?.evidenceIds).toContain(tool.id);
  });
  it("requires five complete sections", () => {
    expect(validSummary(summary)).toBe(true);
    for (const invalid of ["", "prefix\n" + summary, summary.replace("NEXT: update docs", "NEXT:"), summary + "\nGOAL: again"]) expect(validSummary(invalid)).toBe(false);
  });
});
