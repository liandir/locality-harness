import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatRecord } from "../src/chat/storage.js";
import type { ChatSession, UiEvent } from "../src/chat/session.js";
import type { WorkspaceMemory } from "../src/chat/workspaceMemory.js";

const mocks = vi.hoisted(() => ({
  GenerationLengthError: class GenerationLengthError extends Error {},
  MalformedNativeToolCallError: class MalformedNativeToolCallError extends Error {},
  NativeToolsUnsupportedError: class NativeToolsUnsupportedError extends Error {},
  VisionUnsupportedError: class VisionUnsupportedError extends Error {},
  settings: {
    endpoint: "http://127.0.0.1:8080",
    model: "test-model",
    titlePrompt: "Summarize the user message in 2-6 words. Output ONLY the summary.",
    commitMessagePrompt: "Write a concise Git commit message.",
    toolCallingMode: "compat-gemma4",
    reasoningBudget: 16384 as number | null,
    reasoningEfforts: { Low: "low", Medium: "medium", High: "high" },
    showThinking: true,
    autoCompact: false,
    memoryEnabled: false,
    memoryMaxCount: 10,
    autoCompactThresholdPercent: 80,
    autoapproveReads: true,
    autoapproveWrites: false,
    autoapproveCommands: false,
    readToolsEnabled: true,
    editToolsEnabled: true,
    commandToolsEnabled: true
  },
  streamChat: vi.fn(),
  tokenize: vi.fn(),
  complete: vi.fn(),
  fetchServerContextSize: vi.fn(),
  supportsVision: true,
  runCommand: vi.fn(),
  startCommand: vi.fn(),
  updateSetting: vi.fn(),
  configurationListeners: new Set<(event: { affectsConfiguration(key: string): boolean }) => void>()
}));

vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => (mocks.settings as Record<string, unknown>)[key],
      inspect: (key: string) => key === "memoryEnabled" ? { workspaceValue: mocks.settings.memoryEnabled } : undefined,
      update: mocks.updateSetting
    }),
    onDidChangeConfiguration: (listener: (event: { affectsConfiguration(key: string): boolean }) => void) => {
      mocks.configurationListeners.add(listener);
      return { dispose: () => mocks.configurationListeners.delete(listener) };
    }
  },
  window: {
    createTerminal: vi.fn(() => ({ show: vi.fn(), sendText: vi.fn(), exitStatus: undefined })),
    createOutputChannel: vi.fn(() => ({ append: vi.fn(), appendLine: vi.fn() })),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn()
  },
  commands: {
    executeCommand: vi.fn()
  }
}));

vi.mock("../src/llm/client.js", () => ({
  GenerationLengthError: mocks.GenerationLengthError,
  MalformedNativeToolCallError: mocks.MalformedNativeToolCallError,
  NativeToolsUnsupportedError: mocks.NativeToolsUnsupportedError,
  VisionUnsupportedError: mocks.VisionUnsupportedError,
  streamChat: mocks.streamChat,
  tokenize: mocks.tokenize,
  complete: mocks.complete,
  fetchServerMetadata: async () => {
    const contextSize = await mocks.fetchServerContextSize();
    if (contextSize === undefined) throw new Error("Unavailable context size");
    return { modelAlias: "test-model", contextSize, supportsVision: mocks.supportsVision };
  }
}));

vi.mock("../src/tools/terminalTool.js", () => ({
  runCommand: mocks.runCommand,
  startCommand: mocks.startCommand
}));

beforeEach(() => {
  mocks.configurationListeners.clear();
  mocks.updateSetting.mockReset().mockImplementation(async (key: string, value: unknown) => {
    (mocks.settings as Record<string, unknown>)[key] = value;
    for (const listener of mocks.configurationListeners) listener({ affectsConfiguration: key => key === "locality" });
  });
  mocks.streamChat.mockReset();
  mocks.tokenize.mockReset();
  mocks.complete.mockReset();
  mocks.fetchServerContextSize.mockReset();
  mocks.supportsVision = true;
  mocks.runCommand.mockReset();
  mocks.startCommand.mockReset();
  mocks.tokenize.mockResolvedValue(1);
  mocks.complete.mockResolvedValue("Test chat");
  mocks.fetchServerContextSize.mockResolvedValue(32768);
  mocks.runCommand.mockResolvedValue({ exitCode: 0, stdout: "ok\n", stderr: "", truncated: false });
  mocks.startCommand.mockImplementation((command, cwd, signal, onOutput) =>
    mockCommandHandle(mocks.runCommand(command, cwd, signal, onOutput))
  );
  mocks.settings.autoapproveReads = true;
  mocks.settings.autoapproveWrites = false;
  mocks.settings.autoapproveCommands = false;
  mocks.settings.readToolsEnabled = true;
  mocks.settings.editToolsEnabled = true;
  mocks.settings.commandToolsEnabled = true;
  mocks.settings.autoCompact = false;
  mocks.settings.memoryEnabled = false;
  mocks.settings.memoryMaxCount = 10;
  mocks.settings.autoCompactThresholdPercent = 80;
  mocks.settings.toolCallingMode = "compat-gemma4";
  mocks.settings.reasoningBudget = 16384;
  mocks.settings.reasoningEfforts = { Low: "low", Medium: "medium", High: "high" };
});

function contextActivityIds(events: UiEvent[]): string[] {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.kind === "contextActivity") return event.activityIds;
  }
  return [];
}

function mockCommandHandle(result: Promise<{ exitCode: number; stdout: string; stderr: string; truncated: boolean }>) {
  let output = { stdout: "", stderr: "", truncated: false };
  void result.then(value => { output = value; }, () => undefined);
  return {
    result,
    snapshot: () => output,
    wait: async () => ({ running: false as const, result: await result }),
    stop: async () => result
  };
}

describe("interrupted turn continuation", () => {
  it.each(["disconnect", "cancel"])("resumes after %s from saved tool results after reopening", async outcome => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-continue-"));
    const { ChatSession } = await import("../src/chat/session.js");
    const { ChatStorage } = await import("../src/chat/storage.js");
    const storage = new ChatStorage(ws, path.join(ws, "chats"));
    const record = storage.newRecord("native");
    mocks.settings.toolCallingMode = "native";
    mocks.settings.autoapproveWrites = true;
    const events: UiEvent[] = [];
    let session = new ChatSession({ storage, workspaceRoot: ws, record, emit: event => events.push(event) });
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield { kind: "thought", text: "Create the first file." };
        yield { kind: "toolCall", name: "create_file", argsJson: '{"path":"done.txt","content":"completed"}', id: "completed_call" };
        return;
      }
      yield { kind: "text", text: "unfinished answer" };
      yield { kind: "thought", text: "unfinished reasoning" };
      yield { kind: "toolCallProgress", name: "write_file", path: "pending.txt", content: "partial", contentLines: 1, id: "pending_call" };
      if (outcome === "cancel") session.cancel();
      throw new Error(outcome === "cancel" ? "Cancelled" : "Connection lost");
    });
    try {
      await session.sendUserMessage("Create the files");
      const terminal = record.messages.at(-1)!;
      expect(terminal.interruption?.reason).toBe(outcome === "cancel" ? "Cancelled" : "Connection lost");
      expect(events.at(-1)).toEqual({ kind: "abort", reason: terminal.interruption?.reason, messageTs: terminal.ts });
      expect(await fs.readFile(path.join(ws, "done.txt"), "utf8")).toBe("completed");
      await expect(fs.stat(path.join(ws, "pending.txt"))).rejects.toThrow();
      await session.shutdown();
      const loaded = (await storage.load(record.id))!;
      expect(loaded.messages.at(-1)).toEqual(terminal);
      session = new ChatSession({ storage, workspaceRoot: ws, record: loaded, emit: event => events.push(event) });
      const checkpointEvents = events.length;
      const completedHistory = structuredClone(loaded.messages.slice(0, -1));
      mocks.streamChat.mockImplementation(async function* (_endpoint, request) {
        // The terminal card is already gone from disk while continuation streams.
        expect(loaded.messages).toEqual(completedHistory);
        expect((await storage.load(record.id))!.messages).toEqual(completedHistory);
        const serialized = JSON.stringify(request.messages);
        expect(request.messages.filter((message: { role: string }) => message.role === "user")).toHaveLength(1);
        expect(request.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "completed_call" });
        expect(serialized).toContain("Create the first file.");
        for (const partial of ["unfinished answer", "unfinished reasoning", "pending_call", terminal.interruption!.reason]) {
          expect(serialized).not.toContain(partial);
        }
        yield { kind: "text", text: "Finished from the completed file." };
      });
      expect(await session.continueTurn(terminal.ts)).toBe(true);
      expect(events.slice(checkpointEvents).some(event => event.kind === "userMessage" || event.kind === "toolCallProposed")).toBe(false);
      expect(events.slice(checkpointEvents)).toContainEqual({ kind: "turnPreparing", reason: "context" });
      const resumed = events.slice(checkpointEvents).find(event => event.kind === "turnWorkStarted");
      expect(resumed).toMatchObject({ continued: true });
      expect(events.slice(checkpointEvents)).toContainEqual({ kind: "turnStart", messageId: resumed!.messageId });
      expect(loaded.messages.filter(message => message.role === "user")).toHaveLength(1);
      expect(loaded.messages.filter(message => message.toolCall?.name === "create_file")).toHaveLength(1);
      expect(loaded.messages.at(-1)?.content).toBe("Finished from the completed file.");
      expect(loaded.messages.some(message => message.interruption)).toBe(false);
      expect((await storage.load(record.id))!.messages).toEqual(loaded.messages);
      expect(await session.continueTurn(terminal.ts)).toBe(false);
    } finally {
      await session.shutdown();
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it("retries failed preflight without another user message and rejects duplicate or stale actions", async () => {
    mocks.settings.toolCallingMode = "native";
    mocks.fetchServerContextSize.mockRejectedValue(new Error("offline"));
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({ storage: { save: vi.fn() } as never, workspaceRoot: "/tmp/workspace", record, emit: event => events.push(event) });
    try {
      await session.sendUserMessage("Try this");
      const first = record.messages.at(-1)!.ts;
      expect(await session.continueTurn(first)).toBe(true);
      const second = record.messages.at(-1)!.ts;
      expect(second).toBeGreaterThan(first);
      expect(record.messages.filter(message => message.interruption)).toHaveLength(1);
      expect(await session.continueTurn(first)).toBe(false);
      let ready!: (size: number) => void;
      mocks.fetchServerContextSize.mockImplementation(() => new Promise<number>(resolve => { ready = resolve; }));
      mocks.streamChat.mockImplementation(async function* (_endpoint, request) {
        expect(request.messages.at(-1)).toMatchObject({ role: "user", content: "Try this" });
        yield { kind: "text", text: "Recovered" };
      });
      const resumed = session.continueTurn(second);
      await vi.waitFor(() => expect(ready).toBeDefined());
      expect(record.messages.some(message => message.interruption)).toBe(false);
      expect(await session.continueTurn(second)).toBe(false);
      mocks.fetchServerContextSize.mockResolvedValue(32768);
      ready(32768);
      await resumed;
      expect(mocks.streamChat).toHaveBeenCalledTimes(1);
      expect(record.messages.filter(message => message.role === "user")).toHaveLength(1);
      expect(events.filter(event => event.kind === "abort")).toHaveLength(2);
    } finally { await session.shutdown(); }
  });

  it("keeps retry actions unique when repeated failures occur in the same millisecond", async () => {
    mocks.fetchServerContextSize.mockRejectedValue(new Error("offline"));
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const session = new ChatSession({ storage: { save: vi.fn() } as never, workspaceRoot: "/tmp/workspace", record, emit: vi.fn() });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      await session.sendUserMessage("Try this");
      const first = record.messages.at(-1)!.ts;
      expect(await session.continueTurn(first)).toBe(true);
      const second = record.messages.at(-1)!.ts;
      expect(second).toBeGreaterThan(first);
      expect(await session.continueTurn(first)).toBe(false);
      expect(record.messages.filter(message => message.interruption)).toHaveLength(1);
      expect(await session.continueTurn(second)).toBe(true);
      expect(record.messages.at(-1)!.ts).toBeGreaterThan(second);
      expect(record.messages.filter(message => message.interruption)).toHaveLength(1);
    } finally {
      now.mockRestore();
      await session.shutdown();
    }
  });

  it("requires a fresh approval after cancelling an unexecuted write", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-continue-approval-"));
    mocks.settings.toolCallingMode = "native";
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({ storage: { save: vi.fn() } as never, workspaceRoot: ws, record, emit: event => events.push(event) });
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint, request) {
      if (pass++ < 2) {
        expect(request.messages.at(-1)).toMatchObject({ role: "user", content: "Create a file" });
        yield { kind: "toolCall", name: "create_file", argsJson: '{"path":"new.txt","content":"approved"}', id: `write_${pass}` };
      } else yield { kind: "text", text: "Done" };
    });
    try {
      const first = session.sendUserMessage("Create a file");
      await vi.waitFor(() => expect(events.some(event => event.kind === "toolCallProposed")).toBe(true));
      session.cancel();
      await first;
      expect(record.messages.at(-1)?.interruption).toBeDefined();
      const resume = session.continueTurn(record.messages.at(-1)!.ts);
      await vi.waitFor(() => expect(events.filter(event => event.kind === "toolCallProposed")).toHaveLength(2));
      await expect(fs.stat(path.join(ws, "new.txt"))).rejects.toThrow();
      const proposal = events.filter(event => event.kind === "toolCallProposed").at(-1)!;
      expect(proposal.approvalRequired).toBe(true);
      session.approve(proposal.toolId, true);
      await resume;
      expect(await fs.readFile(path.join(ws, "new.txt"), "utf8")).toBe("approved");
    } finally {
      await session.shutdown();
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it("resumes a cancelled plan in Plan mode and still requires acceptance", async () => {
    mocks.settings.toolCallingMode = "native";
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const session = new ChatSession({ storage: { save: vi.fn() } as never, workspaceRoot: "/tmp/workspace", record, emit: vi.fn() });
    mocks.streamChat.mockImplementation(async function* () { yield { kind: "text", text: "Partial plan" }; throw new Error("Disconnected"); });
    try {
      await session.sendUserMessage("Plan it", [], "plan");
      await session.cancelPlanning();
      expect(record.mode).toBe("act");
      mocks.streamChat.mockImplementation(async function* (_endpoint, request) {
        expect(request.tools.some((tool: { function: { name: string } }) => tool.function.name === "create_file")).toBe(false);
        yield { kind: "text", text: "Completed plan" };
      });
      await session.continueTurn(record.messages.at(-1)!.ts);
      expect(record.mode).toBe("plan");
      expect(session.isPlanning()).toBe(true);
      expect(record.pendingPlanMessageTs).toBe(record.messages.at(-1)!.ts);
    } finally { await session.shutdown(); }
  });
});

describe("session shutdown", () => {
  it("does not start inference after cancellation during context preparation", async () => {
    let release!: (size: number) => void;
    mocks.fetchServerContextSize.mockReturnValue(new Promise<number>(resolve => { release = resolve; }));
    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({ storage: { save: vi.fn() } as never, workspaceRoot: "/tmp/workspace", record: newRecord(), emit: event => events.push(event) });
    const turn = session.sendUserMessage("Do some work");
    await vi.waitFor(() => expect(mocks.fetchServerContextSize).toHaveBeenCalled());
    session.cancel();
    release(32768);
    await turn;
    expect(mocks.streamChat).not.toHaveBeenCalled();
    expect(events).toContainEqual({ kind: "abort", reason: "Cancelled.", messageTs: expect.any(Number) });
  });

  it("waits for preparation and storage writes before allowing a source chat to be deleted", async () => {
    let release!: (size: number) => void;
    mocks.fetchServerContextSize.mockReturnValue(new Promise<number>(resolve => { release = resolve; }));
    const { ChatSession } = await import("../src/chat/session.js");
    const save = vi.fn();
    const session = new ChatSession({ storage: { save } as never, workspaceRoot: "/tmp/workspace", record: newRecord(), emit: vi.fn() });
    const turn = session.sendUserMessage("Start work");
    await vi.waitFor(() => expect(mocks.fetchServerContextSize).toHaveBeenCalled());
    let stopped = false;
    const shutdown = session.shutdown().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release(32768);
    await Promise.all([turn, shutdown]);
    const writes = save.mock.calls.length;
    await session.sendUserMessage("Late request");
    expect(save).toHaveBeenCalledTimes(writes);
    expect(mocks.streamChat).not.toHaveBeenCalled();
  });
});

