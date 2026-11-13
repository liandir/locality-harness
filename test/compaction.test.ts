import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRecord, ChatMessage } from "../src/chat/storage.js";
import { GenerationLengthError } from "../src/llm/completion.js";

const mocks = vi.hoisted(() => ({
  tokenize: vi.fn(),
  complete: vi.fn()
}));

vi.mock("../src/llm/client.js", () => ({
  tokenize: mocks.tokenize,
  complete: mocks.complete
}));

function fakeTokenize(_endpoint: string, text: string): Promise<number> {
  return Promise.resolve(Math.max(1, Math.ceil(text.length / 4)));
}

function msg(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content, ts: Date.now() };
}

function record(messages: ChatMessage[]): ChatRecord {
  return {
    id: "r1",
    workspaceRoot: "/w",
    createdAt: 0,
    updatedAt: 0,
    title: "t",
    toolCallingMode: "compat-gemma4",
    mode: "act",
    reasoningEffort: "effort:high",
    messages,
    totalTokens: 0
  };
}

const cfg = {
  limit: 400,
  summaryContextLimit: 4096,
  thresholdPercent: 80,
  tailBudgetPercent: 30,
  maxMessageTokensPercent: 25,
  overheadPerMessage: 0
};

beforeEach(() => {
  mocks.tokenize.mockReset();
  mocks.complete.mockReset();
  mocks.tokenize.mockImplementation(fakeTokenize);
  mocks.complete.mockResolvedValue("GOAL: keep working\nNEXT: continue");
});