describe("ChatSession", () => {
  it.each([false, true])("accepts new messages while deferring model requests for memory creation (edit=%s)", async edit => {
    let finish!: () => void;
    const release = vi.fn();
    const memory = {
      beginChatTurn: vi.fn((_signal: AbortSignal, waiting: () => void) => {
        waiting();
        return new Promise<() => void>(resolve => { finish = () => resolve(release); });
      })
    } as unknown as WorkspaceMemory;
    mocks.streamChat.mockImplementation(async function* () { yield { kind: "text", text: "Ready" }; });
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.messages = [{ role: "user", content: "original", ts: 1 }, { role: "assistant", content: "answer", ts: 2 }];
    const events: UiEvent[] = [];
    const session = new ChatSession({ storage: { save: vi.fn() } as never, workspaceRoot: "/tmp/workspace", record, memory, emit: event => events.push(event) });
    const turn = edit ? session.editUserMessage(1, "edited") : session.sendUserMessage("next");
    expect(session.isTurnActive()).toBe(true);
    expect(events[0]).toEqual({ kind: "turnPreparing", reason: "memory" });
    if (!edit) {
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ kind: "userMessage", text: "next" })));
      expect(record.messages.at(-1)).toMatchObject({ role: "user", content: "next" });
    }
    expect(record.messages).toHaveLength(edit ? 2 : 3);
    expect(record.messages[0].content).toBe("original");
    expect(events.some(event => event.kind === "turnWorkStarted")).toBe(false);
    expect(mocks.fetchServerContextSize).not.toHaveBeenCalled();
    expect(mocks.streamChat).not.toHaveBeenCalled();
    finish();
    await turn;
    expect(mocks.streamChat).toHaveBeenCalledOnce();
    expect(events.some(event => event.kind === "turnEnd")).toBe(true);
    expect(session.isTurnActive()).toBe(false);
    expect(release).toHaveBeenCalledOnce();
    if (!edit) expect(events.filter(event => event.kind === "userMessage")).toHaveLength(1);
  });

  it("stops a waiting memory handoff without sending the pending chat to the model", async () => {
    const memory = {
      beginChatTurn: vi.fn((signal: AbortSignal, waiting: () => void) => {
        waiting();
        return new Promise<() => void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      })
    } as unknown as WorkspaceMemory;
    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({ storage: { save: vi.fn() } as never, workspaceRoot: "/tmp/workspace", record: newRecord(), memory, emit: event => events.push(event) });
    const turn = session.sendUserMessage("next");
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ kind: "userMessage", text: "next" })));
    await session.shutdown();
    await turn;
    expect(events).toContainEqual({ kind: "abort", reason: "Stopped by user.", messageTs: expect.any(Number) });
    expect(session.isTurnActive()).toBe(false);
    expect(mocks.streamChat).not.toHaveBeenCalled();
    expect(mocks.fetchServerContextSize).not.toHaveBeenCalled();
    expect(session.getRecord().contextMessages).toEqual([expect.objectContaining({ role: "user", content: "next" })]);
    expect(session.getRecord().messages.at(-1)?.interruption?.reason).toBe("Stopped by user.");
  });

  it("keeps ordinary prompt processing out of the context-loading status", async () => {
    mocks.streamChat.mockImplementation(async function* (
      _endpoint: string, request: { return_progress?: boolean; onResponseAccepted?: () => void }
    ) {
      expect(request.return_progress).toBe(true);
      request.onResponseAccepted?.();
      for (const processedTokens of [0, 1024, 2048, 4096, 4096]) {
        yield { kind: "promptProgress", processedTokens, totalTokens: 4096 };
      }
      yield { kind: "thought", text: "Considering the answer." };
      yield { kind: "text", text: "Ready" };
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.title = "Existing title";
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace", record, emit: event => events.push(event)
    });

    for (const message of ["First request", "Next request"]) {
      events.length = 0;
      await session.sendUserMessage(message);
      expect(events).not.toContainEqual({ kind: "turnPreparing", reason: "context" });
      const thoughtIndex = events.findIndex(event => event.kind === "thought");
      expect(thoughtIndex).toBeGreaterThan(-1);
      expect(events.slice(thoughtIndex).some(event => event.kind === "turnPreparing")).toBe(false);
    }
  });

  it("labels only the first model request after loading chat history as context loading", async () => {
    mocks.streamChat.mockImplementation(async function* () {
      yield { kind: "text", text: "answer" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.messages.push(
      { role: "user", content: "Earlier question", ts: 1 },
      { role: "assistant", content: "Earlier answer", ts: 2 }
    );
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: event => events.push(event)
    });

    await session.sendUserMessage("Continue the old chat");
    expect(events.filter(event => event.kind === "turnPreparing" && event.reason === "context")).toHaveLength(1);

    const secondTurnStart = events.length;
    await session.sendUserMessage("Continue again");
    expect(events.slice(secondTurnStart)).not.toContainEqual({ kind: "turnPreparing", reason: "context" });
    expect(events.slice(secondTurnStart)).toContainEqual({ kind: "turnPreparing", reason: "server" });
  });

  it.each(["progress", "partial-progress", "output"])("keeps successful reads active through result ingestion using %s", async completionSignal => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "file A\n", "utf8");
    await fs.writeFile(path.join(ws, "b.txt"), "file B\n", "utf8");
    mocks.settings.toolCallingMode = "native";
    const events: UiEvent[] = [];
    const ingested = () => events.filter(event => event.kind === "toolCallResolved"
      && event.status === "executed" && !contextActivityIds(events).includes(event.toolId));
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (
      _endpoint: string, request: { messages: unknown[]; onResponseAccepted?: () => void }
    ) {
      request.onResponseAccepted?.();
      if (pass++ === 0) {
        yield { kind: "toolCall", name: "read_file", argsJson: '{"path":"a.txt"}', id: "read_a" };
        yield { kind: "toolCall", name: "read_file", argsJson: '{"path":"b.txt"}', id: "read_b" };
        expect(ingested()).toHaveLength(0);
        return;
      }
      expect(JSON.stringify(request.messages)).toContain("file A");
      expect(JSON.stringify(request.messages)).toContain("file B");
      expect(record.messages.filter(message => message.role === "tool").map(message => message.toolCall?.status))
        .toEqual(["executed", "executed"]);
      expect(ingested()).toHaveLength(0);
      const reads = events.filter(event => event.kind === "toolCallProposed");
      expect(contextActivityIds(events)).toEqual(reads.map(event => event.toolId));
      if (completionSignal !== "output") {
        yield { kind: "promptProgress", processedTokens: 128, totalTokens: 2048 };
        yield { kind: "promptProgress", processedTokens: 1024, totalTokens: 2048 };
        expect(ingested()).toHaveLength(0);
      }
      expect(events).not.toContainEqual({ kind: "turnPreparing", reason: "context" });
      if (completionSignal === "progress") {
        yield { kind: "promptProgress", processedTokens: 2048, totalTokens: 2048 };
        expect(ingested()).toHaveLength(2);
      }
      yield { kind: "thought", text: "I have read both files." };
      expect(ingested()).toHaveLength(2);
      yield { kind: "text", text: "Done" };
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.title = "Read files";
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws, record, emit: event => events.push(event)
    });
    await session.sendUserMessage("Read both files");
    expect(pass).toBe(2);
    expect(ingested()).toHaveLength(2);
    expect(events.some(event => event.kind === "abort")).toBe(false);
  });

  it.each([
    ["list_dir", { path: "." }],
    ["glob", { pattern: "*.txt" }],
    ["write_file", { path: "a.txt", content: "changed\n" }],
    ["create_file", { path: "new.txt", content: "created\n" }],
    ["run_command", { command: "echo hello" }],
    ["update_todos", { todos: [{ content: "Check the result", status: "in_progress" }] }]
  ])("keeps %s results usable while attributing prompt ingestion to the tool", async (name, args) => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf8");
    const legacy = name === "write_file" || name === "run_command";
    mocks.settings.toolCallingMode = legacy ? "compat-qwen3" : "native";
    mocks.settings.autoapproveWrites = true;
    mocks.settings.autoapproveCommands = true;
    mocks.runCommand.mockResolvedValue({ exitCode: 0, stdout: "hello\n", stderr: "", truncated: false });
    const events: UiEvent[] = [];
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (
      _endpoint: string, request: { onResponseAccepted?: () => void; tools?: unknown[] }
    ) {
      if (legacy && request.tools) throw new mocks.NativeToolsUnsupportedError("tools unsupported");
      request.onResponseAccepted?.();
      if (pass++ === 0) {
        if (legacy) yield { kind: "text", text: `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>` };
        else yield { kind: "toolCall", name, argsJson: JSON.stringify(args), id: "call_1" };
        return;
      }
      const completed = events.find(event => event.kind === "toolCallResolved" && event.status === "executed");
      expect(completed).toMatchObject({ resultPreview: expect.any(String) });
      if (completed?.kind !== "toolCallResolved") throw new Error("Missing result");
      expect(contextActivityIds(events)).toEqual([completed.toolId]);
      yield { kind: "promptProgress", processedTokens: 128, totalTokens: 2048 };
      expect(events).not.toContainEqual({ kind: "contextActivity", activityIds: [] });
      if (name === "write_file" || name === "create_file") {
        session.requestToolDiff(completed.toolId);
        expect(events.at(-1)).toMatchObject({ kind: "toolCallResolved", diffPreview: expect.any(String) });
        expect(contextActivityIds(events)).toEqual([completed.toolId]);
      }
      yield { kind: "promptProgress", processedTokens: 2048, totalTokens: 2048 };
      expect(contextActivityIds(events)).toEqual([]);
      yield { kind: "text", text: "Done" };
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.title = "Tool results";
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws, record, emit: event => events.push(event)
    });
    await session.sendUserMessage("Use the tool");
    expect(pass).toBe(2);
    expect(events.filter(event => event.kind === "abort")).toEqual([]);
    expect(events).not.toContainEqual({ kind: "turnPreparing", reason: "context" });
  });

  it("finishes only the reads included in the current prompt", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf8");
    mocks.settings.toolCallingMode = "native";
    const events: UiEvent[] = [];
    const ingested = () => events.filter(event => event.kind === "toolCallResolved"
      && event.status === "executed" && !contextActivityIds(events).includes(event.toolId));
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ > 0) {
        expect(ingested()).toHaveLength(pass - 2);
        yield { kind: "promptProgress", processedTokens: 128, totalTokens: 2048 };
        expect(ingested()).toHaveLength(pass - 2);
        yield { kind: "promptProgress", processedTokens: 2048, totalTokens: 2048 };
        expect(ingested()).toHaveLength(pass - 1);
      }
      if (pass < 3) yield { kind: "toolCall", name: "read_file", argsJson: '{"path":"a.txt"}', id: `read_${pass}` };
      else yield { kind: "text", text: "Done" };
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws, record: newRecord(), emit: event => events.push(event)
    });
    await session.sendUserMessage("Read it twice");
    expect(pass).toBe(3);
    expect(ingested()).toHaveLength(2);
    expect(events.some(event => event.kind === "abort")).toBe(false);
  });

  it.each(["cancel", "error", "empty"])("settles pending reads when the next request ends with %s", async outcome => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf8");
    mocks.settings.toolCallingMode = "native";
    const events: UiEvent[] = [];
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield { kind: "toolCall", name: "read_file", argsJson: '{"path":"a.txt"}', id: "read_a" };
        return;
      }
      yield { kind: "promptProgress", processedTokens: 128, totalTokens: 2048 };
      expect(events).not.toContainEqual({ kind: "contextActivity", activityIds: [] });
      if (outcome === "cancel") session.cancel();
      if (outcome !== "empty") throw new Error(outcome === "cancel" ? "Cancelled" : "Server disconnected");
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws, record, emit: event => events.push(event)
    });
    await session.sendUserMessage("Read the file");
    expect(pass).toBe(2);
    expect(events.filter(event => event.kind === "toolCallResolved" && event.status === "executed")).toHaveLength(1);
    expect(events.filter(event => event.kind === "contextActivity" && !event.activityIds.length)).toHaveLength(1);
    if (outcome !== "empty") expect(events).toContainEqual({ kind: "abort", reason: outcome === "cancel" ? "Cancelled" : "Server disconnected", messageTs: expect.any(Number) });
    expect(record.messages.find(message => message.role === "tool")?.toolCall?.status).toBe("executed");
  });

  it("shows failed reads immediately and attributes ingestion of their errors to the tool", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    mocks.settings.toolCallingMode = "native";
    const events: UiEvent[] = [];
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield { kind: "toolCall", name: "read_file", argsJson: '{"path":"missing.txt"}', id: "read_missing" };
        expect(events).toContainEqual(expect.objectContaining({ kind: "toolCallResolved", status: "failed" }));
        return;
      }
      yield { kind: "promptProgress", processedTokens: 128, totalTokens: 2048 };
      yield { kind: "text", text: "The file does not exist." };
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws, record: newRecord(), emit: event => events.push(event)
    });
    await session.sendUserMessage("Read missing.txt");
    expect(pass).toBe(2);
    expect(events).not.toContainEqual({ kind: "turnPreparing", reason: "context" });
    expect(events.some(event => event.kind === "contextActivity" && event.activityIds.length)).toBe(true);
    expect(events.some(event => event.kind === "abort")).toBe(false);
  });

  it("generates the first-request chat name in parallel after the real request is accepted", async () => {
    let resolveTitle: (title: string) => void = () => undefined;
    const pendingTitle = new Promise<string>(resolve => { resolveTitle = resolve; });
    let resolveAnswer: () => void = () => undefined;
    const pendingAnswer = new Promise<void>(resolve => { resolveAnswer = resolve; });
    mocks.complete.mockReturnValue(pendingTitle);
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: { onResponseAccepted?: () => void }) {
      request.onResponseAccepted?.();
      await pendingAnswer;
      yield { kind: "text", text: "real answer" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: event => events.push(event)
    });

    const turn = session.sendUserMessage("Fix the restart button behavior");
    await vi.waitFor(() => expect(mocks.streamChat).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(1));
    expect(mocks.streamChat.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.complete.mock.invocationCallOrder[0]);
    expect(events).not.toContainEqual({ kind: "turnPreparing", reason: "title" });

    // Finishing the chat must not wait for the still-pending title request.
    resolveAnswer();
    await turn;
    expect(events).toContainEqual(expect.objectContaining({ kind: "turnEnd" }));
    expect(events).not.toContainEqual(expect.objectContaining({ kind: "titleChanged" }));

    resolveTitle("Fix restart button");
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      kind: "titleChanged",
      title: "Fix restart button"
    })));
    expect(events.findIndex(event => event.kind === "titleChanged"))
      .toBeGreaterThan(events.findIndex(event => event.kind === "turnEnd"));
  });

  it("continues the real chat silently when best-effort naming fails", async () => {
    mocks.complete.mockRejectedValue(new Error("title request failed"));
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: { onResponseAccepted?: () => void }) {
      request.onResponseAccepted?.();
      yield { kind: "text", text: "real answer" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const record = newRecord();
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: event => events.push(event)
    });

    await session.sendUserMessage("Fix the restart button behavior");

    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(1));
    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
    expect(record.title).toBe("New chat");
    expect(events).not.toContainEqual(expect.objectContaining({ kind: "notice" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "turnStart" }));
  });

  it.each([true, false])("keeps title waits visible after HTTP acceptance with tool ingestion pending (progress: %s)", async withProgress => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf8");
    mocks.settings.toolCallingMode = "native";
    let resolveTitle: (title: string) => void = () => undefined;
    mocks.complete.mockReturnValue(new Promise<string>(resolve => { resolveTitle = resolve; }));
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (
      _endpoint: string,
      request: { onResponseAccepted?: () => void }
    ) {
      request.onResponseAccepted?.();
      if (pass++ === 0) {
        yield { kind: "toolCall", name: "list_dir", argsJson: '{"path":"."}', id: "call_title_wait" };
      } else {
        // Headers can precede the server assigning this continuation a slot.
        expect(events.filter(event => event.kind === "turnPreparing").at(-1))
          .toEqual({ kind: "turnPreparing", reason: "title" });
        expect(contextActivityIds(events)).toHaveLength(1);
        if (withProgress) {
          yield { kind: "promptProgress", processedTokens: 0, totalTokens: 100 };
          expect(events.filter(event => event.kind === "turnPreparing").at(-1))
            .toEqual({ kind: "turnPreparing", reason: "server" });
          expect(contextActivityIds(events)).toHaveLength(1);
        }
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record: newRecord(),
      emit: event => events.push(event)
    });

    await session.sendUserMessage("List the directory");

    expect(events).not.toContainEqual(expect.objectContaining({ kind: "abort" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "text", delta: "done" }));

    const proposedIndex = events.findIndex(event =>
      event.kind === "toolCallProposed" && event.toolName === "list_dir"
    );
    const answerIndex = events.findIndex(event => event.kind === "text");
    const continuationEvents = events.slice(proposedIndex + 1, answerIndex);
    const ingestionEnd = continuationEvents.findIndex(event => event.kind === "contextActivity" && !event.activityIds.length);
    expect(ingestionEnd).toBeGreaterThan(-1);
    const preparing = continuationEvents.slice(0, ingestionEnd).filter(event => event.kind === "turnPreparing");
    expect(preparing.length).toBeGreaterThan(0);
    for (let index = 0; index < ingestionEnd; index++) {
      if (continuationEvents[index].kind === "turnPreparing") {
        expect(contextActivityIds(continuationEvents.slice(0, index))).toHaveLength(1);
      }
    }

    resolveTitle("Read file");
    await vi.waitFor(() =>
      expect(events).toContainEqual({ kind: "titleGenerationFinished" })
    );
  });

  it("uses native tool schemas and replays calls/results with their protocol id", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf8");
    mocks.settings.toolCallingMode = "native";
    const requests: Array<Record<string, unknown>> = [];
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: Record<string, unknown>) {
      requests.push(request);
      if (pass++ === 0) {
        yield { kind: "thought", text: "I need to inspect the requested file." };
        yield { kind: "toolCall", name: "read_file", argsJson: '{"path":"a.txt"}', id: "call_read_1" };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: event => events.push(event)
    });
    await session.sendUserMessage("read it");

    expect((requests[0].tools as Array<{ function: { name: string } }>).some(tool => tool.function.name === "read_file")).toBe(true);
    const replay = requests[1].messages as Array<Record<string, unknown>>;
    expect(replay).toContainEqual(expect.objectContaining({
      role: "assistant",
      reasoning_content: "I need to inspect the requested file.",
      tool_calls: [expect.objectContaining({ id: "call_read_1" })]
    }));
    expect(replay).toContainEqual(expect.objectContaining({
      role: "tool",
      name: "read_file",
      tool_call_id: "call_read_1",
      content: expect.stringMatching(/^\[revision sha256:[a-f0-9]{64}\]\n1\thello$/)
    }));
    expect(events[0]).toEqual({ kind: "turnPreparing", reason: "server" });
    const userMessageIndex = events.findIndex(event => event.kind === "userMessage");
    const workStartedIndex = events.findIndex(event => event.kind === "turnWorkStarted");
    const turnStartIndex = events.findIndex(event => event.kind === "turnStart");
    expect(workStartedIndex).toBeGreaterThan(userMessageIndex);
    expect(turnStartIndex).toBeGreaterThan(workStartedIndex);
    expect(events[workStartedIndex]).toEqual(expect.objectContaining({
      kind: "turnWorkStarted",
      messageId: (events[turnStartIndex] as Extract<UiEvent, { kind: "turnStart" }>).messageId,
      startedAt: expect.any(Number)
    }));
    const resolvedIndex = events.findIndex(event =>
      event.kind === "toolCallResolved" && event.status === "executed"
    );
    const answerIndex = events.findIndex(event => event.kind === "text");
    expect(events.slice(resolvedIndex + 1, answerIndex)).toContainEqual({ kind: "turnPreparing", reason: "server" });
  });

  it("applies mode changes made during a turn only to the next user message", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf8");
    mocks.settings.toolCallingMode = "native";
    const requests: Array<{
      thinking_budget_tokens?: number;
      reasoning_effort?: string;
      chat_template_kwargs?: Record<string, unknown>;
      tools?: Array<{ function: { name: string } }>;
    }> = [];
    let releaseFirstRequest = (): void => undefined;
    const firstRequestGate = new Promise<void>(resolve => { releaseFirstRequest = resolve; });
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: typeof requests[number]) {
      requests.push(request);
      if (requests.length === 1) {
        await firstRequestGate;
        yield { kind: "toolCall", name: "read_file", argsJson: '{"path":"a.txt"}', id: "call_read_modes" };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.reasoningEffort = "effort:high";
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: event => events.push(event)
    });

    const firstTurn = session.sendUserMessage("read it");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    session.setMode("plan");
    session.setReasoningEffort("none");
    releaseFirstRequest();
    await firstTurn;
    await session.sendUserMessage("now use the new modes");

    expect(requests).toHaveLength(3);
    for (const request of requests.slice(0, 2)) {
      expect(request.thinking_budget_tokens).toBe(16384);
      expect(request.reasoning_effort).toBe("high");
      expect(request.chat_template_kwargs).toBeUndefined();
      expect(request.tools?.some(tool => tool.function.name === "create_file")).toBe(true);
    }
    expect(requests[2].thinking_budget_tokens).toBe(0);
    expect(requests[2].reasoning_effort).toBeUndefined();
    expect(requests[2].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(requests[2].tools?.some(tool => tool.function.name === "create_file")).toBe(false);
    expect(record.messages.filter(message => message.role === "user").map(message => message.mode)).toEqual(["act", "plan"]);
    expect(events.filter(event => event.kind === "turnEnd").map(event => event.mode)).toEqual(["act", "plan"]);
  });

  it.each(["act", "plan", "review"] as const)("executes a submitted %s message independently of the composer mode", async mode => {
    mocks.settings.toolCallingMode = "native";
    const requests: Array<{ tools?: Array<{ function: { name: string } }> }> = [];
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: typeof requests[number]) {
      requests.push(request);
      yield { kind: "text", text: "Done" };
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.mode = mode === "act" ? "plan" : "act";
    const composerMode = record.mode;
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: event => events.push(event)
    });

    await session.sendUserMessage("Use my submitted mode", [], mode);
    expect(events).toContainEqual(expect.objectContaining({ kind: "turnEnd", mode, messageTs: expect.any(Number) }));

    expect(record.mode).toBe(mode === "plan" ? "plan" : composerMode);
    expect(record.messages[0]).toMatchObject({ role: "user", mode });
    expect(events).toContainEqual(expect.objectContaining({ kind: "userMessage", mode }));
    expect(requests[0].tools?.some(tool => tool.function.name === "create_file")).toBe(mode === "act");
    expect(requests[0].tools?.some(tool => tool.function.name === "run_command")).toBe(mode === "act");
  });

  it("retains plan approval after reload and keeps revisions in Plan until acceptance", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-plan-approval-"));
    mocks.settings.toolCallingMode = "native";
    const requests: Array<{ tools?: Array<{ function: { name: string } }> }> = [];
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: typeof requests[number]) {
      requests.push(request);
      yield { kind: "text", text: "A concrete plan or completed response." };
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const { ChatStorage } = await import("../src/chat/storage.js");
    const storage = new ChatStorage(ws, path.join(ws, "chats"));
    const record = storage.newRecord("native");
    let session = new ChatSession({ storage, workspaceRoot: ws, record, emit: () => undefined });
    try {
      await session.sendUserMessage("Plan it", [], "plan");
      await session.shutdown();
      const loaded = (await storage.load(record.id))!;
      const firstPlan = loaded.pendingPlanMessageTs!;
      expect(firstPlan).toBe(loaded.messages.at(-1)?.ts);
      expect(loaded.mode).toBe("plan");
      const events: UiEvent[] = [];
      session = new ChatSession({ storage, workspaceRoot: ws, record: loaded, emit: event => events.push(event) });
      session.setMode("review");
      expect(loaded.mode).toBe("plan");
      await session.sendUserMessage("Do not bypass approval", [], "act");
      expect(requests).toHaveLength(1);
      expect(session.resolvePlan(firstPlan - 1, "act")).toBe(false);
      expect(session.resolvePlan(firstPlan, "plan")).toBe(true);
      await session.sendUserMessage("Include validation", [], "plan");
      expect(loaded.pendingPlanMessageTs).toBe(loaded.messages.at(-1)?.ts);
      expect(loaded.mode).toBe("plan");
      expect(requests[1].tools?.some(tool => tool.function.name === "create_file" || tool.function.name === "run_command")).toBe(false);

      const revisedPlan = loaded.pendingPlanMessageTs!;
      expect(session.resolvePlan(revisedPlan, "act")).toBe(true);
      expect(session.resolvePlan(revisedPlan, "act")).toBe(false);
      await session.sendUserMessage("I accept your plan. Please implement.", [], "act");
      expect(loaded.mode).toBe("act");
      expect(loaded.pendingPlanMessageTs).toBeUndefined();
      expect(requests[2].tools?.some(tool => tool.function.name === "create_file")).toBe(true);
      expect(loaded.messages.filter(message => message.role === "user").map(message => message.mode)).toEqual(["plan", "plan", "act"]);
      expect(events).toContainEqual(expect.objectContaining({ kind: "userMessage", mode: "act", text: "I accept your plan. Please implement." }));
      expect((await storage.load(record.id))?.pendingPlanMessageTs).toBeUndefined();
    } finally {
      await session.shutdown();
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it.each(["pending", "incomplete"] as const)("persists cancellation of %s planning without accepting or implementing it", async outcome => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-cancel-plan-"));
    const { ChatSession } = await import("../src/chat/session.js");
    const { ChatStorage } = await import("../src/chat/storage.js");
    mocks.settings.toolCallingMode = "native";
    mocks.streamChat.mockImplementation(async function* () {
      if (outcome === "pending") yield { kind: "text", text: "The plan" };
    });
    const storage = new ChatStorage(ws, path.join(ws, "chats"));
    const record = storage.newRecord("native");
    const events: UiEvent[] = [];
    let session = new ChatSession({ storage, workspaceRoot: ws, record, emit: event => events.push(event) });
    try {
      await session.sendUserMessage("Plan this", [], "plan");
      await session.shutdown();
      const loaded = (await storage.load(record.id))!;
      session = new ChatSession({ storage, workspaceRoot: ws, record: loaded, emit: event => events.push(event) });
      expect(session.isPlanning()).toBe(true);
      if (outcome === "pending") {
        expect(await session.cancelPlanning(loaded.pendingPlanMessageTs! - 1)).toBe(false);
        expect(session.isPlanning()).toBe(true);
      }
      expect(await session.cancelPlanning(loaded.pendingPlanMessageTs)).toBe(true);
      expect(session.isPlanning()).toBe(false);
      expect(loaded.mode).toBe("act");
      expect(loaded.messages.filter(message => message.role === "user").map(message => message.content)).toEqual(["Plan this"]);
      expect(mocks.streamChat).toHaveBeenCalledOnce();
      expect(events).toContainEqual({ kind: "planningState", active: false, pendingPlanMessageTs: undefined });
      const saved = (await storage.load(record.id))!;
      expect(saved.pendingPlanMessageTs).toBeUndefined();
      expect(saved.planning).toBeUndefined();
      expect(await session.cancelPlanning()).toBe(false);
    } finally {
      await session.shutdown();
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it("persists successful file-creation metadata for restored tool labels", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    mocks.settings.toolCallingMode = "native";
    mocks.settings.autoapproveWrites = true;
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield {
          kind: "toolCall",
          name: "create_file",
          argsJson: '{"path":"new.txt","content":"hello\\n"}',
          id: "call_create_1"
        };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: () => undefined
    });

    await session.sendUserMessage("create it");

    const toolResult = record.messages.find(message => message.role === "tool");
    expect(toolResult?.toolCall).toEqual(expect.objectContaining({
      name: "create_file",
      status: "executed",
      createsNewFile: true
    }));
  });

  it.each([
    ["effort:low", "low"],
    ["effort:medium", "medium"],
    ["effort:high", "high"]
  ] as const)("sends configured %s reasoning effort independently of the budget", async (selection, effort) => {
    mocks.settings.toolCallingMode = "native";
    mocks.settings.reasoningBudget = 12345;
    let request: Record<string, unknown> | undefined;
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, value: Record<string, unknown>) {
      request = value;
      yield { kind: "text", text: "done" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.reasoningEffort = selection;
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: () => undefined
    });

    await session.sendUserMessage("answer briefly");

    expect(request).toMatchObject({
      model: "test-model",
      thinking_budget_tokens: 12345,
      reasoning_effort: effort
    });
  });

  it.each([
    ["none", { enable_thinking: false }],
    ["default", undefined]
  ] as const)("sends the universal %s reasoning selection", async (selection, templateArgs) => {
    mocks.settings.toolCallingMode = "native";
    let request: Record<string, unknown> | undefined;
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, value: Record<string, unknown>) {
      request = value;
      yield { kind: "text", text: "done" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.reasoningEffort = selection;
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: () => undefined
    });

    await session.sendUserMessage("answer briefly");

    expect(request).not.toHaveProperty("reasoning_effort");
    expect(request).toHaveProperty("thinking_budget_tokens", selection === "none" ? 0 : 16384);
    if (templateArgs) expect(request).toHaveProperty("chat_template_kwargs", templateArgs);
    else expect(request).not.toHaveProperty("chat_template_kwargs");
  });

  it("sends an unlimited budget when the setting is empty", async () => {
    mocks.settings.reasoningBudget = null;
    const { ChatSession } = await import("../src/chat/session.js");
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: () => undefined
    });

    await session.sendUserMessage("answer briefly");

    expect(mocks.streamChat).toHaveBeenCalledWith(
      mocks.settings.endpoint,
      expect.objectContaining({ thinking_budget_tokens: -1 }),
      expect.anything()
    );
  });

  it("warns when the server still emits reasoning with Activate Reasoning off", async () => {
    mocks.settings.toolCallingMode = "native";
    mocks.streamChat.mockImplementation(async function* () {
      yield { kind: "thought", text: "unexpected reasoning" };
      yield { kind: "text", text: "done" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.reasoningEffort = "none";
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: event => events.push(event)
    });

    await session.sendUserMessage("answer instantly");

    expect(events).toContainEqual(expect.objectContaining({
      kind: "notice",
      text: expect.stringContaining("fixed server value overrides per-request budgets")
    }));
  });

  it("folds compacted context into the initial native system message", async () => {
    mocks.settings.toolCallingMode = "native";
    const requests: Array<Record<string, unknown>> = [];
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: Record<string, unknown>) {
      requests.push(request);
      yield { kind: "text", text: "continuing" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.messages.push(
      { role: "system", content: "[context summary]\nGOAL: refactor Game.tsx", ts: Date.now() },
      { role: "assistant", content: "I will create the refactored file.", ts: Date.now() }
    );
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: () => undefined
    });

    await session.sendUserMessage("please continue");

    const messages = requests[0].messages as Array<{ role: string; content: string }>;
    expect(messages.filter(message => message.role === "system")).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({
      role: "system",
      content: expect.stringContaining("[context summary]\nGOAL: refactor Game.tsx")
    }));
    expect(messages).toContainEqual(expect.objectContaining({ role: "user", content: "please continue" }));
  });

  it("adds a user turn when a compacted native tail contains only tool history", async () => {
    mocks.settings.toolCallingMode = "native";
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.messages.push(
      { role: "system", content: "[context summary]\nGOAL: finish the refactor", ts: 1 },
      {
        role: "tool",
        content: "tests passed",
        toolCall: { id: "call_test_1", name: "run_command", argsJson: '{"command":"npm test"}' },
        ts: 2
      }
    );
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: () => undefined
    });

    const messages = await (session as unknown as {
      buildNativePromptMessages(systemPrompt: string): Promise<Array<{ role: string; content: string }>>;
    }).buildNativePromptMessages("system prompt");

    expect(messages.map(message => message.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(messages[1].content).toBe("Continue the task described in the conversation context above.");
    expect(messages[0].content).toContain("[context summary]\nGOAL: finish the refactor");
  });

  it.each(["native", "legacy"] as const)("uses the latest saved user time only in %s system context after compaction", async toolProtocol => {
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const firstTs = Date.parse("2026-09-01T12:00:00Z");
    const latestTs = Date.parse("2026-09-11T13:45:00Z");
    const answerTs = Date.parse("2026-09-11T13:46:00Z");
    record.messages = [
      { role: "user", content: "earlier request", ts: firstTs },
      { role: "user", content: "current request", ts: latestTs },
      { role: "assistant", content: "answer", ts: answerTs }
    ];
    record.contextMessages = [{ role: "system", content: "[context summary] current task", ts: answerTs }];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace", record, emit: () => undefined
    });
    const internal = session as unknown as {
      toolProtocol: "native" | "legacy";
      buildPromptMessages(): Promise<Array<{ role: string; content: string }>>;
      systemPromptTokens(settings: unknown): Promise<number>;
    };
    internal.toolProtocol = toolProtocol;
    const messages = await internal.buildPromptMessages();
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain(`Latest user prompt time: ${new Date(latestTs).toISOString()}`);
    expect(messages[0].content).toContain("only to contextualize the current request relative to workspace memories");
    expect(JSON.stringify(messages)).not.toContain(new Date(answerTs).toISOString());
    expect(JSON.stringify(messages)).not.toContain(new Date(firstTs).toISOString());
    expect(JSON.stringify(messages.slice(1))).not.toContain(new Date(latestTs).toISOString());
    await internal.systemPromptTokens(mocks.settings);
    expect(mocks.tokenize.mock.calls.some(call => String(call[1]).includes(new Date(latestTs).toISOString()))).toBe(true);

    // Advancing the transcript to a new user request updates the reference time.
    record.messages.push({ role: "user", content: "next request", ts: latestTs + 86400000 });
    const next = await internal.buildPromptMessages();
    expect(next[0].content).toContain(new Date(latestTs + 86400000).toISOString());
    expect(next[0].content).not.toContain(new Date(latestTs).toISOString());
  });

  it("sends the saved answer timestamp to the UI at turn end", async () => {
    mocks.streamChat.mockImplementation(async function* () { yield { kind: "text", text: "done" }; });
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace", record, emit: event => events.push(event)
    });
    await session.sendUserMessage("hello");
    const answer = record.messages.find(message => message.role === "assistant");
    expect(answer).toBeDefined();
    expect(events).toContainEqual(expect.objectContaining({ kind: "turnEnd", messageTs: answer!.ts }));
  });

  it("falls back to legacy syntax only after an explicit native-tools rejection", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf8");
    mocks.settings.toolCallingMode = "compat-gemma4";
    const requests: Array<Record<string, unknown>> = [];
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: Record<string, unknown>) {
      requests.push(request);
      if (pass++ === 0) throw new mocks.NativeToolsUnsupportedError("tools param requires --jinja flag");
      if (pass === 2) yield { kind: "text", text: gemmaCall("read_file", 'path:<|"|>a.txt<|"|>') };
      else yield { kind: "text", text: "done" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record: newRecord(),
      emit: event => events.push(event)
    });
    await session.sendUserMessage("read it");

    expect(requests[0].tools).toBeDefined();
    expect(requests[1].tools).toBeUndefined();
    expect(events.some(event => event.kind === "notice" && event.text.includes("legacy adapter"))).toBe(true);
    expect(events.some(event => event.kind === "toolCallResolved" && event.status === "executed")).toBe(true);
  });

  it("keeps GPT-OSS on structured native calls when the server supports them", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf8");
    mocks.settings.toolCallingMode = "compat-gpt-oss";
    const requests: Array<Record<string, unknown>> = [];
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: Record<string, unknown>) {
      requests.push(request);
      if (pass++ === 0) {
        yield { kind: "toolCall", name: "read_file", argsJson: '{"path":"a.txt"}', id: "call_gpt_oss" } as const;
      } else {
        yield { kind: "text", text: "done" } as const;
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const record = newRecord();
    record.toolCallingMode = "compat-gpt-oss";
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: event => events.push(event)
    });
    await session.sendUserMessage("read it");

    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.tools !== undefined)).toBe(true);
    expect(events.some(event => event.kind === "notice" && event.text.includes("legacy adapter"))).toBe(false);
    expect(events.some(event => event.kind === "toolCallResolved" && event.status === "executed")).toBe(true);
  });

  it("recovers leaked GPT-OSS Harmony calls without leaving native transport", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf8");
    mocks.settings.toolCallingMode = "compat-gpt-oss";
    const requests: Array<Record<string, unknown>> = [];
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: Record<string, unknown>) {
      requests.push(request);
      if (pass++ === 0) {
        yield {
          kind: "text",
          text: "<|channel|>analysis<|message|>I need the file.<|end|>" +
            '<|start|>assistant<|channel|>commentary to=functions.read_file<|constrain|>json<|message|>{"path":"a.txt"}<|call|>'
        } as const;
      } else {
        yield { kind: "text", text: "done" } as const;
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const record = newRecord();
    record.toolCallingMode = "compat-gpt-oss";
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: event => events.push(event)
    });
    await session.sendUserMessage("read it");

    expect(requests.every(request => request.tools !== undefined)).toBe(true);
    expect(events.some(event => event.kind === "thought" && event.delta.includes("I need the file"))).toBe(true);
    expect(events.some(event => event.kind === "toolCallResolved" && event.status === "executed")).toBe(true);
    expect(events.some(event => event.kind === "notice" && event.text.includes("legacy adapter"))).toBe(false);
  });

  it("uses the GPT-OSS Harmony fallback only after native tools are rejected", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf8");
    mocks.settings.toolCallingMode = "compat-gpt-oss";
    const requests: Array<Record<string, unknown>> = [];
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: Record<string, unknown>) {
      requests.push(request);
      if (pass++ === 0) throw new mocks.NativeToolsUnsupportedError("tools param requires --jinja flag");
      if (pass === 2) {
        yield {
          kind: "text",
          text: '<|channel|>commentary to=functions.read_file<|constrain|>json<|message|>{"path":"a.txt"}<|call|>'
        } as const;
      } else {
        yield { kind: "text", text: "done" } as const;
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const record = newRecord();
    record.toolCallingMode = "compat-gpt-oss";
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: event => events.push(event)
    });
    await session.sendUserMessage("read it");

    expect(requests[0].tools).toBeDefined();
    expect(requests.slice(1).every(request => request.tools === undefined)).toBe(true);
    expect(events.some(event => event.kind === "notice" && event.text.includes("GPT-OSS legacy adapter"))).toBe(true);
    expect(events.some(event => event.kind === "toolCallResolved" && event.status === "executed")).toBe(true);
  });

  it("recovers Muse reasoning and ATEM calls in Muse compatibility mode", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf8");
    mocks.settings.toolCallingMode = "compat-muse-glimmer";
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield {
          kind: "text",
          text: `to=self<|message|>I should read it.<|eom|><|start|>assistant to=read_file<|message|>` +
            `<atem:function_calls><atem:invoke name="read_file">` +
            `<atem:parameter name="path">a.txt</atem:parameter>` +
            `</atem:invoke></atem:function_calls><|eot|>`
        };
      } else {
        yield { kind: "text", text: "to=self<|message|>I have it.<|eom|><|start|>assistant to=user<|message|>done<|eot|>" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: event => events.push(event)
    });
    await session.sendUserMessage("read it");

    expect(record.messages.find(message => message.role === "tool")?.content).toContain("hello");
    expect(events.some(event => event.kind === "thought" && event.delta.includes("I should read it"))).toBe(true);
    expect(events.some(event => event.kind === "text" && event.delta === "done")).toBe(true);
    expect(events.some(event => event.kind === "text" && event.delta.includes("<|"))).toBe(false);
  });

  it("requires a native tool-aware server for Muse compatibility", async () => {
    mocks.settings.toolCallingMode = "compat-muse-glimmer";
    mocks.streamChat.mockImplementation(async function* () {
      if (Math.random() >= 0) throw new mocks.NativeToolsUnsupportedError("tools unsupported");
      yield { kind: "text", text: "unreachable" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: event => events.push(event)
    });
    await session.sendUserMessage("inspect it");

    const abort = events.find((event): event is Extract<UiEvent, { kind: "abort" }> => event.kind === "abort");
    expect(abort?.reason).toContain("b10353");
    expect(abort?.reason).toContain("--jinja");
    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
  });

  it("sends persistent image attachments as native typed content", async () => {
    mocks.settings.toolCallingMode = "compat-muse-glimmer";
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: { messages: Array<{ role: string; content: unknown }> }) {
      requests.push(request);
      yield { kind: "text", text: "A screenshot." } as const;
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const attachment = {
      id: "123e4567-e89b-42d3-a456-426614174099",
      fileName: "screen.png",
      mimeType: "image/png" as const,
      byteLength: 11,
      extension: "png" as const
    };
    const secondAttachment = {
      id: "123e4567-e89b-42d3-a456-426614174096",
      fileName: "detail.jpg",
      mimeType: "image/jpeg" as const,
      byteLength: 6,
      extension: "jpg" as const
    };
    const storage = {
      save: vi.fn(async () => undefined),
      attachmentDataUrl: vi.fn(async (_chatId: string, item: typeof attachment | typeof secondAttachment) =>
        item.id === attachment.id ? "data:image/png;base64,iVBORw0KGgoBAgM=" : "data:image/jpeg;base64,/9j/AA==")
    };
    const session = new ChatSession({ storage: storage as never, workspaceRoot: "/tmp/workspace", record, emit: () => undefined });

    await session.sendUserMessage("Describe them", [attachment, secondAttachment]);

    expect(record.messages[0]).toMatchObject({ content: "Describe them", attachments: [attachment, secondAttachment] });
    const user = requests[0].messages.find(message => message.role === "user");
    expect(user?.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoBAgM=" } },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/AA==" } },
      { type: "text", text: expect.stringContaining("Describe them\n\nAttached images") }
    ]);
    expect(JSON.stringify(record)).not.toContain("iVBORw0KGgo");
  });

  it.each(["native", "compat-qwen3"] as const)("synthesizes text attachments for %s and preserves the visible transcript on reload", async profile => {
    mocks.settings.toolCallingMode = profile;
    const requests: Array<{ messages: Array<{ role: string; content: unknown }>; tools?: unknown[] }> = [];
    mocks.streamChat.mockImplementation(async function* (_endpoint, request) {
      requests.push(request);
      if (profile !== "native" && request.tools) throw new mocks.NativeToolsUnsupportedError("tools param requires --jinja flag");
      yield { kind: "text", text: "Done." };
    });
    const { ChatStorage } = await import("../src/chat/storage.js");
    const { ChatSession } = await import("../src/chat/session.js");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "locality-text-attachments-"));
    try {
      const storage = new ChatStorage(dir, path.join(dir, "chats"));
      const record = storage.newRecord(profile);
      const code = await storage.importAttachmentBytes(record.id, "main.py", Buffer.from("print('CODE_SENTINEL')\n"));
      const paste = await storage.importAttachmentBytes(record.id, "Pasted text", Buffer.from("PASTE_SENTINEL"));
      let session = new ChatSession({ storage, workspaceRoot: dir, record, emit: () => undefined });
      await session.sendUserMessage(`Explain these ${profile}`, [code, paste]);
      const user = requests.at(-1)!.messages.find(m => m.role === "user")!;
      expect(typeof user.content).toBe("string");
      expect(user.content).toContain('"file_type": "py"');
      const files = JSON.parse(String(user.content).slice(String(user.content).indexOf("[")));
      expect(files).toEqual([
        { name: "main.py", type: "text", file_type: "py", contents: "print('CODE_SENTINEL')\n" },
        { name: "Pasted text", type: "text", contents: "PASTE_SENTINEL" }
      ]);
      expect(record.messages[0].content).toBe(`Explain these ${profile}`);
      expect(record.messages[0].attachments).toHaveLength(2);
      expect(record.contextMessages![0].attachments).toBeUndefined();
      expect(record.contextMessages![0].tokens).toBe(1);
      expect(mocks.tokenize.mock.calls.some(call => String(call[1]).includes("CODE_SENTINEL"))).toBe(true);
      const loaded = (await storage.load(record.id))!;
      session = new ChatSession({ storage, workspaceRoot: dir, record: loaded, emit: () => undefined });
      await session.sendUserMessage("Continue");
      expect(JSON.stringify(requests.at(-1)!.messages).match(/CODE_SENTINEL/g)).toHaveLength(1);
      await session.editUserMessage(loaded.messages[0].ts, "No files", [code.id, paste.id]);
      expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain("CODE_SENTINEL");
      expect(loaded.messages[0].attachments).toBeUndefined();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("combines text and image files in native content without turning text into an image", async () => {
    const { ChatStorage } = await import("../src/chat/storage.js");
    const { ChatSession } = await import("../src/chat/session.js");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "locality-mixed-attachments-"));
    mocks.streamChat.mockImplementation(async function* () { yield { kind: "text", text: "Done." }; });
    try {
      const storage = new ChatStorage(dir, path.join(dir, "chats"));
      const record = storage.newRecord("native");
      const text = await storage.importAttachmentBytes(record.id, "Pasted text", Buffer.from("MIXED_SENTINEL"));
      const image = await storage.importAttachmentBytes(record.id, "screen.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
      const session = new ChatSession({ storage, workspaceRoot: dir, record, emit: () => undefined });
      await session.sendUserMessage("Compare", [text, image]);
      const user = mocks.streamChat.mock.calls[0][1].messages.find((m: { role: string }) => m.role === "user");
      expect(user.content.filter((part: { type: string }) => part.type === "image_url")).toHaveLength(1);
      expect(user.content.find((part: { type: string }) => part.type === "text").text).toContain("MIXED_SENTINEL");
      expect(user.content.find((part: { type: string }) => part.type === "text").text).toContain('"file_type":"png"');
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("counts attachment contents before sending and preserves files when context is too small", async () => {
    const { ChatStorage } = await import("../src/chat/storage.js");
    const { ChatSession } = await import("../src/chat/session.js");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "locality-attachment-budget-"));
    mocks.fetchServerContextSize.mockResolvedValue(8192);
    mocks.tokenize.mockImplementation(async (_endpoint, text) => text.includes("OVERFLOW_ATTACHMENT") ? 9000 : 1);
    try {
      const storage = new ChatStorage(dir, path.join(dir, "chats"));
      const record = storage.newRecord("native");
      const attachment = await storage.importAttachmentBytes(record.id, "large.txt", Buffer.from("OVERFLOW_ATTACHMENT"));
      const events: UiEvent[] = [];
      const session = new ChatSession({ storage, workspaceRoot: dir, record, emit: event => events.push(event) });
      await session.sendUserMessage("Read this", [attachment]);
      expect(mocks.streamChat).not.toHaveBeenCalled();
      expect(events.some(event => event.kind === "abort")).toBe(true);
      expect(record.messages[0].content).toBe("Read this");
      await expect(storage.attachmentText(record.id, attachment)).resolves.toBe("OVERFLOW_ATTACHMENT");
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("shows Muse projector guidance when llama.cpp rejects image input", async () => {
    mocks.settings.toolCallingMode = "compat-muse-glimmer";
    mocks.streamChat.mockImplementation(async function* () {
      if (Math.random() >= 0) throw new mocks.VisionUnsupportedError("image input is not supported");
      yield { kind: "text", text: "unreachable" } as const;
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const attachment = {
      id: "123e4567-e89b-42d3-a456-426614174098",
      fileName: "screen.png",
      mimeType: "image/png" as const,
      byteLength: 11,
      extension: "png" as const
    };
    const storage = {
      save: vi.fn(async () => undefined),
      attachmentDataUrl: vi.fn(async () => "data:image/png;base64,AA==")
    };
    const session = new ChatSession({ storage: storage as never, workspaceRoot: "/tmp/workspace", record, emit: event => events.push(event) });

    await session.sendUserMessage("", [attachment]);

    expect(events).toContainEqual(expect.objectContaining({
      kind: "abort",
      reason: expect.stringContaining("mmproj-Muse-Glimmer-30B-Q4_K_M.gguf")
    }));
  });

  it("does not flatten image attachments into a legacy fallback prompt", async () => {
    mocks.settings.toolCallingMode = "compat-gemma4";
    mocks.streamChat.mockImplementation(async function* () {
      if (Math.random() >= 0) throw new mocks.NativeToolsUnsupportedError("tools param requires --jinja flag");
      yield { kind: "text", text: "unreachable" } as const;
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const attachment = {
      id: "123e4567-e89b-42d3-a456-426614174097",
      fileName: "screen.png",
      mimeType: "image/png" as const,
      byteLength: 11,
      extension: "png" as const
    };
    const storage = {
      save: vi.fn(async () => undefined),
      attachmentDataUrl: vi.fn(async () => "data:image/png;base64,AA==")
    };
    const session = new ChatSession({ storage: storage as never, workspaceRoot: "/tmp/workspace", record, emit: event => events.push(event) });

    await session.sendUserMessage("inspect", [attachment]);

    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "abort",
      reason: expect.stringContaining("legacy tool adapter")
    }));
  });

  it("rejects leaked protocol framing in strict native mode", async () => {
    mocks.settings.toolCallingMode = "native";
    mocks.streamChat.mockImplementation(async function* () {
      yield { kind: "text", text: "to=self<|message|>raw reasoning<|eom|>" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: event => events.push(event)
    });
    await session.sendUserMessage("hello");

    expect(events.some(event => event.kind === "abort" && event.reason.includes("Native server only"))).toBe(true);
    expect(events.some(event => event.kind === "thought" || event.kind === "toolCallProposed")).toBe(false);
  });

  it("does not recover another family's leaked syntax", async () => {
    mocks.settings.toolCallingMode = "compat-gemma4";
    mocks.streamChat.mockImplementation(async function* () {
      yield { kind: "text", text: `<tool_call><function=read_file><parameter=path>secret.txt</parameter></function></tool_call>` };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: event => events.push(event)
    });
    await session.sendUserMessage("show it");

    expect(events.some(event => event.kind === "toolCallProposed")).toBe(false);
    expect(events.some(event => event.kind === "text" && event.delta.includes("<function=read_file>"))).toBe(true);
  });

  it("sanitizes legacy argument text before replaying it through native tool calls", async () => {
    mocks.settings.toolCallingMode = "native";
    const requests: Array<Record<string, unknown>> = [];
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: Record<string, unknown>) {
      requests.push(request);
      yield { kind: "text", text: "done" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.messages.push(
      { role: "user", content: "old request", ts: 1 },
      {
        role: "tool",
        content: "error: malformed legacy call",
        toolCall: { id: "old_bad", name: "read_file", argsJson: '{"path":"cut-off' },
        ts: 2
      },
      {
        role: "tool",
        content: "old result",
        toolCall: { id: "old_wrapped", name: "list_dir", argsJson: '"{\\"path\\":\\"src\\"}"' },
        ts: 3
      }
    );
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: () => undefined
    });
    await session.sendUserMessage("continue");

    const assistant = (requests[0].messages as Array<Record<string, unknown>>)
      .find(message => Array.isArray(message.tool_calls));
    const calls = assistant?.tool_calls as Array<{ function: { arguments: string } }>;
    expect(calls[0].function.arguments).toBe("{}");
    expect(calls[1].function.arguments).toBe('{"path":"src"}');
  });

  it("retries one server-side native argument parse failure without falling back to legacy", async () => {
    mocks.settings.toolCallingMode = "native";
    const requests: Array<Record<string, unknown>> = [];
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: Record<string, unknown>) {
      requests.push(request);
      if (pass++ === 0) {
        throw new mocks.MalformedNativeToolCallError("Failed to parse tool call arguments as JSON");
      }
      yield { kind: "text", text: "recovered" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: event => events.push(event)
    });
    await session.sendUserMessage("continue");

    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.tools !== undefined)).toBe(true);
    const retryMessages = requests[1].messages as Array<{ role: string; content: string }>;
    expect(retryMessages.at(-1)?.content).toContain("valid JSON object");
    expect(events.some(event => event.kind === "notice" && event.text.includes("malformed native tool arguments"))).toBe(true);
    expect(events.some(event => event.kind === "abort")).toBe(false);
  });

  it("never executes tool-looking assistant text in native mode", async () => {
    mocks.settings.toolCallingMode = "native";
    mocks.streamChat.mockImplementation(async function* () {
      yield { kind: "text", text: '<tool_call>{"name":"read_file","arguments":{"path":"secret.txt"}}</tool_call>' };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: event => events.push(event)
    });
    await session.sendUserMessage("show text");

    expect(record.messages.some(message => message.role === "tool")).toBe(false);
    expect(events.filter(event => event.kind === "toolCallProposed")).toHaveLength(0);
    expect(events.some(event => event.kind === "abort" && event.reason.includes("Native server only"))).toBe(true);
  });

  it("recovers Qwen3-Coder function XML leaked through native content", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.mkdir(path.join(ws, "src"));
    mocks.settings.toolCallingMode = "compat-qwen3";
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield { kind: "text", text: "Looking now. <tool_ca" };
        yield { kind: "text", text: "ll><function=list_dir><parameter=path>src</parameter></function></tool_call>" };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: event => events.push(event)
    });
    await session.sendUserMessage("inspect src");

    expect(events).toContainEqual(expect.objectContaining({
      kind: "toolCallProposed",
      toolName: "list_dir"
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "toolCallResolved",
      status: "executed"
    }));
    expect(record.messages.some(message =>
      message.role === "tool" &&
      message.toolCall?.name === "list_dir" &&
      message.toolCall.status === "executed"
    )).toBe(true);
    expect(record.messages.at(-1)?.content).toBe("done");
  });

  it.each([
    { description: "suggested answer", answer: "Review all files" },
    { description: "long custom answer", answer: `Review these files:\n${'Keep "all" details.  '.repeat(40)}\nFinal detail.` }
  ])("preserves the $description and recovers native function XML after a question in Qwen mode", async ({ answer }) => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.mkdir(path.join(ws, "src"));
    mocks.settings.toolCallingMode = "compat-qwen3";
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield {
          kind: "toolCall",
          name: "ask_user_question",
          argsJson: JSON.stringify({
            question: "What should I review?",
            suggestions: ["Review src", "Review all files"]
          }),
          id: "call_question"
        };
      } else if (pass === 2) {
        yield {
          kind: "thought",
          text: "Exploring now.\n<tool_call><function=list_dir> <parameter=path> . </parameter> </function> </tool_call>"
        };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: event => events.push(event)
    });
    const turn = session.sendUserMessage("ask me first");
    await vi.waitFor(() => {
      expect(events.some(event => event.kind === "toolCallProposed" && event.toolName === "ask_user_question")).toBe(true);
    });
    const question = events.find(
      (event): event is Extract<UiEvent, { kind: "toolCallProposed" }> =>
        event.kind === "toolCallProposed" && event.toolName === "ask_user_question"
    );
    expect(question).toBeDefined();
    session.answerQuestion(question!.toolId, answer);
    await turn;

    const result = `the user has answered your question: "${answer}"`;
    expect(events).toContainEqual(expect.objectContaining({
      kind: "toolCallResolved", toolId: question!.toolId, status: "executed", resultPreview: result
    }));
    expect(record.messages.find(message => message.toolCall?.name === "ask_user_question")?.content).toBe(result);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "toolCallProposed",
      toolName: "list_dir"
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "toolCallResolved",
      status: "executed"
    }));
    expect(record.messages.some(message => message.role === "tool" && message.toolCall?.name === "list_dir")).toBe(true);
    expect(record.messages.at(-1)?.content).toBe("done");
    expect(events.some(event => event.kind === "thought" && event.delta.includes("Exploring now."))).toBe(true);
    expect(events.some(event => event.kind === "thought" && event.delta.includes("<tool_call>"))).toBe(false);
  });

  it.each(["act", "plan"] as const)("continues in %s mode after skipping a question without supplying an answer", async mode => {
    mocks.settings.toolCallingMode = "native";
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint, request, signal) {
      if (pass++ === 0) {
        yield {
          kind: "toolCall", name: "ask_user_question", id: "call_question",
          argsJson: JSON.stringify({ question: "Which scope?", suggestions: ["Source files", "All files"] })
        };
      } else {
        expect(signal.aborted).toBe(false);
        expect(request.messages.at(-1)).toMatchObject({
          role: "tool", tool_call_id: "call_question", content: "The user skipped this question"
        });
        yield { kind: "text", text: "Continuing with the available information." };
      }
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const save = vi.fn(async () => undefined);
    const session = new ChatSession({
      storage: { save } as never, workspaceRoot: "/tmp/workspace", record,
      emit: event => events.push(event)
    });
    try {
      const turn = session.sendUserMessage("Review the project", [], mode);
      await vi.waitFor(() => expect(events.some(event =>
        event.kind === "toolCallProposed" && event.toolName === "ask_user_question"
      )).toBe(true));
      const question = events.find((event): event is Extract<UiEvent, { kind: "toolCallProposed" }> =>
        event.kind === "toolCallProposed" && event.toolName === "ask_user_question"
      )!;
      session.skipQuestion("stale-question-id");
      expect(mocks.streamChat).toHaveBeenCalledOnce();
      session.skipQuestion(question.toolId);
      session.skipQuestion(question.toolId);
      session.answerQuestion(question.toolId, "All files");
      await turn;

      expect(mocks.streamChat).toHaveBeenCalledTimes(2);
      expect(events).toContainEqual(expect.objectContaining({
        kind: "toolCallResolved", toolId: question.toolId, status: "executed",
        resultPreview: "The user skipped this question"
      }));
      expect(record.messages.filter(message => message.role === "tool")).toEqual([
        expect.objectContaining({ content: "The user skipped this question", toolCall: expect.objectContaining({ status: "executed" }) })
      ]);
      expect(record.messages.filter(message => message.role === "user")).toHaveLength(1);
      expect(record.messages.at(-1)?.content).toBe("Continuing with the available information.");
      expect(record.mode).toBe(mode);
      expect(session.isPlanning()).toBe(mode === "plan");
      expect(events.some(event => event.kind === "abort")).toBe(false);
      expect(save).toHaveBeenCalledWith(record);
    } finally {
      await session.shutdown();
    }
  });

  it("still stops the turn when a pending question is cancelled", async () => {
    mocks.settings.toolCallingMode = "native";
    mocks.streamChat.mockImplementation(async function* () {
      yield {
        kind: "toolCall", name: "ask_user_question", id: "call_question",
        argsJson: JSON.stringify({ question: "Which scope?", suggestions: ["Source files", "All files"] })
      };
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace", record, emit: event => events.push(event)
    });
    try {
      const turn = session.sendUserMessage("Review the project");
      await vi.waitFor(() => expect(events.some(event =>
        event.kind === "toolCallProposed" && event.toolName === "ask_user_question"
      )).toBe(true));
      session.cancel();
      await turn;
      expect(mocks.streamChat).toHaveBeenCalledOnce();
      expect(record.messages.find(message => message.role === "tool")).toMatchObject({
        content: "[ask_user_question dismissed] The user did not answer the question.",
        toolCall: { status: "rejected" }
      });
    } finally {
      await session.shutdown();
    }
  });

  it("strictly validates native arguments instead of applying legacy aliases", async () => {
    mocks.settings.toolCallingMode = "native";
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield { kind: "toolCall", name: "read_file", argsJson: '{"file_path":"a.txt"}', id: "call_bad_args" };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: event => events.push(event)
    });
    await session.sendUserMessage("read");

    expect(events.some(event => event.kind === "toolCallResolved" && event.status === "failed")).toBe(true);
    const failedResult = record.messages.find(message => message.role === "tool");
    expect(failedResult?.content).toContain("arguments.path is required");
    expect(failedResult?.toolCall?.status).toBe("failed");
  });

  it("does not execute the same structured call id twice", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf8");
    mocks.settings.toolCallingMode = "native";
    mocks.streamChat.mockImplementation(async function* () {
      yield { kind: "toolCall", name: "read_file", argsJson: '{"path":"a.txt"}', id: "duplicate_id" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: event => events.push(event)
    });
    await session.sendUserMessage("read");

    expect(record.messages.filter(message => message.role === "tool")).toHaveLength(1);
    expect(events.some(event => event.kind === "abort" && event.reason.includes("Duplicate tool call id"))).toBe(true);
  });

  it("passes native multiline commands unchanged to the shell runner", async () => {
    const command = "cat <<'TEXT'\nfirst line\nsecond line\nTEXT\nprintf 'done\\n'";
    mocks.settings.toolCallingMode = "native";
    mocks.settings.autoapproveCommands = true;
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield { kind: "toolCall", name: "run_command", argsJson: JSON.stringify({ command }), id: "call_command_1" };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: event => events.push(event)
    });
    await session.sendUserMessage("test");

    expect(mocks.runCommand).toHaveBeenCalledWith(
      command,
      "/tmp/workspace",
      expect.any(AbortSignal),
      expect.any(Function)
    );
    expect(events).toContainEqual(expect.objectContaining({
      kind: "toolCallProposed",
      category: "command",
      processCommand: command,
      approvalRequired: false
    }));
  });

  it("rejects the removed run_process tool and reports run_command as available", async () => {
    mocks.settings.toolCallingMode = "native";
    mocks.settings.autoapproveCommands = true;
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) yield { kind: "toolCall", name: "run_process", argsJson: '{"program":"npm","args":["test"]}', id: "removed_process" };
      else yield { kind: "text", text: "done" };
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const session = new ChatSession({ storage: { save: vi.fn() } as never, workspaceRoot: "/tmp/workspace", record, emit: vi.fn() });
    await session.sendUserMessage("Run tests");
    expect(mocks.startCommand).not.toHaveBeenCalled();
    const result = record.messages.find(message => message.role === "tool");
    expect(result?.content).toContain('Unknown tool "run_process"');
    expect(result?.content).toMatch(/Available tools: .*run_command/);
  });

  it.each([{}, { command: 123 }, { command: " \n" }, { command: "echo a\0b" }])("rejects invalid native command arguments without launching: %j", async args => {
    mocks.settings.toolCallingMode = "native";
    mocks.settings.autoapproveCommands = true;
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) yield { kind: "toolCall", name: "run_command", argsJson: JSON.stringify(args), id: "invalid_command" };
      else yield { kind: "text", text: "done" };
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const session = new ChatSession({ storage: { save: vi.fn() } as never, workspaceRoot: "/tmp/workspace", record, emit: vi.fn() });
    await session.sendUserMessage("Run the command");
    expect(mocks.startCommand).not.toHaveBeenCalled();
    expect(record.messages.find(message => message.role === "tool")?.toolCall?.status).toBe("failed");
  });

  it.each([0, 1, 127, "runner-error"])("separates command outcome %s from tool status and persists display data", async outcome => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-command-history-"));
    try {
      mocks.settings.toolCallingMode = "native";
      mocks.settings.autoapproveCommands = true;
      if (outcome === "runner-error") mocks.runCommand.mockRejectedValue(new Error("runner unavailable"));
      else mocks.runCommand.mockResolvedValue({ exitCode: outcome, stdout: "out\n", stderr: "err\n", output: "err\nout\n", truncated: false });
      let pass = 0;
      mocks.streamChat.mockImplementation(async function* () {
        if (pass++ === 0) yield { kind: "toolCall", name: "run_command", argsJson: '{"command":"npm test"}', id: "command_outcome" };
        else yield { kind: "text", text: "done" };
      });
      const { ChatStorage } = await import("../src/chat/storage.js");
      const { ChatSession } = await import("../src/chat/session.js");
      const storage = new ChatStorage(ws, path.join(ws, "chats"));
      const record = storage.newRecord("native");
      const events: UiEvent[] = [];
      const session = new ChatSession({ storage, workspaceRoot: ws, record, emit: event => events.push(event) });
      await session.sendUserMessage("Run the command");
      await session.shutdown();
      const reloaded = await storage.load(record.id);
      const message = reloaded?.messages.find(item => item.toolCall?.id === "command_outcome");
      const status = outcome === "runner-error" ? "failed" : "executed";
      expect(message?.toolCall?.status).toBe(status);
      expect(events).toContainEqual(expect.objectContaining({ kind: "toolCallResolved", status }));
      if (outcome === "runner-error") {
        expect(message?.content).toContain("runner unavailable");
        expect(message?.toolCall?.processExitCode).toBeUndefined();
      } else {
        expect(message?.toolCall).toMatchObject({ processOutput: "err\nout\n", processExitCode: outcome });
        expect(message?.content).toBe(`exit ${outcome}\n--- stdout ---\nout\n\n--- stderr ---\nerr\n`);
      }
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it.each(["native", "legacy"])("shows the command when checking a long-running command in %s mode", async transport => {
    const legacy = transport === "legacy";
    mocks.settings.toolCallingMode = legacy ? "compat-qwen3" : "native";
    mocks.settings.autoapproveCommands = true;
    const finalResult = { exitCode: 0, stdout: "started\ndone\n", stderr: "", output: "started\ndone\n", truncated: false };
    let output = { stdout: "started\n", stderr: "", output: "started\n", truncated: false };
    let resolveResult = (_value: typeof finalResult): void => undefined;
    const result = new Promise<typeof finalResult>(resolve => { resolveResult = resolve; });
    let waits = 0;
    mocks.startCommand.mockReturnValue({
      result,
      snapshot: () => output,
      wait: vi.fn(async () => {
        if (waits++ === 0) return { running: true as const, output };
        output = finalResult;
        resolveResult(finalResult);
        return { running: false as const, result: finalResult };
      }),
      stop: vi.fn(async () => finalResult)
    });

    const events: UiEvent[] = [];
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint, request) {
      if (legacy && request.tools) throw new mocks.NativeToolsUnsupportedError("tools unsupported");
      if (pass++ === 0) {
        if (legacy) yield { kind: "text", text: '<tool_call>{"name":"run_command","arguments":{"command":"npm test"}}</tool_call>' };
        else yield { kind: "toolCall", name: "run_command", argsJson: '{"command":"npm test"}', id: "call_job_start" };
      } else if (pass === 2) {
        const started = events.find(
          (event): event is Extract<UiEvent, { kind: "toolCallResolved" }> =>
            event.kind === "toolCallResolved" && event.processRunning === true
        );
        const args = { job_id: started?.processJobId, wait_ms: 100 };
        if (legacy) yield { kind: "text", text: `<tool_call>${JSON.stringify({ name: "wait_process", arguments: args })}</tool_call>` };
        else yield { kind: "toolCall", name: "wait_process", argsJson: JSON.stringify(args), id: "call_job_wait" };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: event => events.push(event)
    });
    await session.sendUserMessage("run and wait");

    expect(record.messages.filter(message => message.role === "tool")).toHaveLength(2);
    expect(record.messages[record.messages.length - 2].content).toContain("finished (exit 0)");
    const waitProposal = events.find(
      (event): event is Extract<UiEvent, { kind: "toolCallProposed" }> =>
        event.kind === "toolCallProposed" && event.toolName === "wait_process"
    );
    expect(waitProposal).toMatchObject({
      category: "process", approvalRequired: false,
      processJobId: expect.stringMatching(/^job_/), processCommand: "npm test", processRunning: true
    });
    expect(record.messages.filter(message => message.role === "tool").map(message => message.toolCall?.processCommand))
      .toEqual(["npm test", "npm test"]);
    expect(record.messages.filter(message => message.role === "tool").map(message => ({
      output: message.toolCall?.processOutput, exitCode: message.toolCall?.processExitCode
    }))).toEqual([{ output: "started\ndone\n", exitCode: 0 }, { output: "done\n", exitCode: 0 }]);
  });

  it("persists a runner failure after the initial command has yielded", async () => {
    mocks.settings.toolCallingMode = "native";
    mocks.settings.autoapproveCommands = true;
    let fail!: (error: Error) => void;
    const result = new Promise<never>((_resolve, reject) => { fail = reject; });
    mocks.startCommand.mockReturnValue({
      result,
      snapshot: () => ({ stdout: "started\n", stderr: "", output: "started\n", truncated: false }),
      wait: vi.fn(async () => ({ running: true as const })),
      stop: vi.fn(async () => result)
    });
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) yield { kind: "toolCall", name: "run_command", argsJson: '{"command":"npm test"}', id: "yield_then_fail" };
      else {
        fail(new Error("runner connection lost"));
        await Promise.resolve();
        yield { kind: "text", text: "done" };
      }
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({ storage: { save: vi.fn() } as never, workspaceRoot: "/tmp/workspace", record, emit: event => events.push(event) });
    await session.sendUserMessage("Run the command");
    expect(events).toContainEqual(expect.objectContaining({ kind: "processJobState", status: "failed", resultPreview: "error: runner connection lost" }));
    expect(record.messages.find(message => message.toolCall?.id === "yield_then_fail")?.toolCall)
      .toMatchObject({ status: "failed", processOutput: "error: runner connection lost" });
  });

  it("lets the user stop a process during an active check and records the update for the model", async () => {
    mocks.settings.toolCallingMode = "native";
    mocks.settings.autoapproveCommands = true;
    const stoppedResult = { exitCode: -1, stdout: "started\n", stderr: "", truncated: false };
    let resolveResult = (_value: typeof stoppedResult): void => undefined;
    const result = new Promise<typeof stoppedResult>(resolve => { resolveResult = resolve; });
    const stop = vi.fn(async () => {
      resolveResult(stoppedResult);
      return stoppedResult;
    });
    let waits = 0;
    mocks.startCommand.mockReturnValue({
      result,
      snapshot: () => ({ stdout: "started\n", stderr: "", truncated: false }),
      wait: vi.fn(async () => waits++ === 0
        ? { running: true as const, output: { stdout: "started\n", stderr: "", truncated: false } }
        : { running: false as const, result: await result }),
      stop
    });
    let releaseFinal = (): void => undefined;
    const finalGate = new Promise<void>(resolve => { releaseFinal = resolve; });
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield { kind: "toolCall", name: "run_command", argsJson: '{"command":"npm test"}', id: "call_user_stop" };
      } else if (pass === 2) {
        const started = events.find(
          (event): event is Extract<UiEvent, { kind: "toolCallResolved" }> =>
            event.kind === "toolCallResolved" && event.processRunning === true
        );
        yield { kind: "toolCall", name: "wait_process", argsJson: JSON.stringify({ job_id: started?.processJobId }), id: "call_stop_check" };
      } else {
        await finalGate;
        yield { kind: "text", text: "process started" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: event => events.push(event)
    });
    const turn = session.sendUserMessage("start it");
    await vi.waitFor(() => expect(events.some(
      event => event.kind === "toolCallProposed" && event.toolName === "wait_process"
    )).toBe(true));
    const check = events.find(
      (event): event is Extract<UiEvent, { kind: "toolCallProposed" }> =>
        event.kind === "toolCallProposed" && event.toolName === "wait_process"
    )!;
    expect(check).toMatchObject({ processCommand: "npm test", processRunning: true });
    expect(events.some(event => event.kind === "toolCallResolved" && event.toolId === check.toolId)).toBe(false);
    const jobId = check.processJobId!;

    await session.handleFeatureAction(jobId);
    releaseFinal();
    await turn;

    expect(stop).toHaveBeenCalledOnce();
    const userStopResult = [...record.messages].reverse().find(message => message.toolCall?.name === "stop_process");
    expect(userStopResult?.content).toContain("stopped by the user");
    expect(userStopResult?.toolCall?.processCommand).toBe("npm test");
    expect(events).toContainEqual(expect.objectContaining({
      kind: "toolCallResolved", toolId: check.toolId, status: "executed", processRunning: false, processCommand: "npm test"
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "processJobState",
      jobId,
      running: false
    }));
  });

  it("stops every yielded process after the model's final answer and before turn end", async () => {
    mocks.settings.toolCallingMode = "native";
    mocks.settings.autoapproveCommands = true;
    const stoppedResult = { exitCode: -1, stdout: "started\n", stderr: "", truncated: false };
    let resolveResult = (_value: typeof stoppedResult): void => undefined;
    const result = new Promise<typeof stoppedResult>(resolve => { resolveResult = resolve; });
    const stop = vi.fn(async () => {
      resolveResult(stoppedResult);
      return stoppedResult;
    });
    mocks.startCommand.mockReturnValue({
      result,
      snapshot: () => ({ stdout: "started\n", stderr: "", truncated: false }),
      wait: vi.fn(async () => ({ running: true as const, output: { stdout: "started\n", stderr: "", truncated: false } })),
      stop
    });
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield { kind: "toolCall", name: "run_command", argsJson: '{"command":"npm test"}', id: "call_auto_stop" };
      } else {
        yield { kind: "text", text: "final answer" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: event => events.push(event)
    });

    await session.sendUserMessage("start it");

    expect(stop).toHaveBeenCalledOnce();
    const answerIndex = events.map(event => event.kind).lastIndexOf("text");
    const stoppedIndex = events.findIndex(event =>
      event.kind === "processJobState" && event.resultPreview?.includes("model response completed")
    );
    const turnEndIndex = events.findIndex(event => event.kind === "turnEnd");
    expect(stoppedIndex).toBeGreaterThan(answerIndex);
    expect(turnEndIndex).toBeGreaterThan(stoppedIndex);
  });

  it("persists individual edit diffs through a real chat reload and later file changes", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    try {
      await fs.writeFile(path.join(ws, "a.txt"), "original\n", "utf8");
      mocks.settings.toolCallingMode = "native";
      mocks.settings.autoapproveWrites = true;
      let pass = 0;
      mocks.streamChat.mockImplementation(async function* () {
        if (pass < 2) {
          const previous = pass === 0 ? "original" : "first";
          const next = pass === 0 ? "first" : "second";
          yield {
            kind: "toolCall", name: "replace_range", id: `saved_edit_${pass++}`,
            argsJson: JSON.stringify({ path: "a.txt", startLine: 1, endLine: 1, expectedContent: previous, content: next + "\n" })
          };
        } else yield { kind: "text", text: "Done" };
      });
      const { ChatStorage } = await import("../src/chat/storage.js");
      const { ChatSession } = await import("../src/chat/session.js");
      const { restoredToolFileChanges } = await import("../src/ui/chatView/webview/toolHistory.js");
      const storage = new ChatStorage(ws, path.join(ws, "chats"));
      const record = storage.newRecord("native");
      record.title = "Saved edits";
      const events: UiEvent[] = [];
      const session = new ChatSession({ storage, workspaceRoot: ws, record, emit: event => events.push(event) });
      await session.sendUserMessage("Edit the first line twice");
      expect(events.some(event => event.kind === "abort")).toBe(false);
      await expect(fs.readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe("second\n");
      await session.shutdown();
      await fs.unlink(path.join(ws, "a.txt"));
      const reloaded = await storage.load(record.id);
      expect(reloaded).toBeDefined();
      const changes = [...restoredToolFileChanges(reloaded!).values()];
      expect(changes).toEqual([
        { path: "a.txt", added: 1, removed: 1, diffPreview: "-\t1\t\toriginal\n+\t\t1\tfirst" },
        { path: "a.txt", added: 1, removed: 1, diffPreview: "-\t1\t\tfirst\n+\t\t1\tsecond" }
      ]);
      for (const change of changes) {
        expect(events).toContainEqual(expect.objectContaining({
          kind: "toolCallResolved", status: "executed", diffPreview: change.diffPreview,
          added: change.added, removed: change.removed
        }));
      }
      const forked = await storage.fork(reloaded!);
      expect([...restoredToolFileChanges(forked).values()]).toEqual(changes);
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it("uses the read revision for a native atomic edit", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\n", "utf8");
    mocks.settings.toolCallingMode = "native";
    mocks.settings.autoapproveWrites = true;
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: { messages: Array<{ role: string; content: string }> }) {
      if (pass++ === 0) {
        yield { kind: "toolCall", name: "read_file", argsJson: '{"path":"a.txt"}', id: "call_read_edit" };
      } else if (pass === 2) {
        const readResult = [...request.messages].reverse().find(message => message.role === "tool")?.content ?? "";
        const revision = /\[revision (sha256:[a-f0-9]{64})\]/.exec(readResult)?.[1];
        expect(revision).toBeTruthy();
        yield {
          kind: "toolCall",
          name: "edit_file",
          argsJson: JSON.stringify({
            path: "a.txt",
            baseRevision: revision,
            edits: [{ oldText: "two", newText: "TWO" }]
          }),
          id: "call_edit_1"
        };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record: newRecord(),
      emit: event => events.push(event)
    });
    await session.sendUserMessage("edit it");

    await expect(fs.readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe("one\nTWO\n");
    const proposal = events.find(
      (event): event is Extract<UiEvent, { kind: "toolCallProposed" }> =>
        event.kind === "toolCallProposed" && event.toolName === "edit_file"
    );
    expect(proposal?.diffPreview).toMatch(/^-\t.*\ttwo$/m);
    expect(proposal?.diffPreview).toMatch(/^\+\t.*\tTWO$/m);
  });

  it("executes native replace_range and insert_text edits with approval diffs", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\n", "utf8");
    mocks.settings.toolCallingMode = "native";
    mocks.settings.autoapproveWrites = true;
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) {
        yield {
          kind: "toolCall",
          name: "replace_range",
          argsJson: JSON.stringify({
            path: "a.txt",
            startLine: 2,
            endLine: 2,
            expectedContent: "two",
            content: "TWO\n"
          }),
          id: "call_replace_native"
        };
      } else if (pass === 2) {
        yield {
          kind: "toolCall",
          name: "insert_text",
          argsJson: JSON.stringify({
            path: "a.txt",
            line: 2,
            expectedLine: "TWO",
            text: "middle\n"
          }),
          id: "call_insert_native"
        };
      } else {
        yield { kind: "text", text: "done" };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record: newRecord(),
      emit: event => events.push(event)
    });
    await session.sendUserMessage("edit it with line tools");

    await expect(fs.readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe("one\nmiddle\nTWO\n");
    const proposals = events.filter(
      (event): event is Extract<UiEvent, { kind: "toolCallProposed" }> => event.kind === "toolCallProposed"
    );
    const replaceProposal = proposals.find(event => event.toolName === "replace_range");
    const insertProposal = proposals.find(event => event.toolName === "insert_text");
    expect(replaceProposal?.diffPreview).toMatch(/^-\t.*\ttwo$/m);
    expect(replaceProposal?.diffPreview).toMatch(/^\+\t.*\tTWO$/m);
    expect(insertProposal?.diffPreview).toMatch(/^\+\t.*\tmiddle$/m);
  });

  it("ignores a second send while a turn is already active", async () => {
    let releaseStream: () => void = () => undefined;
    const streamReleased = new Promise<void>(resolve => { releaseStream = resolve; });
    const streamStarted = new Promise<void>(resolve => {
      mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
        resolve();
        await streamReleased;
        yield { kind: "text", text: "done" };
      });
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const storage = { save: vi.fn(async () => undefined) };
    const session = new ChatSession({
      storage: storage as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: e => events.push(e)
    });

    const firstTurn = session.sendUserMessage("first");
    await streamStarted;
    await session.sendUserMessage("second");

    const userMessagesDuringTurn = record.messages
      .filter(m => m.role === "user")
      .map(m => m.content);
    releaseStream();
    await firstTurn;

    expect(userMessagesDuringTurn).toEqual(["first"]);
    expect(events).toContainEqual({
      kind: "notice",
      text: "A chat turn is already running. Wait for it to finish or cancel it before sending another message."
    });
  });

  it("edits a user turn, removes everything after it, and regenerates", async () => {
    const answers = ["first answer", "second answer", "regenerated answer"];
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: { onResponseAccepted?: () => void }): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      request.onResponseAccepted?.();
      yield { kind: "text", text: answers.shift() ?? "" };
    });
    mocks.complete.mockResolvedValue("Edit earlier request");

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const storage = { save: vi.fn(async () => undefined) };
    const session = new ChatSession({
      storage: storage as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: event => events.push(event)
    });

    await session.sendUserMessage("first request");
    const firstUserTs = record.messages.find(message => message.role === "user")!.ts;
    await session.sendUserMessage("second request");
    await session.editUserMessage(firstUserTs, "edited first request", [], "review");

    expect(record.messages.map(message => [message.role, message.content])).toEqual([
      ["user", "edited first request"],
      ["assistant", "regenerated answer"]
    ]);
    expect(events.some(event => event.kind === "chatLoaded")).toBe(true);
    expect(record.messages[0].mode).toBe("review");
    expect(record.mode).toBe("act");
    expect(events).toContainEqual({
      kind: "titleChanged",
      title: "Edit earlier request",
      animate: true
    });
  });

  it("keeps consecutive edits to the same file as separate items with per-call stats", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\nthree\n", "utf8");
    mocks.settings.autoapproveWrites = true;

    // Two consecutive replace_range edits to a.txt, then a plain final answer.
    const responses = [
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:1,endLine:1,expectedContent:<|\"|>one<|\"|>,content:<|\"|>ONE\n<|\"|>"),
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:2,endLine:2,expectedContent:<|\"|>two<|\"|>,content:<|\"|>TWO\n<|\"|>"),
      "all done"
    ];
    mockLegacyFallback(responses);

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record: newRecord(),
      emit: e => events.push(e)
    });

    await session.sendUserMessage("edit it");

    const executed = events.filter(
      (e): e is Extract<UiEvent, { kind: "toolCallResolved" }> =>
        e.kind === "toolCallResolved" && e.status === "executed"
    );
    expect(executed).toHaveLength(2);
    expect(executed[0].toolId).not.toBe(executed[1].toolId);
    expect({ added: executed[0].added, removed: executed[0].removed }).toEqual({ added: 1, removed: 1 });
    expect({ added: executed[1].added, removed: executed[1].removed }).toEqual({ added: 1, removed: 1 });
    // The file reflects both edits.
    await expect(fs.readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe("ONE\nTWO\nthree\n");

    const proposed = events.filter(
      (e): e is Extract<UiEvent, { kind: "toolCallProposed" }> => e.kind === "toolCallProposed"
    );
    expect(proposed).toHaveLength(2);
    expect(proposed[0].toolId).not.toBe(proposed[1].toolId);
  });

  it("keeps a re-edit's streaming progress on its own item", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\nthree\n", "utf8");
    mocks.settings.autoapproveWrites = true;

    const responses = [
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:1,endLine:1,expectedContent:<|\"|>one<|\"|>,content:<|\"|>ONE\n<|\"|>"),
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:2,endLine:2,expectedContent:<|\"|>two<|\"|>,content:<|\"|>TWO\n<|\"|>"),
      "all done"
    ];
    mockLegacyFallback(responses);

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record: newRecord(),
      emit: e => events.push(e)
    });

    await session.sendUserMessage("edit it twice");

    const progressEvents = events
      .filter((e): e is Extract<UiEvent, { kind: "toolCallProgress" }> => e.kind === "toolCallProgress")
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    expect(new Set(progressEvents.map(e => e.toolId)).size).toBeGreaterThanOrEqual(2);
  });

  it("keeps same-file edits separate when another tool runs between them", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\n", "utf8");
    mocks.settings.autoapproveWrites = true;

    const responses = [
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:1,endLine:1,expectedContent:<|\"|>one<|\"|>,content:<|\"|>ONE\n<|\"|>"),
      gemmaCall("read_file", "path:<|\"|>a.txt<|\"|>"),
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:2,endLine:2,expectedContent:<|\"|>two<|\"|>,content:<|\"|>TWO\n<|\"|>"),
      "done"
    ];
    mockLegacyFallback(responses);

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record: newRecord(),
      emit: e => events.push(e)
    });

    await session.sendUserMessage("edit, read, edit");

    const edits = events
      .filter(
        (e): e is Extract<UiEvent, { kind: "toolCallResolved" }> =>
          e.kind === "toolCallResolved" && e.status === "executed" && e.added !== undefined
      );
    expect(edits).toHaveLength(2);
    expect(edits[0].toolId).not.toBe(edits[1].toolId);
  });

  it("auto-approves a command when autoapproveCommands is on", async () => {
    mocks.settings.autoapproveCommands = true;
    mocks.runCommand.mockImplementation(async (
      _command: string,
      _cwd: string,
      _signal?: AbortSignal,
      onOutput?: (output: { stdout: string; stderr: string; truncated: boolean }) => void
    ) => {
      onOutput?.({ stdout: "streamed", stderr: "", truncated: false });
      return { exitCode: 0, stdout: "streamed\nok", stderr: "", truncated: false };
    });

    const responses = [
      gemmaCall("run_command", "command:<|\"|>npm test<|\"|>"),
      "done"
    ];
    mockLegacyFallback(responses);

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: e => events.push(e)
    });

    await session.sendUserMessage("run tests");

    // The command ran without an approval round-trip.
    expect(mocks.runCommand).toHaveBeenCalledOnce();
    const proposed = events.find(
      (e): e is Extract<UiEvent, { kind: "toolCallProposed" }> => e.kind === "toolCallProposed"
    );
    expect(proposed?.category).toBe("command");
    expect(proposed?.approvalRequired).toBe(false);
    expect(events.some(e => e.kind === "toolCallResolved" && e.status === "approved")).toBe(false);
    expect(events.some(e => e.kind === "toolCallResolved" && e.status === "executed")).toBe(true);
    const outputIndex = events.findIndex(e => e.kind === "toolCallOutput");
    const resolvedIndex = events.findIndex(e => e.kind === "toolCallResolved" && e.status === "executed");
    expect(outputIndex).toBeGreaterThan(-1);
    expect(events[outputIndex]).toEqual(expect.objectContaining({
      kind: "toolCallOutput",
      resultPreview: expect.stringContaining("streamed")
    }));
    expect(outputIndex).toBeLessThan(resolvedIndex);
    expect(events[resolvedIndex]).toEqual(expect.objectContaining({
      kind: "toolCallResolved",
      resultPreview: expect.stringContaining("streamed\nok")
    }));
    expect(record.messages.find(message => message.role === "tool")?.content)
      .toContain("streamed\nok");
  });

  it("does not launch when command auto-approval is disabled before execution", async () => {
    mocks.settings.autoapproveCommands = true;
    mockLegacyFallback([gemmaCall("run_command", "command:<|\"|>npm test<|\"|>"), "done"]);
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace", record,
      emit: event => {
        if (event.kind === "toolCallProposed") mocks.settings.autoapproveCommands = false;
      }
    });
    await session.sendUserMessage("run tests");
    expect(mocks.startCommand).not.toHaveBeenCalled();
    expect(record.messages.find(message => message.role === "tool")?.content).toContain("Approval settings changed");
  });

  it.each((["plan", "review"] as const).flatMap(mode => ([
    ["native", false], ["native", true], ["compat-gemma4", false], ["compat-gemma4", true]
  ] as const).map(([profile, autoapprove]) => ({ mode, profile, autoapprove }))))(
    "blocks commands in $mode ($profile, autoapprove=$autoapprove)", async ({ mode, profile, autoapprove }) => {
      mocks.settings.toolCallingMode = profile;
      mocks.settings.autoapproveCommands = autoapprove;
      if (profile === "native") {
        let pass = 0;
        mocks.streamChat.mockImplementation(async function* () {
          if (pass++ === 0) {
            yield { kind: "toolCall", name: "run_command", argsJson: '{"command":"npm test"}', id: "call_read_only_command" };
          } else yield { kind: "text", text: "Inspection complete" };
        });
      } else {
        mockLegacyFallback([
          gemmaCall("run_command", 'command:<|"|>npm test<|"|>'),
          "Inspection complete"
        ]);
      }
      const { ChatSession } = await import("../src/chat/session.js");
      const record = newRecord();
      record.mode = mode;
      const events: UiEvent[] = [];
      const session = new ChatSession({
        storage: { save: vi.fn(async () => undefined) } as never,
        workspaceRoot: "/tmp/workspace", record, emit: event => events.push(event)
      });
      await session.sendUserMessage("Inspect the tests");
      expect(events).toContainEqual(expect.objectContaining({
        kind: "toolCallProposed", category: "modeViolation", approvalRequired: false
      }));
      expect(events).toContainEqual(expect.objectContaining({ kind: "toolCallResolved", status: "rejected" }));
      expect(mocks.startCommand).not.toHaveBeenCalled();
      expect(mocks.runCommand).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["plan", "native"], ["review", "native"],
    ["plan", "compat-qwen3"], ["review", "compat-qwen3"]
  ] as const)("rejects every write and process tool in %s with %s calling", async (mode, profile) => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-read-only-"));
    mocks.settings.toolCallingMode = profile;
    mocks.settings.autoapproveWrites = true;
    mocks.settings.autoapproveCommands = true;
    const calls = [
      { name: "create_file", args: { path: "created.txt", content: "new file" } },
      { name: "write_file", args: { path: "existing.txt", content: "replacement" } },
      { name: "edit_file", args: { path: "existing.txt", baseRevision: `sha256:${"a".repeat(64)}`, edits: [{ oldText: "original", newText: "replacement" }] } },
      { name: "insert_text", args: { path: "existing.txt", line: 1, expectedLine: "original", text: "inserted" } },
      { name: "replace_range", args: { path: "existing.txt", startLine: 1, endLine: 1, expectedContent: "original", content: "replacement" } },
      { name: "run_command", args: { command: "npm test" } },
      { name: "wait_process", args: { job_id: "job_existing" } },
      { name: "stop_process", args: { job_id: "job_existing" } }
    ];
    const { ChatSession } = await import("../src/chat/session.js");
    try {
      await fs.writeFile(path.join(ws, "existing.txt"), "original\n");
      for (const call of calls) {
        if (profile === "native") {
          let pass = 0;
          mocks.streamChat.mockImplementation(async function* () {
            if (pass++ === 0) yield { kind: "toolCall", name: call.name, argsJson: JSON.stringify(call.args), id: "call_read_only" };
            else yield { kind: "text", text: "Inspection complete" };
          });
        } else {
          mockLegacyFallback([`<tool_call>${JSON.stringify({ name: call.name, arguments: call.args })}</tool_call>`, "Inspection complete"]);
        }
        const record = newRecord();
        record.mode = mode;
        const events: UiEvent[] = [];
        const session = new ChatSession({
          storage: { save: vi.fn(async () => undefined) } as never,
          workspaceRoot: ws, record, emit: event => events.push(event)
        });
        try {
          await session.sendUserMessage("Inspect the code");
          expect(events).toContainEqual(expect.objectContaining({
            kind: "toolCallProposed", toolName: call.name, category: "modeViolation", approvalRequired: false
          }));
          expect(events).toContainEqual(expect.objectContaining({ kind: "toolCallResolved", status: "rejected" }));
          expect(events.some(event => event.kind === "toolCallResolved" && event.status === "approved")).toBe(false);
          expect(mocks.startCommand).not.toHaveBeenCalled();
          await expect(fs.readdir(ws)).resolves.toEqual(["existing.txt"]);
          await expect(fs.readFile(path.join(ws, "existing.txt"), "utf8")).resolves.toBe("original\n");
        } finally { await session.shutdown(); }
      }
    } finally { await fs.rm(ws, { recursive: true, force: true }); }
  });

  it("still requires approval for a command when autoapproveCommands is off", async () => {
    mocks.settings.autoapproveCommands = false;
    mocks.runCommand.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "", truncated: false });

    const responses = [
      gemmaCall("run_command", "command:<|\"|>npm test<|\"|>"),
      "done"
    ];
    mockLegacyFallback(responses);

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    let resolveProposed: (id: string) => void = () => undefined;
    const proposedId = new Promise<string>(r => { resolveProposed = r; });
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: e => {
        events.push(e);
        if (e.kind === "toolCallProposed") resolveProposed(e.toolId);
      }
    });

    const turn = session.sendUserMessage("run tests");
    // The turn blocks awaiting approval: the call was proposed but not executed.
    const toolId = await proposedId;
    const proposed = events.find(
      (e): e is Extract<UiEvent, { kind: "toolCallProposed" }> => e.kind === "toolCallProposed"
    );
    expect(proposed?.category).toBe("command");
    expect(proposed?.approvalRequired).toBe(true);
    expect(mocks.runCommand).not.toHaveBeenCalled();

    // Approving lets it run.
    session.approve(toolId, true);
    await turn;
    expect(mocks.runCommand).toHaveBeenCalledOnce();
  });

  it("auto-approves arbitrary commands when command auto-approval is on", async () => {
    mocks.settings.autoapproveCommands = true;
    mocks.runCommand.mockResolvedValue({ exitCode: 0, stdout: "published", stderr: "", truncated: false });

    const responses = [
      gemmaCall("run_command", "command:<|\"|>npm publish<|\"|>"),
      "done"
    ];
    mockLegacyFallback(responses);

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: event => {
        events.push(event);
      }
    });

    await session.sendUserMessage("publish it");
    const proposed = events.find(
      (event): event is Extract<UiEvent, { kind: "toolCallProposed" }> => event.kind === "toolCallProposed"
    );
    expect(proposed?.category).toBe("command");
    expect(proposed?.approvalRequired).toBe(false);
    expect(mocks.runCommand).toHaveBeenCalledWith(
      "npm publish",
      "/tmp/workspace",
      expect.any(AbortSignal),
      expect.any(Function)
    );
  });

  it("reports a rejected command to the model and continues through the legacy adapter", async () => {
    mocks.settings.autoapproveCommands = false;
    mockLegacyFallback([
      gemmaCall("run_command", "command:<|\"|>npm publish<|\"|>"),
      "I will leave publishing to you."
    ]);

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    let resolveProposed: (id: string) => void = () => undefined;
    const proposedId = new Promise<string>(resolve => { resolveProposed = resolve; });
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: event => {
        events.push(event);
        if (event.kind === "toolCallProposed") resolveProposed(event.toolId);
      }
    });

    const turn = session.sendUserMessage("publish it");
    const toolId = await proposedId;
    session.approve(toolId, false);
    await turn;

    expect(mocks.runCommand).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      kind: "toolCallResolved",
      toolId,
      status: "rejected"
    }));
    expect(events.some(event => event.kind === "abort")).toBe(false);
    expect(mocks.streamChat.mock.calls.at(-1)?.[1].messages).toContainEqual(expect.objectContaining({
      role: "user", content: expect.stringContaining("[rejected by user]")
    }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "text", delta: "I will leave publishing to you." }));
  });

  it("feeds back a malformed tool call so the model can re-emit it", async () => {
    // An irreparable qwen3 <tool_call> body parses to a blank name. The session must reject it WITH feedback
    // and re-prompt — silently dropping it ends the turn with no reply at all.
    mocks.settings.toolCallingMode = "compat-qwen3";
    const responses = [
      `<tool_call>{"name":"list_dir","arguments":{"path":???}}</tool_call>`,
      "Recovered review."
    ];
    mockLegacyFallback(responses);

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: e => events.push(e)
    });

    await session.sendUserMessage("review");

    expect(events.some(e => e.kind === "abort")).toBe(false);
    expect(events.some(e => e.kind === "toolCallResolved" && e.status === "rejected")).toBe(true);
    // The failure is stored as a tool result quoting the raw block, so the
    // next pass tells the model what went wrong.
    const feedback = record.messages.find(m => m.role === "tool");
    expect(feedback?.content).toContain("Malformed tool call");
    expect(feedback?.content).toContain("Parser detail:");
    expect(feedback?.content).toContain("???");
    const answer = events
      .filter((e): e is Extract<UiEvent, { kind: "text" }> => e.kind === "text")
      .map(e => e.delta)
      .join("");
    expect(answer).toContain("Recovered review.");
  });

  it("labels an orphaned malformed Qwen edit with its actual streamed tool name", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "old\n", "utf8");
    mocks.settings.toolCallingMode = "compat-qwen3";
    mocks.settings.autoapproveWrites = true;
    const responses = [
      `<tool_call>{"name":"replace_range","arguments":{"path":"a.txt","startLine":1,"endLine":1,"expectedContent":"old","content":"const x = "broken";\n"}}</tool_call>`,
      "Recovered after malformed edit."
    ];
    mockLegacyFallback(responses);

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record: newRecord(),
      emit: event => events.push(event)
    });

    await session.sendUserMessage("edit it");

    const failures = events.filter(
      (event): event is Extract<UiEvent, { kind: "toolCallResolved" }> => event.kind === "toolCallResolved"
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ status: "rejected" });
    expect(failures[0].resultPreview).toContain("Malformed tool call");
    expect(failures[0].resultPreview).toContain("Parser detail:");
    expect(failures[0].resultPreview).not.toContain("incomplete write_file");
    const proposed = events.find(
      (event): event is Extract<UiEvent, { kind: "toolCallProposed" }> => event.kind === "toolCallProposed"
    );
    expect(proposed?.toolName).toBe("replace_range");
    await expect(fs.readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe("old\n");
  });

  it("rejects an edit that omits its required old-content precondition", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\n", "utf8");
    mocks.settings.autoapproveWrites = true;
    const responses = [
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:1,endLine:1,content:<|\"|>ONE\n<|\"|>"),
      "Recovered without applying the unsafe edit."
    ];
    mockLegacyFallback(responses);

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: () => undefined
    });

    await session.sendUserMessage("edit safely");

    await expect(fs.readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe("one\ntwo\n");
    const feedback = record.messages.find(m => m.role === "tool");
    expect(feedback?.content).toContain("expectedContent safety precondition");
  });

  it("feeds back a tool call cut off before its closing tag (qwen3)", async () => {
    // The model emitted a read-only tool call but the stream ended before
    // </tool_call>. Previously this was dropped silently and the turn ended
    // with the "model stopped after its tool calls" notice.
    mocks.settings.toolCallingMode = "compat-qwen3";
    const responses = [
      `<tool_call>{"name":"read_file","arguments":{"path":"src/ma`,
      "Recovered after the cut-off."
    ];
    mockLegacyFallback(responses);

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: e => events.push(e)
    });

    await session.sendUserMessage("review the codebase");

    expect(events.some(e => e.kind === "abort")).toBe(false);
    expect(events.some(e => e.kind === "notice" && e.text.includes("Qwen 3 legacy adapter"))).toBe(true);
    const answer = events
      .filter((e): e is Extract<UiEvent, { kind: "text" }> => e.kind === "text")
      .map(e => e.delta)
      .join("");
    expect(answer).toContain("Recovered after the cut-off.");
  });

  it("executes an unclosed tool call whose body is complete JSON (qwen3)", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf8");
    mocks.settings.toolCallingMode = "compat-qwen3";
    // Only the closing </tool_call> tag was cut off; the call itself is whole.
    const responses = [
      `<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}`,
      "The file says hello."
    ];
    mockLegacyFallback(responses);

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: e => events.push(e)
    });

    await session.sendUserMessage("read it");

    const toolResult = record.messages.find(m => m.role === "tool");
    expect(toolResult?.toolCall?.name).toBe("read_file");
    expect(toolResult?.content).toContain("hello");
    const answer = events
      .filter((e): e is Extract<UiEvent, { kind: "text" }> => e.kind === "text")
      .map(e => e.delta)
      .join("");
    expect(answer).toContain("The file says hello.");
  });

  it("feeds back a truncated (incomplete) write_file call and re-prompts", async () => {
    mocks.settings.toolCallingMode = "compat-gemma4";
    mocks.settings.autoapproveWrites = true;
    // First pass opens a write_file and streams content but never closes the
    // tool-call block (the model was cut off). Second pass answers.
    const responses = [
      `<|tool_call>call:write_file{path:<|"|>a.txt<|"|>,content:<|"|>partial conten`,
      "Recovered after the cut-off."
    ];
    mockLegacyFallback(responses);

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: e => events.push(e)
    });

    await session.sendUserMessage("write it");

    // The incomplete call is reported as failed and the model gets another pass.
    expect(events.some(e => e.kind === "toolCallResolved" && e.status === "failed")).toBe(true);
    expect(events.some(e => e.kind === "abort")).toBe(false);
    const answer = events
      .filter((e): e is Extract<UiEvent, { kind: "text" }> => e.kind === "text")
      .map(e => e.delta)
      .join("");
    expect(answer).toContain("Recovered after the cut-off.");
  });

  it("notifies the user when a turn ends with no visible reply", async () => {
    mocks.settings.toolCallingMode = "compat-qwen3";
    // The model only thinks, then stops — no answer text, no tool.
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: "<think>I won't actually answer.</think>" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: e => events.push(e)
    });

    await session.sendUserMessage("hi");

    expect(events.some(e => e.kind === "notice")).toBe(true);
    expect(events.some(e => e.kind === "summary")).toBe(false);
    // No empty assistant message is persisted (thought-only turns are UI state).
    expect(record.messages.some(m => m.role === "assistant")).toBe(false);
  });

  it("includes the server finish reason in a thought-only notice", async () => {
    mocks.settings.toolCallingMode = "native";
    mocks.streamChat.mockImplementation(async function* () {
      yield { kind: "thought" as const, text: "I should call a tool." };
      yield { kind: "finish" as const, reason: "stop" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: e => events.push(e)
    });

    await session.sendUserMessage("hi");

    const notice = events.find(
      (e): e is Extract<UiEvent, { kind: "notice" }> =>
        e.kind === "notice" && e.text.includes("finish_reason")
    );
    expect(notice?.text).toContain('finish_reason="stop"');
    expect(events.some(event => event.kind === "notice" && event.text.includes("Retrying native continuation"))).toBe(true);
    expect(events.some(event => event.kind === "notice" && event.text.includes("retry was already attempted"))).toBe(true);
    expect(mocks.streamChat).toHaveBeenCalledTimes(2);
  });

  it("retries one native reasoning-only stop with an ephemeral repair note", async () => {
    mocks.settings.toolCallingMode = "compat-qwen3";
    const requests: Array<Record<string, unknown>> = [];
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: Record<string, unknown>) {
      requests.push(request);
      if (pass++ === 0) {
        yield { kind: "thought", text: "I should inspect the workspace." };
        yield { kind: "finish", reason: "stop" };
      } else {
        yield { kind: "text", text: "Recovered answer." };
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: event => events.push(event)
    });
    await session.sendUserMessage("inspect it");

    expect(requests).toHaveLength(2);
    const retryMessages = requests[1].messages as Array<{ role: string; content: string }>;
    expect(retryMessages.at(-1)?.content).toContain("[harness recovery]");
    expect(retryMessages.at(-1)?.content).toContain("structured tool call or a final answer");
    expect(events.some(event => event.kind === "notice" && event.text.includes("Retrying native continuation"))).toBe(true);
    expect(events.some(event => event.kind === "summary" && event.text === "Recovered answer.")).toBe(true);
    expect(record.messages.at(-1)?.content).toBe("Recovered answer.");
  });

  it("warns about shifted line numbers when an edit changes the line count", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\nthree\n", "utf8");
    mocks.settings.autoapproveWrites = true;

    const responses = [
      // Replaces 1 line with 2 → everything after line 1 shifts by +1.
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:1,endLine:1,expectedContent:<|\"|>one<|\"|>,content:<|\"|>ONE\nEXTRA\n<|\"|>"),
      "done"
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: () => undefined
    });

    await session.sendUserMessage("edit");

    const toolResult = record.messages.find(m => m.role === "tool");
    expect(toolResult?.content).toContain("replaced lines 1-1 in a.txt");
    expect(toolResult?.content).toContain("after line 1 have shifted by +1");
    // The result echoes the updated region with fresh numbers so the model
    // sees the edit's effect without a re-read.
    expect(toolResult?.content).toContain("Updated region with current line numbers");
    expect(toolResult?.content).toContain("1\tONE");
    expect(toolResult?.content).toContain("2\tEXTRA");
    expect(toolResult?.content).toContain("3\ttwo");
  });

  it("rejects a same-reply line edit after an earlier edit shifted the file's line count", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\nthree\n", "utf8");
    mocks.settings.autoapproveWrites = true;

    // Both calls arrive in ONE model response: the model computed both from the
    // pre-edit read, but the first edit (+1 line) shifts everything below it.
    const responses = [
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:1,endLine:1,expectedContent:<|\"|>one<|\"|>,content:<|\"|>ONE\nEXTRA\n<|\"|>")
        + gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:3,endLine:3,expectedContent:<|\"|>three<|\"|>,content:<|\"|>THREE\n<|\"|>"),
      "done"
    ];
    mockLegacyFallback(responses);

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: () => undefined
    });

    await session.sendUserMessage("edit");

    // Only the first edit landed; the second was refused, not mistargeted.
    await expect(fs.readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe("ONE\nEXTRA\ntwo\nthree\n");
    const toolResults = record.messages.filter(m => m.role === "tool").map(m => m.content);
    expect(toolResults[1]).toContain("stale");
    expect(toolResults[1]).toContain("NOT applied");
  });

  it("defers a same-reply follow-up line edit even when the first kept the same line count", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\nthree\n", "utf8");
    mocks.settings.autoapproveWrites = true;

    // Even a same-size first replacement forces a tool-result round trip before
    // another line-addressed edit, keeping the protocol simple for small models.
    const responses = [
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:1,endLine:1,expectedContent:<|\"|>one<|\"|>,content:<|\"|>ONE\n<|\"|>")
        + gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:3,endLine:3,expectedContent:<|\"|>three<|\"|>,content:<|\"|>THREE\n<|\"|>"),
      "done"
    ];
    mockLegacyFallback(responses);

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: () => undefined
    });

    await session.sendUserMessage("edit");

    await expect(fs.readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe("ONE\ntwo\nthree\n");
    const toolResults = record.messages.filter(m => m.role === "tool").map(m => m.content);
    expect(toolResults[1]).toContain("only one insert_text or replace_range call");
  });

  it("refuses edit content that pastes read_file's line-number prefixes back", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\nthree\n", "utf8");
    mocks.settings.autoapproveWrites = true;

    const responses = [
      gemmaCall("replace_range", "path:<|\"|>a.txt<|\"|>,startLine:2,endLine:3,expectedContent:<|\"|>two\nthree<|\"|>,content:<|\"|>2\tTWO\n3\tTHREE\n<|\"|>"),
      "done"
    ];
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: responses[Math.min(call++, responses.length - 1)] };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: () => undefined
    });

    await session.sendUserMessage("edit");

    // Nothing was written; the model is told to resend without the prefixes.
    await expect(fs.readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe("one\ntwo\nthree\n");
    const toolResult = record.messages.find(m => m.role === "tool");
    expect(toolResult?.content).toContain("line-number prefixes");
    expect(toolResult?.content).toContain("nothing was written");
  });

  it("returns real line numbers and a range header for ranged read_file calls", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\nthree\nfour\n", "utf8");
    mocks.settings.toolCallingMode = "compat-qwen3";
    // snake_case range keys, as local models commonly emit them.
    const responses = [
      `<tool_call>{"name":"read_file","arguments":{"path":"a.txt","start_line":2,"end_line":3}}</tool_call>`,
      "Read the middle."
    ];
    mockLegacyFallback(responses);

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: e => events.push(e)
    });

    await session.sendUserMessage("read lines 2-3");

    const toolResult = record.messages.find(m => m.role === "tool");
    expect(toolResult?.content).toBe("[lines 2-3 of 4]\n2\ttwo\n3\tthree");
  });

  it("uses the context window reported by the server", async () => {
    mocks.fetchServerContextSize.mockResolvedValue(8192);
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: "hi there" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: e => events.push(e)
    });

    await session.sendUserMessage("hello");

    const tokenEvents = events.filter((e): e is Extract<UiEvent, { kind: "tokens" }> => e.kind === "tokens");
    expect(tokenEvents.some(e => e.limit === 8192)).toBe(true);
    expect(tokenEvents.every(e => e.limit === 8192)).toBe(true);
    const notices = events.filter((e): e is Extract<UiEvent, { kind: "notice" }> => e.kind === "notice");
    expect(notices.filter(n => n.text.includes("context window"))).toHaveLength(0);
  });

  it("does not start generation when server metadata has no context length", async () => {
    mocks.fetchServerContextSize.mockResolvedValue(undefined);
    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: event => events.push(event)
    });

    await session.sendUserMessage("hello");

    expect(mocks.streamChat).not.toHaveBeenCalled();
    expect(events.some(event =>
      event.kind === "abort"
      && event.reason.includes("server is unavailable")
      && event.reason.includes("/props")
    )).toBe(true);
  });

  it("counts the system prompt toward context usage", async () => {
    // tokenize returns 100 for the system prompt and 1 for everything else;
    // the emitted totals must include that fixed overhead.
    mocks.tokenize.mockImplementation(async (_endpoint: string, text: string) =>
      text.startsWith("<|system|>") ? 100 : 1
    );
    mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
      yield { kind: "text", text: "hi" };
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: e => events.push(e)
    });

    await session.sendUserMessage("hello");

    const tokenEvents = events.filter((e): e is Extract<UiEvent, { kind: "tokens" }> => e.kind === "tokens");
    expect(tokenEvents.some(e => e.total >= 100)).toBe(true);
  });

  it.each([true, false])("keeps auto compaction active until its new prompt is processed (%s)", async reportProgress => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-"));
    await fs.writeFile(path.join(ws, "large.txt"), "TRIGGER_COMPACTION\n", "utf8");
    mocks.settings.autoCompact = true;
    mocks.settings.autoCompactThresholdPercent = 50;
    mocks.tokenize.mockImplementation(async (_endpoint: string, text: string) =>
      text.includes("TRIGGER_COMPACTION") ? 20_000 : 1
    );
    let call = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: { onResponseAccepted?: () => void }) {
      if (call++ === 0) throw new mocks.NativeToolsUnsupportedError("tools param requires --jinja flag");
      request.onResponseAccepted?.();
      if (call === 2) {
        yield { kind: "text", text: gemmaCall("read_file", "path:<|\"|>large.txt<|\"|>") };
      } else {
        if (reportProgress) yield { kind: "promptProgress", processedTokens: 128, totalTokens: 2048 };
        const compacted = events.find(event => event.kind === "compactEnd");
        expect(compacted).toMatchObject({ status: "executed" });
        if (compacted?.kind !== "compactEnd") throw new Error("Missing compaction");
        const ingested = () => !contextActivityIds(events).includes(compacted.compactId);
        expect(ingested()).toBe(false);
        expect(contextActivityIds(events)).toEqual([compacted.compactId]);
        if (reportProgress) {
          yield { kind: "promptProgress", processedTokens: 2048, totalTokens: 2048 };
          expect(ingested()).toBe(true);
        }
        yield { kind: "text", text: "done" };
        expect(ingested()).toBe(true);
      }
    });

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.title = "Existing chat";
    record.messages = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `history ${index}`,
      ts: index + 1
    }));
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: ws,
      record,
      emit: event => events.push(event)
    });

    await session.sendUserMessage("read the large file");

    const resolvedIndex = events.findIndex(event =>
      event.kind === "toolCallResolved" && event.status === "executed"
    );
    const compactIndex = events.findIndex(event => event.kind === "compactStart");
    expect(compactIndex).toBeGreaterThan(-1);
    expect(resolvedIndex).toBeGreaterThan(-1);
    expect(resolvedIndex).toBeLessThan(compactIndex);
    const readIngestionEnd = events.findIndex(event => event.kind === "contextActivity" && !event.activityIds.length);
    expect(readIngestionEnd).toBeGreaterThan(resolvedIndex);
    expect(readIngestionEnd).toBeLessThan(compactIndex);
    const compactEndIndex = events.findIndex(event => event.kind === "compactEnd");
    expect(compactEndIndex).toBeGreaterThan(compactIndex);
    const continuation = events.slice(compactEndIndex + 1);
    expect(continuation.some(event => event.kind === "turnPreparing" && event.reason === "context"))
      .toBe(false);
    expect(continuation).toContainEqual({ kind: "turnPreparing", reason: "server" });
    expect(continuation).toContainEqual(expect.objectContaining({ kind: "text", delta: "done" }));
    expect(events.some(event => event.kind === "abort")).toBe(false);
  });

  it("runs update_todos without approval and feeds the checklist back to the model", async () => {
    mocks.settings.toolCallingMode = "compat-qwen3";
    // autoapprove is off for writes/commands; update_todos must still run, since
    // it is side-effect-free and never routed through approval.
    const todos = [
      { content: "Step one", status: "completed" },
      { content: "Step two", status: "in_progress" },
      { content: "Step three", status: "pending" }
    ];
    const responses = [
      `<tool_call>{"name":"update_todos","arguments":{"todos":${JSON.stringify(todos)}}}</tool_call>`,
      "Tracked."
    ];
    mockLegacyFallback(responses);

    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record,
      emit: e => events.push(e)
    });

    await session.sendUserMessage("plan it");

    const proposed = events.find(
      (e): e is Extract<UiEvent, { kind: "toolCallProposed" }> => e.kind === "toolCallProposed"
    );
    expect(proposed?.category).toBe("todos");
    // Never asked for approval, never rejected/aborted.
    expect(events.some(e => e.kind === "toolCallResolved" && e.status === "approved")).toBe(false);
    expect(events.some(e => e.kind === "abort")).toBe(false);
    expect(events.some(e => e.kind === "toolCallResolved" && e.status === "executed")).toBe(true);
    // The tool result fed back to the model carries the current checklist.
    const toolResult = record.messages.find(m => m.role === "tool" && m.toolCall?.name === "update_todos");
    expect(toolResult?.content).toContain("todos updated (1/3 completed)");
    expect(toolResult?.content).toContain("- [x] Step one");
    expect(toolResult?.content).toContain("- [ ] Step two (in progress)");
  });

  it("feeds an unknown tool name back and lets the model recover instead of aborting", async () => {
    mocks.settings.toolCallingMode = "compat-qwen3";
    const responses = [
      `<tool_call>{"name":"search_files","arguments":{}}</tool_call>`,
      "Recovered answer."
    ];
    mockLegacyFallback(responses);

    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace",
      record: newRecord(),
      emit: e => events.push(e)
    });

    await session.sendUserMessage("go");

    expect(events.some(e => e.kind === "abort")).toBe(false);
    const rejected = events.filter(
      e => e.kind === "toolCallResolved" && e.status === "rejected"
    );
    expect(rejected).toHaveLength(1);
    // The turn continued past the bad call and the model answered.
    const answer = events
      .filter((e): e is Extract<UiEvent, { kind: "text" }> => e.kind === "text")
      .map(e => e.delta)
      .join("");
    expect(answer).toContain("Recovered answer.");
  });
});

/** Build a native Gemma tool-call block: `<|tool_call>call:NAME{BODY}<tool_call|>`. */
function gemmaCall(name: string, body: string): string {
  return `<|tool_call>call:${name}{${body}}<tool_call|>`;
}

function mockLegacyFallback(responses: string[]): void {
  let call = 0;
  mocks.streamChat.mockImplementation(async function* (): AsyncGenerator<{ kind: "text"; text: string }, void, void> {
    if (call++ === 0) throw new mocks.NativeToolsUnsupportedError("tools param requires --jinja flag");
    yield { kind: "text", text: responses[Math.min(call - 2, responses.length - 1)] };
  });
}

function newRecord(): ChatRecord {
  return {
    id: "123e4567-e89b-42d3-a456-426614174000",
    workspaceRoot: "/tmp/workspace",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    title: "New chat",
    toolCallingMode: "compat-gemma4",
    mode: "act",
    reasoningEffort: "default",
    messages: [],
    totalTokens: 0
  };
}

describe("live tool permissions", () => {
  const cases = [
    { name: "read_file", setting: "autoapproveReads", args: () => ({ path: "input.txt" }) },
    { name: "create_file", setting: "autoapproveWrites", args: (index: number) => ({ path: `output-${index}.txt`, content: "created\n" }) },
    { name: "run_command", setting: "autoapproveCommands", args: () => ({ command: "npm test" }) }
  ] as const;
  let workspaceRoot: string;
  let session: ChatSession | undefined;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "locality-live-permissions-"));
    await fs.writeFile(path.join(workspaceRoot, "input.txt"), "input\n");
  });

  afterEach(async () => {
    await session?.shutdown();
    session = undefined;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  async function setup(tool: typeof cases[number], calls: number, beforeCall?: (index: number) => void) {
    mocks.settings[tool.setting] = false;
    const proposals = Array.from({ length: calls }, () => {
      let resolve!: (event: Extract<UiEvent, { kind: "toolCallProposed" }>) => void;
      const promise = new Promise<Extract<UiEvent, { kind: "toolCallProposed" }>>(res => { resolve = res; });
      return { promise, resolve };
    });
    let callIndex = 0;
    let proposalIndex = 0;
    mocks.streamChat.mockImplementation(async function* () {
      const index = callIndex++;
      if (index < calls) {
        beforeCall?.(index);
        yield { kind: "toolCall", name: tool.name, argsJson: JSON.stringify(tool.args(index)), id: `live-${index}` };
      } else yield { kind: "text", text: "Done." };
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never, workspaceRoot, record,
      emit: event => {
        events.push(event);
        if (event.kind === "toolCallProposed") proposals[proposalIndex++].resolve(event);
      }
    });
    return { session, record, events, proposed: (index: number) => proposals[index].promise };
  }

  it.each(cases)("applies changes immediately within a turn for $name", async tool => {
    const fixture = await setup(tool, 4, index => {
      if (index === 3) mocks.settings[tool.setting] = false;
    });
    const turn = fixture.session.sendUserMessage("repeat the action");
    const first = await fixture.proposed(0);
    expect(first.approvalRequired).toBe(true);
    fixture.session.approve(first.toolId, true);
    const waiting = await fixture.proposed(1);
    expect(waiting.approvalRequired).toBe(true);
    await mocks.updateSetting(tool.setting, true);
    expect((await fixture.proposed(2)).approvalRequired).toBe(false);
    const afterRevocation = await fixture.proposed(3);
    expect(afterRevocation.approvalRequired).toBe(true);
    fixture.session.approve(afterRevocation.toolId, true);
    await turn;
    expect(fixture.record.messages.filter(message => message.role === "tool").map(message => message.toolCall?.status))
      .toEqual(["executed", "executed", "executed", "executed"]);
  });

  it.each(cases)("refuses $name when its category is disabled before proposal or during approval", async tool => {
    const key = tool.name === "read_file" ? "readToolsEnabled" : tool.name === "create_file" ? "editToolsEnabled" : "commandToolsEnabled";
    const fixture = await setup(tool, 2);
    const turn = fixture.session.sendUserMessage("perform the action");
    const first = await fixture.proposed(0);
    await mocks.updateSetting(key, false);
    fixture.session.approve(first.toolId, true);
    const second = await fixture.proposed(1);
    expect(second).toMatchObject({ category: "unknown", approvalRequired: false });
    await turn;
    const results = fixture.record.messages.filter(message => message.role === "tool");
    expect(results[0].content).toContain("disabled or is no longer available");
    expect(results[1].toolCall?.status).toBe("rejected");
    expect(mocks.startCommand).not.toHaveBeenCalled();
    expect(mocks.streamChat.mock.calls[1][1].tools.map((item: { function: { name: string } }) => item.function.name)).not.toContain(tool.name);
    if (tool.name === "create_file") await expect(fs.stat(path.join(workspaceRoot, "output-0.txt"))).rejects.toThrow();
    if (tool.name === "read_file") expect(results.some(message => String(message.content).includes("1\tinput"))).toBe(false);
  });

  it.each(cases)("saves auto-approval and accepts the current $name", async tool => {
    const fixture = await setup(tool, 2);
    const turn = fixture.session.sendUserMessage("repeat the action");
    const first = await fixture.proposed(0);
    await fixture.session.approveFutureTools(first.toolId);
    expect(mocks.updateSetting).toHaveBeenCalledWith(tool.setting, true, 1);
    expect(mocks.settings[tool.setting]).toBe(true);
    expect((await fixture.proposed(1)).approvalRequired).toBe(false);
    await turn;
    expect(fixture.record.messages.filter(message => message.role === "tool").map(message => message.toolCall?.status))
      .toEqual(["executed", "executed"]);
  });

  it.each(cases)("reports rejection of $name and lets the model continue", async tool => {
    const fixture = await setup(tool, 1);
    const turn = fixture.session.sendUserMessage("perform the action");
    const first = await fixture.proposed(0);
    fixture.session.approve(first.toolId, false);
    await turn;
    expect(mocks.streamChat).toHaveBeenCalledTimes(2);
    expect(mocks.streamChat.mock.calls[1][1].messages).toContainEqual(expect.objectContaining({
      role: "tool", tool_call_id: "live-0", content: expect.stringContaining("[rejected by user]")
    }));
    expect(fixture.record.messages.filter(message => message.role === "tool").map(message => message.toolCall?.status))
      .toEqual(["rejected"]);
    expect(fixture.events.some(event => event.kind === "abort")).toBe(false);
    expect(fixture.events).toContainEqual(expect.objectContaining({ kind: "text", delta: "Done." }));
    expect(mocks.startCommand).not.toHaveBeenCalled();
    if (tool.name === "create_file") await expect(fs.stat(path.join(workspaceRoot, "output-0.txt"))).rejects.toThrow();
  });

  it.each(cases)("still stops when Stop is pressed immediately after rejecting $name", async tool => {
    const fixture = await setup(tool, 1);
    const turn = fixture.session.sendUserMessage("perform the action");
    const first = await fixture.proposed(0);
    fixture.session.approve(first.toolId, false);
    fixture.session.cancel();
    await turn;
    expect(mocks.streamChat).toHaveBeenCalledOnce();
    expect(fixture.events).not.toContainEqual(expect.objectContaining({ kind: "text", delta: "Done." }));
    expect(mocks.startCommand).not.toHaveBeenCalled();
  });

  it("keeps approval pending when the setting cannot be saved and ignores stale tool IDs", async () => {
    const fixture = await setup(cases[0], 1);
    await fixture.session.approveFutureTools("stale");
    expect(mocks.updateSetting).not.toHaveBeenCalled();
    const turn = fixture.session.sendUserMessage("read the file");
    const first = await fixture.proposed(0);
    mocks.updateSetting.mockRejectedValueOnce(new Error("settings are read-only"));
    await fixture.session.approveFutureTools(first.toolId);
    expect(fixture.record.messages.some(message => message.role === "tool")).toBe(false);
    expect(fixture.events).toContainEqual({ kind: "notice", text: "Could not enable auto-approval: settings are read-only" });
    fixture.session.approve(first.toolId, true);
    await turn;
    expect(mocks.settings.autoapproveReads).toBe(false);
  });

  it("does not execute a tool cancelled while its permission is being saved", async () => {
    const fixture = await setup(cases[2], 1);
    const turn = fixture.session.sendUserMessage("run tests");
    const first = await fixture.proposed(0);
    let finishSave!: () => void;
    mocks.updateSetting.mockImplementationOnce(() => new Promise<void>(resolve => { finishSave = resolve; }));
    const saving = fixture.session.approveFutureTools(first.toolId);
    fixture.session.cancel();
    finishSave();
    await saving;
    await turn;
    expect(mocks.startCommand).not.toHaveBeenCalled();
  });
});