describe("compact — fit guarantee", () => {
  it("summarizes the head and keeps the transcript within the target even with a giant tail", async () => {
    const { compact } = await import("../src/chat/compactor.js");
    const giant = Array.from({ length: 600 }, (_, i) => `output row ${i}`).join("\n"); // ~ big tool result
    const rec = record([
      msg("user", "please refactor the parser"),
      msg("assistant", "reading files"),
      msg("tool", "small read result A"),
      msg("assistant", "editing"),
      msg("tool", "small read result B"),
      msg("assistant", "running tests"),
      msg("tool", giant)
    ]);

    const original = structuredClone(rec.messages);
    const { keptTail } = await compact("http://x", rec, new AbortController().signal, cfg);

    // A summary was produced by the model.
    expect(mocks.complete).toHaveBeenCalled();
    expect(rec.contextMessages![0].content.startsWith("[context summary]")).toBe(true);
    // The oversized exchange is summarized without retaining a truncated tool replay.
    expect(rec.messages).toEqual(original);
    expect(rec.contextMessages!.some(message => message.content === giant)).toBe(false);
    expect(JSON.stringify(mocks.complete.mock.calls)).toContain("output row 599");
    // The compacted transcript fits the target (threshold% of the budget).
    const target = Math.floor((cfg.limit * cfg.thresholdPercent) / 100);
    expect(rec.totalTokens).toBeLessThanOrEqual(target);
    expect(keptTail).toBeGreaterThanOrEqual(1);
  });

  it("summarizes oversized harness context and preserves the original snapshots", async () => {
    const { compact } = await import("../src/chat/compactor.js");
    const context = "<locality_context>HISTORICAL_NOTE " + "reference ".repeat(600) + "</locality_context>";
    const rec = record([
      msg("user", "first"), msg("assistant", "answer"), msg("user", "second"), msg("assistant", "answer"),
      { ...msg("user", "historical request"), requestContext: context }, msg("user", "latest request")
    ]);
    const original = structuredClone(rec.messages);
    await compact("http://context-compact", rec, new AbortController().signal, cfg);
    expect(rec.messages).toEqual(original);
    expect(JSON.stringify(mocks.complete.mock.calls)).toContain("HISTORICAL_NOTE");
    expect(rec.contextMessages!.at(-1)?.requestContext).toBeUndefined();
    expect(rec.totalTokens).toBeLessThanOrEqual(cfg.limit);
  });

  it("does nothing when there are too few messages", async () => {
    const { compact } = await import("../src/chat/compactor.js");
    const rec = record([msg("user", "hi")]);
    const before = rec.messages.length;
    await compact("http://x", rec, new AbortController().signal, cfg);
    expect(rec.messages.length).toBe(before);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("chunks a very long head so no single summarize request exceeds the input budget", async () => {
    const { compact } = await import("../src/chat/compactor.js");
    // Many medium head messages that together dwarf the per-request budget.
    const head: ChatMessage[] = Array.from({ length: 12 }, (_, i) =>
      msg(i % 2 === 0 ? "assistant" : "tool", `chunk body ${i} ` + "x".repeat(300))
    );
    const rec = record([...head, msg("user", "keep going"), msg("assistant", "ok")]);

    await compact("http://x", rec, new AbortController().signal, cfg);

    expect(mocks.complete.mock.calls.length).toBeGreaterThan(0);
    for (const call of mocks.complete.mock.calls) {
      const request = call[1];
      const total = request.messages.reduce((n: number, m: { role: string; content: string }) => n + Math.ceil(`<|${m.role}|>${m.content}`.length / 4), 0);
      expect(total + request.generation.maxOutputTokens).toBeLessThan(cfg.summaryContextLimit);
    }
  });

  it("summarizes an image as metadata rather than attachment bytes", async () => {
    const { compact } = await import("../src/chat/compactor.js");
    const imageMessage = msg("user", "What is this?");
    imageMessage.attachments = [{
      id: "123e4567-e89b-42d3-a456-426614174099",
      fileName: "diagram.png",
      mimeType: "image/png",
      byteLength: 100,
      extension: "png"
    }];
    const rec = record([
      imageMessage,
      msg("assistant", "It is a diagram."),
      msg("user", "continue 1"),
      msg("assistant", "ok 1"),
      msg("user", "continue 2"),
      msg("assistant", "ok 2")
    ]);

    await compact("http://x", rec, new AbortController().signal, { ...cfg, limit: 20_000 });

    const request = JSON.stringify(mocks.complete.mock.calls[0]?.[1]);
    expect(request).toContain("[image attachment: diagram.png (image/png)]");
    expect(request).not.toContain("base64");
  });
});

describe("transcript preservation", () => {
  it("keeps the transcript and previous context unchanged if summarization fails", async () => {
    const { compact } = await import("../src/chat/compactor.js");
    const rec = record([msg("user", "original request")]);
    rec.contextMessages = [
      msg("system", "[context summary] previous"),
      ...Array.from({ length: 5 }, () => msg("assistant", "old context")),
      { ...msg("assistant", "x".repeat(8000)), reasoningContent: "retained reasoning" }
    ];
    const before = structuredClone(rec);
    mocks.complete.mockRejectedValue(new Error("server unavailable"));
    await expect(compact("http://x", rec, new AbortController().signal, cfg)).rejects.toThrow("server unavailable");
    expect(rec).toEqual(before);
  });

  it("repeated compaction summarizes only the active context and preserves new transcript entries", async () => {
    const { compact } = await import("../src/chat/compactor.js");
    const { appendChatMessage } = await import("../src/chat/storage.js");
    const rec = record([
      msg("user", "ORIGINAL_REQUEST_SENTINEL"),
      ...Array.from({ length: 6 }, () => msg("assistant", "old output"))
    ]);
    await compact("http://x", rec, new AbortController().signal, cfg);
    for (let i = 0; i < 6; i++) appendChatMessage(rec, msg("user", `follow-up ${i}`));
    const transcript = structuredClone(rec.messages);
    mocks.complete.mockClear();
    await compact("http://x", rec, new AbortController().signal, cfg);
    expect(rec.messages).toEqual(transcript);
    expect(JSON.stringify(mocks.complete.mock.calls)).not.toContain("ORIGINAL_REQUEST_SENTINEL");
    expect(rec.contextMessages!.at(-1)?.content).toBe("follow-up 5");
  });
});

it("does not overwrite messages arriving while a summary is being generated", async () => {
  const { compact } = await import("../src/chat/compactor.js");
  const { appendChatMessage } = await import("../src/chat/storage.js");
  const rec = record(Array.from({ length: 6 }, () => msg("user", "old request")));
  mocks.complete.mockImplementation(async () => {
    appendChatMessage(rec, msg("user", "arrived during compaction"));
    return "summary";
  });
  await expect(compact("http://x", rec, new AbortController().signal, cfg)).rejects.toThrow("Conversation changed");
  expect(rec.messages.at(-1)?.content).toBe("arrived during compaction");
  expect(rec.contextMessages).toBeUndefined();
});

describe("compaction recovery", () => {
  const largeHistory = () => record([msg("user", "original"), msg("assistant", "x".repeat(20_000)), msg("user", "continue")]);

  it("honors cancellation during tokenization and never reaches generation", async () => {
    const { compact } = await import("../src/chat/compactor.js");
    const ac = new AbortController();
    mocks.tokenize.mockImplementation(async () => { ac.abort(); return 100; });
    const rec = largeHistory();
    const before = structuredClone(rec);
    await expect(compact("http://cancel-tokenization", rec, ac.signal, cfg)).rejects.toThrow();
    expect(rec).toEqual(before);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it.each(["empty", "length"])("retries %s summaries with a larger generation allowance", async outcome => {
    const { compact } = await import("../src/chat/compactor.js");
    if (outcome === "empty") mocks.complete.mockResolvedValueOnce("");
    else mocks.complete.mockRejectedValueOnce(new GenerationLengthError());
    const rec = largeHistory();
    await compact("http://retry", rec, new AbortController().signal, { ...cfg, limit: 20_000, summaryContextLimit: 32_768 });
    expect(mocks.complete.mock.calls[1][1].generation.maxOutputTokens).toBeGreaterThan(mocks.complete.mock.calls[0][1].generation.maxOutputTokens);
    expect(rec.contextMessages?.[0].content).toContain("GOAL:");
  });

  it.each(["empty", "length", "transport"])("preserves previous context after repeated %s failure", async outcome => {
    const { compact } = await import("../src/chat/compactor.js");
    if (outcome === "empty") mocks.complete.mockResolvedValue("");
    else mocks.complete.mockRejectedValue(outcome === "length" ? new GenerationLengthError() : new Error("Disconnected"));
    const rec = largeHistory();
    const original = structuredClone(rec);
    await expect(compact("http://failure", rec, new AbortController().signal, cfg)).rejects.toThrow();
    expect(rec).toEqual(original);
    expect(mocks.complete).toHaveBeenCalledTimes(outcome === "transport" ? 1 : 3);
  });

  it("summarizes oversized tool arguments and their results as an exchange", async () => {
    const { compact } = await import("../src/chat/compactor.js");
    const rec = record([msg("user", "write the file"), {
      ...msg("tool", "written"), toolCall: { name: "write_file", argsJson: JSON.stringify({ path: "a.ts", content: "X".repeat(30_000) + "LAST_SENTINEL" }) }
    }]);
    await compact("http://arguments", rec, new AbortController().signal, cfg);
    expect(rec.contextMessages!.every(message => !message.toolCall)).toBe(true);
    expect(JSON.stringify(mocks.complete.mock.calls)).toContain("LAST_SENTINEL");
    expect(rec.contextMessages!.some(message => message.content === "write the file")).toBe(true);
  });

  it("counts complete chunk requests at extreme supported settings", async () => {
    const { compact } = await import("../src/chat/compactor.js");
    mocks.complete.mockResolvedValue("S".repeat(8192));
    const rec = largeHistory();
    await compact("http://chunks", rec, new AbortController().signal, { ...cfg, limit: 8192, summaryContextLimit: 8192, thresholdPercent: 95, maxMessageTokensPercent: 50 });
    for (const [, request] of mocks.complete.mock.calls) {
      const input = request.messages.reduce((sum: number, m: { role: string; content: string }) => sum + Math.ceil(`<|${m.role}|>${m.content}`.length / 4), 0);
      expect(input + request.generation.maxOutputTokens).toBeLessThan(8192);
    }
  });

  it("preserves an oversized current request instead of truncating it", async () => {
    const { compact } = await import("../src/chat/compactor.js");
    const rec = record([msg("assistant", "old"), msg("user", "x".repeat(9000))]);
    const before = structuredClone(rec);
    await expect(compact("http://pinned", rec, new AbortController().signal, cfg)).rejects.toThrow("current user request");
    expect(rec).toEqual(before);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it.each(["edit", "cancel", "save"])("does not publish a candidate after %s", async outcome => {
    const { compact } = await import("../src/chat/compactor.js");
    const rec = largeHistory();
    const ac = new AbortController();
    mocks.complete.mockImplementation(async () => {
      if (outcome === "edit") rec.messages[0].content = "changed in place";
      if (outcome === "cancel") ac.abort();
      return "GOAL: continue";
    });
    await expect(compact("http://transaction", rec, ac.signal, { ...cfg,
      commit: async () => { if (outcome === "save") throw new Error("Disk full"); }
    })).rejects.toThrow();
    expect(rec.contextMessages).toBeUndefined();
  });
});