describe("length-limited generation recovery", () => {
  function recoveryRecord(): ChatRecord {
    const record = newRecord();
    record.title = "Existing chat";
    record.messages = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `history ${index}`, ts: index + 1
    }));
    return record;
  }

  it.each(["native", "legacy"])("discards unfinished %s output, compacts, and continues the same turn", async protocol => {
    mocks.settings.autoCompact = true;
    const record = recoveryRecord();
    record.toolCallingMode = protocol === "native" ? "native" : "compat-gemma4";
    const events: UiEvent[] = [];
    let requestCount = 0;
    let generation = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: { messages: unknown[] }) {
      if (requestCount++ === 0 && protocol === "legacy") throw new mocks.NativeToolsUnsupportedError("requires --jinja");
      if (generation++ === 0) {
        yield { kind: "thought", text: "UNFINISHED_THOUGHT_SENTINEL" };
        yield { kind: "text", text: "UNFINISHED_TEXT_SENTINEL" };
        if (protocol === "native") {
          yield { kind: "toolCallProgress", name: "create_file", path: "unfinished.ts", contentBytes: 5, contentLines: 1 };
        } else {
          yield { kind: "text", text: '<|tool_call>call:write_file{path:<|"|>unfinished.ts<|"|>,content:<|"|>partial' };
        }
        throw new mocks.GenerationLengthError("Generation limit");
      }
      const prompt = JSON.stringify(request.messages);
      expect(prompt).toContain("CURRENT_REQUEST_SENTINEL");
      expect(prompt).toContain("[context summary]");
      expect(prompt).toContain("[harness recovery]");
      expect(prompt).not.toContain("UNFINISHED_");
      expect(prompt).not.toContain("unfinished.ts");
      yield { kind: "text", text: "Completed answer" };
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const session = new ChatSession({ storage: { save: vi.fn() } as never, workspaceRoot: "/tmp/workspace", record, emit: e => events.push(e) });
    await session.sendUserMessage("CURRENT_REQUEST_SENTINEL");

    expect(generation).toBe(2);
    expect(events).toContainEqual(expect.objectContaining({ kind: "compactEnd", status: "executed" }));
    const progress = events.find(event => event.kind === "toolCallProgress");
    expect(progress?.kind).toBe("toolCallProgress");
    expect(events).toContainEqual(expect.objectContaining({
      kind: "responseDiscarded", textChars: "UNFINISHED_TEXT_SENTINEL".length,
      thoughtChars: "UNFINISHED_THOUGHT_SENTINEL".length,
      toolIds: [progress?.kind === "toolCallProgress" ? progress.toolId : "missing"]
    }));
    expect(events.some(event => event.kind === "abort" || event.kind === "toolCallProposed" || event.kind === "toolCallResolved")).toBe(false);
    expect(events.filter(event => event.kind === "turnEnd")).toEqual([
      expect.objectContaining({ messageTs: expect.any(Number) })
    ]);
    expect(record.messages.at(-1)?.content).toBe("Completed answer");
    expect(JSON.stringify(record.messages)).not.toContain("UNFINISHED_");
    expect(JSON.stringify(mocks.complete.mock.calls)).not.toContain("UNFINISHED_");
  });

  it("preserves a completed file write and its tool result through recovery", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "locality-recovery-"));
    try {
      mocks.settings.autoCompact = true;
      mocks.settings.autoapproveWrites = true;
      const record = recoveryRecord();
      record.toolCallingMode = "native";
      const events: UiEvent[] = [];
      let pass = 0;
      mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: { messages: { role: string; content: string; tool_call_id?: string }[] }) {
        if (pass++ === 0) {
          yield { kind: "toolCall", name: "create_file", id: "completed-write", argsJson: JSON.stringify({ path: "done.ts", content: "export const done = true;" }) };
        } else if (pass === 2) {
          yield { kind: "thought", text: "unfinished reasoning" };
          throw new mocks.GenerationLengthError("Generation limit");
        } else {
          expect(request.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "completed-write" }));
          yield { kind: "text", text: "Done" };
        }
      });
      const { ChatSession } = await import("../src/chat/session.js");
      const session = new ChatSession({ storage: { save: vi.fn() } as never, workspaceRoot: ws, record, emit: e => events.push(e) });
      await session.sendUserMessage("Create done.ts");
      expect(await fs.readFile(path.join(ws, "done.ts"), "utf8")).toBe("export const done = true;");
      expect(record.messages.filter(message => message.role === "tool")).toHaveLength(1);
      expect(events.filter(event => event.kind === "toolCallProposed")).toHaveLength(1);
      expect(events).toContainEqual(expect.objectContaining({ kind: "fileChanges", changes: [expect.objectContaining({ path: "done.ts" })] }));
      expect(events.some(event => event.kind === "abort")).toBe(false);
    } finally { await fs.rm(ws, { recursive: true, force: true }); }
  });

  it.each(["auto-disabled", "compaction-failed", "cancelled", "cancelled-before-summary", "repeated-limit"])("stops safely on %s", async outcome => {
    mocks.settings.autoCompact = outcome !== "auto-disabled";
    const record = recoveryRecord();
    record.toolCallingMode = "native";
    const events: UiEvent[] = [];
    mocks.streamChat.mockImplementation(async function* () {
      yield { kind: "thought", text: "unfinished reasoning" };
      throw new mocks.GenerationLengthError("Generation limit");
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const session = new ChatSession({ storage: { save: vi.fn() } as never, workspaceRoot: "/tmp/workspace", record, emit: e => events.push(e) });
    if (outcome === "compaction-failed") mocks.complete.mockRejectedValue(new Error("Summary failed"));
    if (outcome === "cancelled") mocks.complete.mockImplementation(async (_endpoint, _request, signal: AbortSignal) => {
      session.cancel();
      signal.throwIfAborted();
      return "unreachable";
    });
    if (outcome === "cancelled-before-summary") mocks.fetchServerContextSize.mockImplementation(async () => {
      if (events.some(event => event.kind === "responseDiscarded")) session.cancel();
      return 32768;
    });
    await session.sendUserMessage("Continue");
    expect(mocks.streamChat).toHaveBeenCalledTimes(outcome === "repeated-limit" ? 2 : 1);
    expect(events.filter(event => event.kind === "compactStart")).toHaveLength(outcome === "auto-disabled" || outcome === "cancelled-before-summary" ? 0 : 1);
    expect(events).toContainEqual({ kind: "abort", reason: outcome.startsWith("cancelled") ? "Cancelled." : "Generation limit", messageTs: expect.any(Number) });
    expect(events.filter(event => event.kind === "turnEnd")).toEqual([]);
    expect(record.messages.at(-1)?.interruption).toBeDefined();
    expect(record.contextMessages?.at(-1)?.role).toBe("user");
  });

  it("retries once without compaction when only a short conversation exists", async () => {
    mocks.settings.autoCompact = true;
    const record = newRecord();
    record.title = "Existing title";
    record.toolCallingMode = "native";
    const events: UiEvent[] = [];
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) throw new mocks.GenerationLengthError("Generation limit");
      yield { kind: "text", text: "Concise answer" };
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const session = new ChatSession({ storage: { save: vi.fn() } as never, workspaceRoot: "/tmp/workspace", record, emit: e => events.push(e) });
    await session.sendUserMessage("Answer briefly");
    expect(mocks.streamChat).toHaveBeenCalledTimes(2);
    expect(events.some(event => event.kind === "compactStart" || event.kind === "abort")).toBe(false);
    expect(record.messages.at(-1)?.content).toBe("Concise answer");
  });
});

describe("separate transcript and model context", () => {
  it.each(["complete", "cancel", "error"])("attributes an idle manual compaction to the next prompt, including %s", async outcome => {
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.toolCallingMode = "native";
    record.title = "Existing chat";
    record.messages = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `history ${index}`, ts: index + 1
    }));
    const events: UiEvent[] = [];
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace", record, emit: event => events.push(event)
    });
    await session.compactNow();
    expect(mocks.streamChat).not.toHaveBeenCalled();
    const compacted = events.find(event => event.kind === "compactEnd");
    expect(compacted).toMatchObject({ status: "executed" });
    expect(contextActivityIds(events)).toEqual([]);
    if (compacted?.kind !== "compactEnd") throw new Error("Missing compaction");
    events.length = 0;
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint: string, request: { onResponseAccepted?: () => void }) {
      request.onResponseAccepted?.();
      pass++;
      const needsIngestion = pass === 1 || outcome !== "complete";
      if (needsIngestion) {
        expect(contextActivityIds(events)).toEqual([compacted.compactId]);
        expect(events).toContainEqual(compacted);
      }
      yield { kind: "promptProgress", processedTokens: 128, totalTokens: 2048 };
      expect(events).not.toContainEqual({ kind: "contextActivity", activityIds: [] });
      if (pass === 1 && outcome !== "complete") {
        if (outcome === "cancel") session.cancel();
        throw new Error(outcome === "cancel" ? "Cancelled" : "Server disconnected");
      }
      yield { kind: "promptProgress", processedTokens: 2048, totalTokens: 2048 };
      if (needsIngestion) expect(events).toContainEqual({ kind: "contextActivity", activityIds: [] });
      yield { kind: "text", text: "Answer" };
    });
    await session.sendUserMessage("Continue");
    expect(events).toContainEqual({ kind: "contextActivity", activityIds: [] });
    expect(events).not.toContainEqual({ kind: "turnPreparing", reason: "context" });
    if (outcome !== "complete") expect(events).toContainEqual({ kind: "abort", reason: outcome === "cancel" ? "Cancelled" : "Server disconnected", messageTs: expect.any(Number) });
    else expect(events.some(event => event.kind === "abort")).toBe(false);

    events.length = 0;
    await session.sendUserMessage("Continue again");
    expect(pass).toBe(2);
    expect(events.some(event => event.kind === "abort")).toBe(false);
    expect(events).not.toContainEqual({ kind: "turnPreparing", reason: "context" });
    expect(events.some(event => event.kind === "contextActivity" && event.activityIds.includes(compacted.compactId))).toBe(outcome !== "complete");
  });

  it("saves original messages through compaction and reopens using only compacted context", async () => {
    mocks.settings.toolCallingMode = "native";
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.messages = [
      { role: "user", content: "ORIGINAL_REQUEST_SENTINEL", ts: 1 },
      ...Array.from({ length: 6 }, (_, i) => ({ role: "assistant" as const, content: `answer ${i}`, ts: i + 2 }))
    ];
    const original = structuredClone(record.messages);
    let saved: ChatRecord | undefined;
    const storage = { save: vi.fn(async (rec: ChatRecord) => { saved = structuredClone(rec); }) };
    const session = new ChatSession({ storage: storage as never, workspaceRoot: "/tmp/workspace", record, emit: () => undefined });
    await session.compactNow();
    expect(saved!.messages).toMatchObject(original);
    expect(saved!.contextMessages![0].role).toBe("system");
    const reopened = new ChatSession({ storage: storage as never, workspaceRoot: "/tmp/workspace", record: saved!, emit: () => undefined });
    mocks.streamChat.mockImplementation(async function* () { yield { kind: "text", text: "new answer" }; });
    await reopened.sendUserMessage("new request");
    const request = mocks.streamChat.mock.calls[0][1];
    expect(JSON.stringify(request.messages)).not.toContain("ORIGINAL_REQUEST_SENTINEL");
    expect(JSON.stringify(request.messages)).toContain("new request");
    expect(saved!.messages[0].content).toBe("ORIGINAL_REQUEST_SENTINEL");
    expect(saved!.messages.at(-1)?.content).toBe("new answer");
    expect(saved!.contextMessages!.at(-1)?.content).toBe("new answer");
  });

  it("discards a stale summary when editing an archived user message", async () => {
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.messages = [
      { role: "user", content: "original", ts: 1 },
      { role: "assistant", content: "obsolete response", ts: 2 },
      { role: "user", content: "future request", ts: 3 }
    ];
    record.contextMessages = [{ role: "system", content: "[context summary] obsolete response and future request", ts: 4 }];
    mocks.streamChat.mockImplementation(async function* () { yield { kind: "text", text: "revised answer" }; });
    const session = new ChatSession({
      storage: { save: vi.fn(async () => undefined) } as never,
      workspaceRoot: "/tmp/workspace", record, emit: () => undefined
    });
    await session.editUserMessage(1, "revised request");
    const request = JSON.stringify(mocks.streamChat.mock.calls[0][1].messages);
    expect(request).toContain("revised request");
    expect(request).not.toContain("obsolete response");
    expect(request).not.toContain("future request");
    expect(record.contextMessages).toBeUndefined();
    expect(record.messages.map(message => message.content)).toEqual(["revised request", "revised answer"]);
  });
});


describe("delete user messages", () => {
  it("persists truncation, removes unused attachments, and discards stale compacted context", async () => {
    const { ChatStorage } = await import("../src/chat/storage.js");
    const { ChatSession } = await import("../src/chat/session.js");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "locality-delete-messages-"));
    let session: ChatSession | undefined;
    try {
      const storage = new ChatStorage(dir, path.join(dir, "chats"));
      const record = storage.newRecord("native");
      const retained = await storage.importAttachmentBytes(record.id, "keep.txt", Buffer.from("KEPT_ATTACHMENT"));
      const removed = await storage.importAttachmentBytes(record.id, "remove.txt", Buffer.from("REMOVED_ATTACHMENT"));
      record.messages = [
        { role: "user", content: "Keep this request", ts: 1, attachments: [retained], tokens: 10 },
        { role: "assistant", content: "Keep this answer", ts: 2, tokens: 20 },
        { role: "user", content: "REMOVED_REQUEST", ts: 3, attachments: [removed, retained], tokens: 10 },
        { role: "tool", content: "REMOVED_TOOL_RESULT", ts: 4 },
        { role: "assistant", content: "REMOVED_ANSWER", ts: 5 }
      ];
      record.contextMessages = [{ role: "system", content: "[context summary] REMOVED_SUMMARY", ts: 6 }];
      record.totalTokens = 100;
      record.planning = true;
      record.pendingPlanMessageTs = 5;
      record.memoryCreations = [2, 5].map(messageTs => ({ messageTs, status: "created", text: "Memory", generatedAt: 7 }));
      await storage.save(record);
      const events: UiEvent[] = [];
      session = new ChatSession({ storage, workspaceRoot: dir, record, emit: event => events.push(event) });
      expect(await session.deleteUserMessage(3)).toBe(true);
      const loaded = (await storage.load(record.id))!;
      expect(loaded.messages.map(message => message.ts)).toEqual([1, 2]);
      expect(loaded.contextMessages).toBeUndefined();
      expect(loaded.planning).toBeUndefined();
      expect(loaded.pendingPlanMessageTs).toBeUndefined();
      expect(loaded.totalTokens).toBe(30);
      expect(loaded.memoryCreations?.map(creation => creation.messageTs)).toEqual([2]);
      await expect(fs.stat(storage.attachmentPath(record.id, removed))).rejects.toThrow();
      expect(await fs.readFile(storage.attachmentPath(record.id, retained), "utf8")).toBe("KEPT_ATTACHMENT");
      expect(events).toContainEqual(expect.objectContaining({ kind: "chatLoaded", record: expect.objectContaining({ messages: loaded.messages }) }));
      expect(mocks.streamChat).not.toHaveBeenCalled();
      expect(mocks.complete).not.toHaveBeenCalled();
      expect(session.isTurnActive()).toBe(false);
      await session.shutdown();

      session = new ChatSession({ storage, workspaceRoot: dir, record: loaded, emit: () => undefined });
      mocks.streamChat.mockImplementation(async function* () { yield { kind: "text", text: "New answer" }; });
      await session.sendUserMessage("New request");
      const request = JSON.stringify(mocks.streamChat.mock.calls[0][1].messages);
      expect(request).toContain("Keep this request");
      expect(request).toContain("Keep this answer");
      expect(request).not.toContain("REMOVED_");
    } finally {
      await session?.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])("deletes the selected user message including steering=%s", async steering => {
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.messages = [
      { role: "user", content: "First request", ts: 1 },
      { role: "assistant", content: "First answer", ts: 2 },
      { role: "user", content: "Guidance", steering, ts: 3 },
      { role: "assistant", content: "Later answer", ts: 4 }
    ];
    const save = vi.fn(async () => undefined);
    const session = new ChatSession({ storage: { save } as never, workspaceRoot: "/tmp/workspace", record, emit: () => undefined });
    expect(await session.deleteUserMessage(3)).toBe(true);
    expect(record.messages.map(message => message.ts)).toEqual([1, 2]);
    expect(await session.deleteUserMessage(1)).toBe(true);
    expect(record.messages).toEqual([]);
    expect(record.totalTokens).toBe(0);
    expect(save).toHaveBeenCalledTimes(2);
    await session.shutdown();
  });

  it("rejects invalid targets and deletion during an active response", async () => {
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.messages = [{ role: "user", content: "Keep", ts: 1 }, { role: "assistant", content: "Answer", ts: 2 }];
    const save = vi.fn(async () => undefined);
    const session = new ChatSession({ storage: { save } as never, workspaceRoot: "/tmp/workspace", record, emit: () => undefined });
    expect(await session.deleteUserMessage(2)).toBe(false);
    expect(await session.deleteUserMessage(99)).toBe(false);
    expect(save).not.toHaveBeenCalled();
    let finish!: () => void;
    mocks.streamChat.mockImplementation(async function* () {
      await new Promise<void>(resolve => { finish = resolve; });
      yield { kind: "text", text: "Done" };
    });
    const turn = session.sendUserMessage("Next");
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(await session.deleteUserMessage(1)).toBe(false);
    expect(record.messages[0].content).toBe("Keep");
    finish();
    await turn;
    await session.shutdown();
    expect(await session.deleteUserMessage(1)).toBe(false);
  });

  it("restores the transcript and keeps attachments when saving fails", async () => {
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    record.messages = [{ role: "user", content: "Keep", ts: 1 }, { role: "assistant", content: "Answer", ts: 2 }];
    record.contextMessages = [{ role: "system", content: "Summary", ts: 3 }];
    record.pendingPlanMessageTs = 2;
    record.planning = true;
    const original = structuredClone(record);
    const events: UiEvent[] = [];
    const storage = { save: vi.fn().mockRejectedValue(new Error("Disk full")), deleteAttachment: vi.fn() };
    const session = new ChatSession({ storage: storage as never, workspaceRoot: "/tmp/workspace", record, emit: event => events.push(event) });
    expect(await session.deleteUserMessage(1)).toBe(false);
    expect(record).toEqual(original);
    expect(storage.deleteAttachment).not.toHaveBeenCalled();
    expect(events).toContainEqual({ kind: "notice", text: "Could not save the chat. No messages were deleted." });
    expect(events.some(event => event.kind === "chatLoaded")).toBe(false);
    expect(session.isTurnActive()).toBe(false);
    await session.shutdown();
  });
});

describe("workspace memory tools", () => {
  it.each([
    ["native", "act"], ["native", "plan"], ["native", "review"],
    ["compat-qwen3", "act"], ["compat-qwen3", "plan"], ["compat-qwen3", "review"]
  ] as const)("searches then recalls within the active workspace in %s/%s", async (profile, mode) => {
    mocks.settings.memoryEnabled = true;
    mocks.settings.toolCallingMode = profile;
    const { ChatStorage } = await import("../src/chat/storage.js");
    const { transcriptRevision, searchMemories } = await import("../src/chat/memory.js");
    const { ChatSession } = await import("../src/chat/session.js");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "locality-memory-tools-"));
    try {
      const storage = new ChatStorage(path.join(dir, "workspace"), path.join(dir, "chats"));
      const neighbor = new ChatStorage(path.join(dir, "workspace-other"), path.join(dir, "chats"));
      const source = storage.newRecord(profile);
      source.title = "Parser decisions";
      source.messages = [{ role: "user", content: "Parser design", ts: 1 }];
      source.memory = { text: "Parser LOCAL_CONTENT_SENTINEL", sourceRevision: transcriptRevision(source), generatedAt: Date.UTC(2026, 8, 11, 12, 30), manual: false, enabled: true };
      await storage.save(source);
      const outside = neighbor.newRecord(profile);
      outside.title = "Parser outside";
      outside.messages = [{ role: "user", content: "Parser", ts: 1 }];
      outside.memory = { ...source.memory, text: "Parser OTHER_WORKSPACE_SENTINEL", sourceRevision: transcriptRevision(outside) };
      await neighbor.save(outside);
      const record = storage.newRecord(profile);
      record.mode = mode;
      const events: UiEvent[] = [];
      let step = 0;
      let selected: { name: string; id: string };
      const requests: { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] }[] = [];
      mocks.streamChat.mockImplementation(async function* (_endpoint, request) {
        requests.push(request);
        if (profile !== "native" && request.tools) throw new mocks.NativeToolsUnsupportedError("tools param requires --jinja flag");
        const call = (name: string, args: object) => profile === "native"
          ? { kind: "toolCall", name, argsJson: JSON.stringify(args), id: `memory_call_${step}` }
          : { kind: "text", text: `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>` };
        if (step++ === 0) {
          expect(JSON.stringify(request.messages)).not.toContain("LOCAL_CONTENT_SENTINEL");
          yield call("search_memories", { query: "parser" });
        } else if (step === 2) {
          const result = JSON.parse(record.messages.filter(m => m.role === "tool").at(-1)!.content);
          expect(events.filter(e => e.kind === "memoriesUsed").every(e => e.memories.length === 0)).toBe(true);
          expect(result.memories).toHaveLength(1);
          expect(result.memories[0]).toMatchObject({ name: source.title, date: "2026-09-11T12:30Z" });
          expect(JSON.stringify(result)).not.toContain("LOCAL_CONTENT_SENTINEL");
          selected = result.memories[0];
          yield call("recall_memory", { name: selected.name, id: selected.id });
        } else {
          yield { kind: "text", text: "Done." };
        }
      });
      const session = new ChatSession({ storage, workspaceRoot: record.workspaceRoot, record, emit: e => events.push(e) });
      await session.refreshMemoryVisibility();
      expect(events.at(-1)).toEqual({ kind: "memoriesUsed", memories: [] });
      await session.sendUserMessage("Explain the parser");
      const result = JSON.parse(record.messages.filter(m => m.role === "tool").at(-1)!.content);
      expect(result).toMatchObject({ name: source.title, contents: source.memory.text, date: "2026-09-11T12:30Z" });
      for (const request of requests) {
        expect(JSON.stringify(request.messages.filter(m => m.role === "system"))).not.toContain("LOCAL_CONTENT_SENTINEL");
        expect(JSON.stringify(request)).not.toContain("OTHER_WORKSPACE_SENTINEL");
      }
      const outsideMatch = searchMemories("parser", [outside], record.id).memories[0];
      expect(result.id).not.toBe(outsideMatch.id);
      expect(events.filter(e => e.kind === "toolCallProposed")).toHaveLength(2);
      expect(events.filter(e => e.kind === "toolCallProposed").every(e => e.approvalRequired === false)).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ kind: "memoriesUsed", memories: [expect.objectContaining({ text: source.memory.text })] }));
      const saved = (await storage.load(record.id))!;
      expect(saved.recalledMemories).toHaveLength(1);
      const reopened = new ChatSession({ storage, workspaceRoot: saved.workspaceRoot, record: saved, emit: e => events.push(e) });
      await reopened.refreshMemoryVisibility();
      expect(events.at(-1)).toMatchObject({ kind: "memoriesUsed", memories: [{ sourceId: source.id }] });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it.each(["search_memories", "recall_memory"])("does not expose or execute %s while disabled", async name => {
    const { ChatSession } = await import("../src/chat/session.js");
    const records = vi.fn();
    let step = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint, request) {
      expect(request.tools.map((tool: { function: { name: string } }) => tool.function.name)).not.toContain(name);
      expect(request.messages[0].content).not.toContain("search_memories");
      expect(request.messages[0].content).not.toContain("recall_memory");
      if (step++ === 0) yield { kind: "toolCall", name, argsJson: name === "search_memories" ? '{"query":"parser"}' : '{"name":"Parser","id":"123"}', id: "disabled_call" };
      else yield { kind: "text", text: "Done." };
    });
    const record = newRecord();
    const session = new ChatSession({ storage: { save: vi.fn(), records } as never, workspaceRoot: "/tmp/workspace", record, emit: () => undefined });
    await session.sendUserMessage("check");
    expect(records).not.toHaveBeenCalled();
    expect(record.messages.find(m => m.role === "tool")?.toolCall?.status).toBe("rejected");
  });

  it("rechecks the switch after awaiting read approval", async () => {
    mocks.settings.memoryEnabled = true;
    mocks.settings.autoapproveReads = false;
    const { ChatSession } = await import("../src/chat/session.js");
    const records = vi.fn();
    let step = 0;
    let propose: (id: string) => void = () => undefined;
    const proposed = new Promise<string>(resolve => { propose = resolve; });
    mocks.streamChat.mockImplementation(async function* () {
      if (step++ === 0) yield { kind: "toolCall", name: "search_memories", argsJson: '{"query":"parser"}', id: "pending_search" };
      else yield { kind: "text", text: "Done." };
    });
    const record = newRecord();
    const session = new ChatSession({ storage: { save: vi.fn(), records } as never, workspaceRoot: "/tmp/workspace", record,
      emit: e => { if (e.kind === "toolCallProposed") propose(e.toolId); } });
    const turn = session.sendUserMessage("check");
    const toolId = await proposed;
    mocks.settings.memoryEnabled = false;
    session.approve(toolId, true);
    await turn;
    expect(records).not.toHaveBeenCalled();
    expect(record.messages.find(m => m.role === "tool")?.content).toContain("Workspace memories are disabled");
  });
});

describe("workspace image viewing", () => {
  it.each([
    ["image.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])],
    ["photo.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1])]
  ])("lists and views %s, retaining pixels after the original file is removed and the chat reloads", async (name, mime, bytes) => {
    const { ChatSession } = await import("../src/chat/session.js");
    const { ChatStorage, VISION_TOKEN_RESERVE } = await import("../src/chat/storage.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "locality-view-image-"));
    try {
      const storage = new ChatStorage(root, path.join(root, "chats"));
      const record = storage.newRecord("native");
      await fs.writeFile(path.join(root, name), bytes);
      let pass = 0;
      mocks.streamChat.mockImplementation(async function* () {
        if (pass++ === 0) yield { kind: "toolCall", name: "list_dir", argsJson: '{"path":"."}', id: "list" };
        else if (pass === 2) yield { kind: "toolCall", name: "view_image", argsJson: JSON.stringify({ path: name }), id: "view" };
        else yield { kind: "text", text: "Image inspected." };
      });
      const events: UiEvent[] = [];
      const session = new ChatSession({ storage, workspaceRoot: root, record, emit: event => events.push(event) });
      await session.sendUserMessage("Inspect the image in this directory");
      expect(mocks.streamChat).toHaveBeenCalledTimes(3);
      const request = mocks.streamChat.mock.calls[2][1];
      expect(request.tools.some((tool: { function: { name: string } }) => tool.function.name === "view_image")).toBe(true);
      const imageMessage = request.messages.find((message: { content: unknown }) => Array.isArray(message.content));
      expect(imageMessage.content).toContainEqual({ type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } });
      expect(request.messages.find((message: { role: string; name?: string }) => message.role === "tool" && message.name === "view_image").content).toContain(`Image loaded: ${name}`);
      const stored = record.messages.find(message => message.toolCall?.name === "view_image")!;
      expect(stored.toolCall?.status).toBe("executed");
      expect(stored.tokens).toBeGreaterThanOrEqual(VISION_TOKEN_RESERVE);
      expect(stored.attachments).toHaveLength(1);
      expect(events.find(event => event.kind === "toolCallProposed" && event.toolName === "view_image")).toMatchObject({ category: "read", approvalRequired: false });
      await fs.unlink(path.join(root, name));
      const restored = (await storage.load(record.id))!;
      mocks.streamChat.mockClear();
      const reloaded = new ChatSession({ storage, workspaceRoot: root, record: restored, emit: vi.fn() });
      await reloaded.sendUserMessage("Look at the same image again");
      expect(mocks.streamChat.mock.calls[0][1].messages).toContainEqual(imageMessage);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("omits and refuses view_image when vision support is absent", async () => {
    mocks.supportsVision = false;
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (pass++ === 0) yield { kind: "toolCall", name: "view_image", argsJson: '{"path":"image.png"}', id: "view" };
      else yield { kind: "text", text: "Unavailable." };
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const storage = { save: vi.fn(), importAttachment: vi.fn() };
    const record = newRecord();
    const session = new ChatSession({ storage: storage as never, workspaceRoot: "/tmp/workspace", record, emit: vi.fn() });
    await session.sendUserMessage("Inspect an image");
    expect(mocks.streamChat.mock.calls[0][1].tools.some((tool: { function: { name: string } }) => tool.function.name === "view_image")).toBe(false);
    expect(storage.importAttachment).not.toHaveBeenCalled();
    expect(record.messages.find(message => message.toolCall?.name === "view_image")?.toolCall?.status).not.toBe("executed");
  });

  it("blocks existing image attachments before inference when the connected model loses vision", async () => {
    mocks.supportsVision = false;
    const { ChatSession } = await import("../src/chat/session.js");
    const events: UiEvent[] = [];
    const storage = { save: vi.fn(), attachmentDataUrl: vi.fn() };
    const session = new ChatSession({ storage: storage as never, workspaceRoot: "/tmp/workspace", record: newRecord(), emit: event => events.push(event) });
    await session.sendUserMessage("Inspect", [{ id: "image", fileName: "image.png", mimeType: "image/png", extension: "png", byteLength: 10 }]);
    expect(mocks.streamChat).not.toHaveBeenCalled();
    expect(storage.attachmentDataUrl).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ kind: "abort", reason: expect.stringContaining("vision support") }));
  });

  it.each(["../outside.png", "escape.png"])("refuses a workspace escape via %s", async imagePath => {
    const { ChatSession } = await import("../src/chat/session.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "locality-image-guard-"));
    try {
      const workspace = path.join(root, "workspace");
      await fs.mkdir(workspace);
      await fs.writeFile(path.join(root, "outside.png"), "outside");
      await fs.symlink(path.join(root, "outside.png"), path.join(workspace, "escape.png"));
      let pass = 0;
      mocks.streamChat.mockImplementation(async function* () {
        if (pass++ === 0) yield { kind: "toolCall", name: "view_image", argsJson: JSON.stringify({ path: imagePath }), id: "view" };
        else yield { kind: "text", text: "Read refused." };
      });
      const storage = { save: vi.fn(), importAttachment: vi.fn() };
      const record = newRecord();
      const session = new ChatSession({ storage: storage as never, workspaceRoot: workspace, record, emit: vi.fn() });
      await session.sendUserMessage("Inspect");
      expect(storage.importAttachment).not.toHaveBeenCalled();
      expect(record.messages.find(message => message.toolCall?.name === "view_image")).toMatchObject({ toolCall: { status: "failed" }, content: expect.stringContaining("outside the workspace") });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});


describe("tool presentation data", () => {
  it("persists a separate display result without sending it to the model", async () => {
    mocks.settings.toolCallingMode = "native";
    let turn = 0;
    mocks.streamChat.mockImplementation(async function* () {
      if (turn++ === 0) yield { kind: "toolCall", name: "run_command", argsJson: '{"command":"echo ok"}', id: "display_test" };
      else yield { kind: "text", text: "done" };
    });
    const { ChatSession } = await import("../src/chat/session.js");
    const record = newRecord();
    const events: UiEvent[] = [];
    const session = new ChatSession({ storage: { save: vi.fn(async () => undefined) } as never, workspaceRoot: "/tmp/workspace", record, emit: event => events.push(event) });
    const result = "Complete result for the model";
    const displayResult = "Separate UI-only payload";
    (session as unknown as { features: import("../src/build/contracts.js").FeatureRuntime[] }).features = [{
      tools: ["run_command"], category: () => "command", needsApproval: () => false,
      prepare: async () => ({}), execute: async () => ({ result, displayResult })
    }];
    await session.sendUserMessage("show result");
    expect(record.messages.find(message => message.role === "tool")).toMatchObject({ content: result, toolCall: { displayResult } });
    expect(events).toContainEqual(expect.objectContaining({ kind: "toolCallResolved", status: "executed", resultPreview: displayResult }));
    expect(mocks.streamChat).toHaveBeenCalledTimes(2);
    const prompt = JSON.stringify(mocks.streamChat.mock.calls[1][1].messages);
    expect(prompt).toContain(result);
    expect(prompt).not.toContain(displayResult);
  });
});

describe("steering an active turn", () => {
  let workspaceRoot: string;
  let session: ChatSession;
  let storage: import("../src/chat/storage.js").ChatStorage;
  let record: ChatRecord;
  let events: UiEvent[];

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "locality-steering-"));
    const { ChatStorage } = await import("../src/chat/storage.js");
    const { ChatSession } = await import("../src/chat/session.js");
    storage = new ChatStorage(workspaceRoot, path.join(workspaceRoot, "chats"));
    mocks.settings.toolCallingMode = "native";
    record = storage.newRecord("native");
    events = [];
    session = new ChatSession({ storage, workspaceRoot, record, emit: event => events.push(event) });
  });

  afterEach(async () => {
    await session.shutdown();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it.each(["act", "plan", "review"] as const)("interrupts generation and preserves the %s mode and system prompt", async mode => {
    const requests: import("../src/llm/client.js").ChatCompletionRequest[] = [];
    let requestSignal: AbortSignal | undefined;
    mocks.streamChat.mockImplementation(async function* (_endpoint, request, signal: AbortSignal) {
      requests.push(request);
      if (requests.length === 1) {
        requestSignal = signal;
        yield { kind: "text", text: "Initial approach." };
        await new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Generation interrupted")), { once: true });
        });
      } else {
        yield { kind: "text", text: "Revised approach." };
      }
    });
    const turn = session.sendUserMessage("Work on this", [], mode);
    await vi.waitFor(() => expect(events.some(e => e.kind === "text")).toBe(true));
    session.setMode(mode === "act" ? "review" : "act");
    session.setReasoningEffort("effort:high");
    expect(session.steerUserMessage("Use the smaller change")).toBe(true);
    expect(requestSignal?.aborted).toBe(true);
    await turn;
    expect(requests).toHaveLength(2);
    expect(requests[1].messages[0]).toEqual(requests[0].messages[0]);
    expect(requests[1].tools).toEqual(requests[0].tools);
    expect(requests[1].reasoning_effort).toEqual(requests[0].reasoning_effort);
    expect(requests[1].messages.filter(m => m.role === "system")).toHaveLength(1);
    expect(requests[1].messages.slice(-2)).toEqual([
      expect.objectContaining({ role: "assistant", content: "Initial approach." }),
      expect.objectContaining({ role: "user", content: "Use the smaller change" })
    ]);
    expect(events.filter(e => e.kind === "turnEnd")).toEqual([expect.objectContaining({ mode })]);
    expect(events.some(e => e.kind === "abort")).toBe(false);
    const textEvents = events.filter(e => e.kind === "text");
    const before = textEvents.find(e => e.delta === "Initial approach.")!;
    const after = textEvents.find(e => e.delta === "Revised approach.")!;
    expect(after.messageId).toBe(before.messageId);
    expect(events.filter(e => e.kind === "turnStart")).toHaveLength(1);
    expect(events.find(e => e.kind === "turnEnd")).toMatchObject({ messageId: before.messageId });
    expect((await storage.load(record.id))?.messages.find(m => m.steering)).toMatchObject({
      role: "user", content: "Use the smaller change", steering: true
    });
    expect(record.pendingPlanMessageTs !== undefined).toBe(mode === "plan");
  });

  it("waits for the running tool and skips later calls from the superseded response", async () => {
    mocks.settings.autoapproveCommands = true;
    let finish!: (result: { exitCode: number; stdout: string; stderr: string; truncated: boolean }) => void;
    mocks.runCommand.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const requests: import("../src/llm/client.js").ChatCompletionRequest[] = [];
    mocks.streamChat.mockImplementation(async function* (_endpoint, request) {
      requests.push(request);
      if (requests.length === 1) {
        yield { kind: "thought", text: "Check the workspace first." };
        yield { kind: "toolCall", name: "run_command", argsJson: '{"command":"first"}', id: "first" };
        yield { kind: "toolCall", name: "run_command", argsJson: '{"command":"obsolete"}', id: "obsolete" };
      } else yield { kind: "text", text: "Followed the new guidance." };
    });
    const turn = session.sendUserMessage("Run the checks");
    await vi.waitFor(() => expect(mocks.runCommand).toHaveBeenCalledOnce());
    expect(session.steerUserMessage("Only report the result")).toBe(true);
    expect(session.steerUserMessage("Keep it brief")).toBe(true);
    expect(mocks.runCommand.mock.calls[0][2].aborted).toBe(false);
    expect(requests).toHaveLength(1);
    expect(events.some(e => e.kind === "userMessage" && e.steering)).toBe(false);
    finish({ exitCode: 0, stdout: "completed", stderr: "", truncated: false });
    await turn;
    expect(mocks.runCommand).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    const prompt = requests[1].messages;
    expect(prompt.slice(-3)).toEqual([
      expect.objectContaining({ role: "tool", tool_call_id: "first" }),
      expect.objectContaining({ role: "user", content: "Only report the result" }),
      expect.objectContaining({ role: "user", content: "Keep it brief" })
    ]);
    expect(prompt.find(m => m.tool_calls)?.reasoning_content).toBe("Check the workspace first.");
    expect(events.some(e => e.kind === "abort")).toBe(false);
    expect(events.filter(e => e.kind === "turnEnd")).toHaveLength(1);
    expect(record.messages.filter(m => m.steering).map(m => m.ts)).toEqual([...new Set(record.messages.filter(m => m.steering).map(m => m.ts))]);
  });

  it("preserves attachments and drops an unfinished tool call when steering", async () => {
    const attachment = await storage.importAttachmentBytes(record.id, "notes.txt", Buffer.from("Attached guidance"));
    let pass = 0;
    mocks.streamChat.mockImplementation(async function* (_endpoint, request) {
      if (pass++ === 0) {
        yield { kind: "toolCallProgress", name: "write_file", path: "unfinished.txt", content: "partial", contentLines: 1, id: "unfinished" };
        expect(session.steerUserMessage("Use these notes", [attachment])).toBe(true);
      } else {
        expect(JSON.stringify(request.messages)).toContain("Attached guidance");
        expect(JSON.stringify(request.messages)).not.toContain("unfinished.txt");
        yield { kind: "text", text: "Applied the notes." };
      }
    });
    await session.sendUserMessage("Prepare the change");
    expect(events).toContainEqual(expect.objectContaining({ kind: "responseDiscarded", toolIds: [expect.any(String)] }));
    expect(record.messages.some(m => m.role === "tool")).toBe(false);
    const loaded = (await storage.load(record.id))!;
    expect(loaded.messages.find(m => m.steering)).toMatchObject({ content: "Use these notes", attachments: [attachment] });
    await expect(fs.stat(path.join(workspaceRoot, "unfinished.txt"))).rejects.toThrow();
  });

  it("accepts steering during initial preparation before the first generation", async () => {
    let finish!: (size: number) => void;
    mocks.fetchServerContextSize.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    mocks.streamChat.mockImplementation(async function* (_endpoint, request) {
      expect(request.messages).toContainEqual(expect.objectContaining({ role: "user", content: "Start with tests" }));
      yield { kind: "text", text: "Starting with tests." };
    });
    const turn = session.sendUserMessage("Implement the feature");
    await vi.waitFor(() => expect(mocks.fetchServerContextSize).toHaveBeenCalledOnce());
    expect(session.steerUserMessage("Start with tests")).toBe(true);
    finish(32768);
    await turn;
    expect(mocks.streamChat).toHaveBeenCalledOnce();
  });

  it("retains accepted guidance when the user cancels a pending approval", async () => {
    mocks.settings.autoapproveWrites = false;
    mocks.streamChat.mockImplementation(async function* () {
      yield { kind: "toolCall", name: "create_file", argsJson: '{"path":"cancelled.txt","content":"content"}', id: "cancelled" };
    });
    const turn = session.sendUserMessage("Create the file");
    await vi.waitFor(() => expect(events.some(e => e.kind === "toolCallProposed" && e.approvalRequired)).toBe(true));
    expect(session.steerUserMessage("Use another filename")).toBe(true);
    session.cancel();
    await turn;
    expect((await storage.load(record.id))?.messages.find(m => m.steering)?.content).toBe("Use another filename");
    expect(session.steerUserMessage("Too late")).toBe(false);
    expect(mocks.streamChat).toHaveBeenCalledOnce();
    await expect(fs.stat(path.join(workspaceRoot, "cancelled.txt"))).rejects.toThrow();
  });
});

describe("saved response file Undo", () => {
  it.each([true, false])("persists snapshots across reopening and informs the next request (existing file: %s)", async existed => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "locality-session-undo-"));
    const { ChatSession } = await import("../src/chat/session.js");
    const { ChatStorage } = await import("../src/chat/storage.js");
    const storage = new ChatStorage(workspaceRoot, path.join(workspaceRoot, "history"));
    const record = storage.newRecord("native");
    mocks.settings.toolCallingMode = "native";
    mocks.settings.autoapproveWrites = true;
    const events: UiEvent[] = [];
    let session = new ChatSession({ storage, workspaceRoot, record, emit: event => events.push(event) });
    try {
      if (existed) await fs.writeFile(path.join(workspaceRoot, "existing.txt"), "");
      let pass = 0;
      mocks.streamChat.mockImplementation(async function* () {
        if (pass++ === 0) yield { kind: "toolCall", name: "insert_text", argsJson: '{"path":"existing.txt","line":1,"expectedLine":"<EOF>","text":"edited"}', id: "edit-existing" };
        else if (pass === 2) yield { kind: "toolCall", name: "create_file", argsJson: '{"path":"created.txt","content":"created"}', id: "create-new" };
        else yield { kind: "text", text: "Updated both files." };
      });
      await session.sendUserMessage("Update the files");
      const userTs = record.messages.find(message => message.role === "user")!.ts;
      expect(events.filter(event => event.kind === "toolCallResolved" && event.status === "executed"))
        .toEqual(expect.arrayContaining([expect.objectContaining({ fileUndoState: "available", fileUndoPath: "existing.txt" })]));
      await session.shutdown();
      const restored = (await storage.load(record.id))!;
      expect(restored.messages.filter(message => message.role === "tool").map(message => message.toolCall?.fileUndo?.previous)).toEqual([existed ? "" : null, null]);
      session = new ChatSession({ storage, workspaceRoot, record: restored, emit: event => events.push(event) });
      await session.undoResponseFiles(userTs, () => undefined);
      if (existed) expect(await fs.readFile(path.join(workspaceRoot, "existing.txt"), "utf8")).toBe("");
      else await expect(fs.stat(path.join(workspaceRoot, "existing.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(workspaceRoot, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await storage.load(record.id))!.messages.filter(message => message.role === "tool").map(message => message.toolCall?.fileUndoState)).toEqual(["undone", "undone"]);
      expect(events).toContainEqual({ kind: "fileEditsUndone", userMessageTs: userTs, paths: ["existing.txt", "created.txt"] });
      await expect(session.undoResponseFiles(userTs, () => undefined)).rejects.toThrow("already been undone");
      mocks.streamChat.mockImplementation(async function* (_endpoint, request) {
        expect(request.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", content: expect.stringContaining("The user undid this response's file edits") })]));
        expect(request.messages.slice(1).some((message: { role: string }) => message.role === "system")).toBe(false);
        yield { kind: "text", text: "I will read the restored files." };
      });
      await session.sendUserMessage("Check the current files");
    } finally {
      await session.shutdown();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
