import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { ChatMode } from "../src/chat/mode.js";
import { WORKSPACE_REASONING_EFFORT_KEY, type ReasoningEffort } from "../src/chat/reasoningEffort.js";
import type { ChatAttachment, ChatRecord, ChatStorage } from "../src/chat/storage.js";
import type { WorkspaceMemory } from "../src/chat/workspaceMemory.js";
import type { UiEvent } from "../src/chat/session.js";
import type { ChatToExt, ExtToChat } from "../src/ui/messaging.js";

const mocks = vi.hoisted(() => ({ sessions: new Map<string, FakeSession>(), input: vi.fn(), picker: vi.fn(), warning: vi.fn(), metadata: vi.fn(), settings: { reasoningEfforts: {}, endpoint: "http://127.0.0.1:8080", model: "model-a", memoryEnabled: true } }));
vi.mock("vscode", () => ({
  commands: { executeCommand: vi.fn() },
  window: { showInputBox: mocks.input, showOpenDialog: mocks.picker, showWarningMessage: mocks.warning },
  Uri: { file: (path: string) => path }
}));
vi.mock("../src/config/settings.js", () => ({ readSettings: () => mocks.settings }));
vi.mock("../src/llm/client.js", () => ({ fetchServerMetadata: mocks.metadata }));
interface FakeSession {
  emit(event: UiEvent): void;
  cancel: ReturnType<typeof vi.fn>;
  approve: ReturnType<typeof vi.fn>;
  approveFutureTools: ReturnType<typeof vi.fn>;
  continueTurn: ReturnType<typeof vi.fn>;
  deleteUserMessage: ReturnType<typeof vi.fn>;
  steerUserMessage: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
  sent: string[];
  sentModes: ChatMode[];
  finish(): void;
  finishPlan(messageTs: number): void;
  renameTitle: ReturnType<typeof vi.fn>;
}
vi.mock("../src/chat/session.js", () => ({
  ChatSession: class implements FakeSession {
    sent: string[] = [];
    sentModes: ChatMode[] = [];
    private finishTurn?: () => void;
    private active = false;
    private turn?: Promise<void>;
    emit: (event: UiEvent) => void;
    cancel = vi.fn(() => this.finish());
    approve = vi.fn();
    approveFutureTools = vi.fn(async () => undefined);
    deleteUserMessage = vi.fn(async (messageTs: number) => {
      const index = this.args.record.messages.findIndex(message => message.role === "user" && message.ts === messageTs);
      if (this.active || index < 0) return false;
      this.args.record.messages = this.args.record.messages.slice(0, index);
      this.emitLoaded();
      return true;
    });
    steerUserMessage = vi.fn((_text: string, _attachments: ChatAttachment[]) => this.active);
    continueTurn = vi.fn(async (_messageTs: number) => {
      if (this.active) return false;
      this.active = true;
      this.emit({ kind: "turnPreparing", reason: "context" });
      this.turn = new Promise<void>(resolve => { this.finishTurn = resolve; });
      await this.turn;
      this.active = false;
      this.emit({ kind: "turnEnd", messageId: this.args.record.id, mode: this.args.record.mode });
      return true;
    });
    shutdown = vi.fn(async () => { this.cancel(); });
    renameTitle = vi.fn(async (title: string) => { this.args.record.title = title; });
    constructor(private args: { record: ChatRecord; emit: (event: UiEvent) => void }) {
      this.emit = args.emit;
      mocks.sessions.set(args.record.id, this);
    }
    getRecord() { return this.args.record; }
    emitLoaded() { this.emit({ kind: "chatLoaded", record: this.args.record }); }
    refreshMemoryVisibility() {}
    isTurnActive() { return this.active; }
    isPlanning() { return this.args.record.planning === true || this.args.record.pendingPlanMessageTs !== undefined; }
    setMode(mode: ChatMode) {
      if (this.args.record.pendingPlanMessageTs !== undefined) mode = "plan";
      this.args.record.mode = mode;
      this.emit({ kind: "chatModeChanged", mode });
    }
    setReasoningEffort(effort: ReasoningEffort) {
      this.args.record.reasoningEffort = effort;
      this.emit({ kind: "reasoningEffortChanged", effort });
    }
    resolvePlan(messageTs: number | undefined, mode: "act" | "plan") {
      if (this.active || !this.isPlanning() || this.args.record.pendingPlanMessageTs !== messageTs) return false;
      if (mode === "act" && messageTs === undefined) return false;
      delete this.args.record.pendingPlanMessageTs;
      if (mode === "act") delete this.args.record.planning;
      else this.args.record.planning = true;
      this.setMode(mode);
      this.emit({ kind: "planningState", active: this.isPlanning() });
      return true;
    }
    async cancelPlanning(messageTs?: number) {
      if (!this.isPlanning() || (messageTs !== undefined && (this.active || this.args.record.pendingPlanMessageTs !== messageTs))) return false;
      this.cancel();
      await this.turn;
      delete this.args.record.planning;
      delete this.args.record.pendingPlanMessageTs;
      this.setMode("act");
      this.emit({ kind: "planningState", active: false });
      return true;
    }
    finishPlan(messageTs: number) {
      this.args.record.pendingPlanMessageTs = messageTs;
      this.args.record.planning = true;
      this.setMode("plan");
      this.emit({ kind: "planFinal", messageId: "plan", messageTs, markdown: "The plan" });
      this.finish();
    }
    async sendUserMessage(text: string, _attachments: ChatAttachment[], mode: ChatMode) {
      this.active = true;
      this.sent.push(text);
      this.sentModes.push(mode);
      if (mode === "plan") this.args.record.planning = true;
      this.emit({ kind: "turnPreparing", reason: "server" });
      this.turn = new Promise<void>(resolve => { this.finishTurn = resolve; });
      await this.turn;
      this.active = false;
      this.emit({ kind: "turnEnd", messageId: this.args.record.id, mode });
    }
    finish() { this.finishTurn?.(); }
  }
}));
import { ChatViewProvider } from "../src/ui/chatView/provider.js";

const record = (id: string) => ({ id, title: id, messages: [], reasoningEffort: "default", mode: "act" } as unknown as ChatRecord);
function setup(memory?: WorkspaceMemory) {
  const storage = { list: vi.fn().mockResolvedValue([]), load: vi.fn(), save: vi.fn(), delete: vi.fn(), deleteAll: vi.fn(), deleteAttachment: vi.fn(), importAttachment: vi.fn(), importAttachmentBytes: vi.fn(), attachmentPath: (id: string) => `/workspace/${id}/image.png` };
  const preferences = new Map<string, unknown>();
  const workspaceState = {
    get: vi.fn((key: string) => preferences.get(key)),
    update: vi.fn(async (key: string, value: unknown) => { preferences.set(key, value); })
  };
  const createChat = vi.fn();
  const onChatOpened = vi.fn();
  const onChatListChanged = vi.fn();
  const provider = new ChatViewProvider(
    { workspaceState } as unknown as vscode.ExtensionContext,
    () => storage as unknown as ChatStorage, () => "/workspace", vi.fn(), onChatOpened, createChat, onChatListChanged, memory
  );
  const posted: ExtToChat[] = [];
  (provider as unknown as { view: unknown }).view = { webview: { postMessage: (message: ExtToChat) => posted.push(message), asWebviewUri: (path: string) => path } };
  const send = (message: ChatToExt) => (provider as unknown as { onMessage(message: ChatToExt): Promise<void> }).onMessage(message);
  const snapshot = () => [...posted].reverse().find(message => "type" in message && message.type === "chatSnapshot") as Extract<ExtToChat, { type: "chatSnapshot" }>;
  return { provider, storage, posted, send, snapshot, workspaceState, createChat, onChatOpened, onChatListChanged };
}
beforeEach(() => {
  mocks.sessions.clear();
  vi.clearAllMocks();
  mocks.warning.mockReset();
  mocks.settings.model = "model-a";
  mocks.settings.reasoningEfforts = {};
  mocks.settings.memoryEnabled = true;
  mocks.metadata.mockReset().mockResolvedValue({ modelAlias: "model-a", contextSize: 32768, supportsVision: false });
});

describe("delete messages", () => {
  const chat = () => ({ ...record("a"), messages: [
    { role: "user" as const, content: "Request", ts: 1 },
    { role: "assistant" as const, content: "Answer", ts: 2 }
  ] });

  it("confirms deletion and refreshes the transcript and chat lists", async () => {
    const { provider, send, posted, storage, onChatOpened, onChatListChanged } = setup();
    provider.openChat(chat());
    mocks.warning.mockResolvedValue("Delete");
    await send({ type: "deleteMessage", chatId: "a", messageTs: 1 });
    expect(mocks.warning).toHaveBeenCalledWith(
      "Delete this message and everything after it?", expect.objectContaining({ modal: true }), "Delete"
    );
    expect(mocks.sessions.get("a")!.deleteUserMessage).toHaveBeenCalledWith(1);
    expect(posted).toContainEqual(expect.objectContaining({ kind: "chatLoaded", record: expect.objectContaining({ messages: [] }) }));
    expect(onChatOpened).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a", messages: [] }));
    expect(onChatListChanged).toHaveBeenCalled();
    expect(storage.list).toHaveBeenCalled();
    await provider.closeAll();
  });

  it("keeps messages when confirmation is dismissed", async () => {
    const { provider, send } = setup();
    const rec = chat();
    provider.openChat(rec);
    await send({ type: "deleteMessage", chatId: "a", messageTs: 1 });
    expect(mocks.sessions.get("a")!.deleteUserMessage).not.toHaveBeenCalled();
    expect(rec.messages).toHaveLength(2);
    await provider.closeAll();
  });

  it.each(["switch chat", "new turn", "changed history", "close chats"])("ignores confirmation after %s", async action => {
    const { provider, send } = setup();
    const rec = chat();
    provider.openChat(rec);
    const session = mocks.sessions.get("a")!;
    let confirm!: (choice: string) => void;
    mocks.warning.mockImplementation(() => new Promise<string>(resolve => { confirm = resolve; }));
    const deletion = send({ type: "deleteMessage", chatId: "a", messageTs: 1 });
    expect(mocks.warning).toHaveBeenCalledOnce();
    let nextTurn: Promise<void> | undefined;
    if (action === "switch chat") provider.openChat(record("b"));
    else if (action === "new turn") {
      nextTurn = send({ type: "send", chatId: "a", text: "Next", mode: "act" });
      await vi.waitFor(() => expect(session.sent).toEqual(["Next"]));
    }
    else if (action === "changed history") rec.messages = rec.messages.slice();
    else await provider.closeAll();
    confirm("Delete");
    await deletion;
    expect(session.deleteUserMessage).not.toHaveBeenCalled();
    session.finish();
    await nextTurn;
    await provider.closeAll();
  });

  it("ignores stale chat requests and non-user messages", async () => {
    const { provider, send } = setup();
    provider.openChat(chat());
    await send({ type: "deleteMessage", chatId: "b", messageTs: 1 });
    await send({ type: "deleteMessage", chatId: "a", messageTs: 2 });
    expect(mocks.warning).not.toHaveBeenCalled();
    expect(mocks.sessions.get("a")!.deleteUserMessage).not.toHaveBeenCalled();
    await provider.closeAll();
  });
});

describe("continue interrupted chats", () => {
  it("targets the originating chat and drains messages queued during continuation", async () => {
    const { provider, send } = setup();
    provider.openChat(record("a"));
    const a = mocks.sessions.get("a")!;
    const continuation = send({ type: "continueChat", chatId: "a", messageTs: 123 });
    expect(a.continueTurn).toHaveBeenCalledWith(123);
    await send({ type: "send", chatId: "a", text: "Next request", mode: "act" });
    expect(a.sent).toEqual([]);
    provider.openChat(record("b"));
    await send({ type: "continueChat", chatId: "a", messageTs: 123 });
    expect(a.continueTurn).toHaveBeenCalledTimes(1);
    expect(mocks.sessions.get("b")!.continueTurn).not.toHaveBeenCalled();
    a.finish();
    await continuation;
    await vi.waitFor(() => expect(a.sent).toEqual(["Next request"]));
    a.finish();
    await provider.closeAll();
  });
});

describe("reasoning effort from Settings", () => {
  it("saves a preference without opening a chat", async () => {
    mocks.settings.reasoningEfforts = { Deep: "xhigh" };
    const { provider, workspaceState, createChat } = setup();
    await provider.setReasoningEffort("effort:xhigh");
    expect(workspaceState.update).toHaveBeenCalledWith(WORKSPACE_REASONING_EFFORT_KEY, "effort:xhigh");
    expect(provider.getReasoningEffort()).toBe("effort:xhigh");
    expect(createChat).not.toHaveBeenCalled();
    expect(provider.getTabs()).toEqual([]);
  });

  it("changes only the active chat and restores each tab's saved choice", async () => {
    mocks.settings.reasoningEfforts = { Deep: "xhigh" };
    const { provider, workspaceState } = setup();
    const a = record("a");
    const b = { ...record("b"), reasoningEffort: "none" as const };
    provider.openChat(a);
    provider.openChat(b);
    expect(provider.getReasoningEffort()).toBe("none");
    const session = mocks.sessions.get("b")!;
    session.emit({ kind: "turnPreparing", reason: "server" });
    let finishPersistence!: () => void;
    workspaceState.update.mockReturnValueOnce(new Promise<void>(resolve => { finishPersistence = resolve; }));
    const saving = provider.setReasoningEffort("effort:xhigh");
    expect(b.reasoningEffort).toBe("effort:xhigh");
    expect(a.reasoningEffort).toBe("default");
    expect(session.cancel).not.toHaveBeenCalled();
    finishPersistence();
    await saving;
    expect(provider.getReasoningEffort()).toBe("effort:xhigh");
    await provider.openChatById("a");
    expect(provider.getReasoningEffort()).toBe("default");
  });

  it("falls back to Default when a custom level is removed", async () => {
    mocks.settings.reasoningEfforts = { Deep: "xhigh" };
    const { provider, workspaceState } = setup();
    provider.openChat({ ...record("a"), reasoningEffort: "effort:xhigh" });
    expect(provider.getReasoningEffort()).toBe("effort:xhigh");
    mocks.settings.reasoningEfforts = {};
    expect(provider.getReasoningEffort()).toBe("default");
    await provider.setReasoningEffort("effort:xhigh");
    expect(provider.getCurrentRecord()?.reasoningEffort).toBe("default");
    expect(workspaceState.update).toHaveBeenCalledWith(WORKSPACE_REASONING_EFFORT_KEY, "default");
  });
});

describe.each(["act", "review"] as const)("automatic %s memories", mode => {
  it.each([
    { startEnabled: true, endEnabled: false },
    { startEnabled: false, endEnabled: false },
    { startEnabled: false, endEnabled: true },
    { startEnabled: true, endEnabled: true }
  ])("uses the setting at turn completion (start=$startEnabled, end=$endEnabled)", ({ startEnabled, endEnabled }) => {
    mocks.settings.memoryEnabled = startEnabled;
    const memory = { enqueue: vi.fn(), creations: vi.fn().mockResolvedValue([]) };
    const { provider } = setup(memory as unknown as WorkspaceMemory);
    provider.openChat(record("a"));
    const session = mocks.sessions.get("a")!;
    session.emit({ kind: "turnPreparing", reason: "server" });
    session.emit({ kind: "text", messageId: "answer-a", delta: "Working on the request" });
    expect(memory.enqueue).not.toHaveBeenCalled();

    // Settings and the selected tab can change while the model is responding.
    provider.openChat(record("b"));
    mocks.settings.memoryEnabled = endEnabled;
    provider.pushSettings();
    expect(memory.enqueue).not.toHaveBeenCalled();
    session.emit({ kind: "turnEnd", messageId: "answer-a", mode, messageTs: 2 });
    if (endEnabled) expect(memory.enqueue).toHaveBeenCalledExactlyOnceWith("a", false, 2);
    else expect(memory.enqueue).not.toHaveBeenCalled();

    // Re-enabling afterward must not schedule a skipped turn retroactively.
    mocks.settings.memoryEnabled = true;
    provider.pushSettings();
    expect(memory.enqueue).toHaveBeenCalledTimes(endEnabled ? 1 : 0);
  });
});

describe("independent chat tabs", () => {
  it("routes auto-approval to the active chat and ignores stale approval messages", async () => {
    const { provider, send } = setup();
    provider.openChat(record("a"));
    const a = mocks.sessions.get("a")!;
    await send({ type: "approveTool", toolId: "read-a", approved: true, autoApprove: true, chatId: "a" });
    expect(a.approveFutureTools).toHaveBeenCalledWith("read-a");
    expect(a.approve).not.toHaveBeenCalled();
    await send({ type: "approveTool", toolId: "edit-a", approved: false, autoApprove: true, chatId: "a" });
    expect(a.approve).toHaveBeenCalledWith("edit-a", false);
    expect(a.approveFutureTools).toHaveBeenCalledOnce();
    provider.openChat(record("b"));
    const b = mocks.sessions.get("b")!;
    await send({ type: "approveTool", toolId: "stale-a", approved: true, autoApprove: true, chatId: "a" });
    expect(b.approveFutureTools).not.toHaveBeenCalled();
    expect(a.approveFutureTools).toHaveBeenCalledOnce();
  });

  it.each([
    { mode: "act" as const, messageTs: 2, createsMemory: true },
    { mode: "review" as const, messageTs: 2, createsMemory: true },
    { mode: "plan" as const, messageTs: 2, createsMemory: false },
    { mode: "act" as const, messageTs: undefined, createsMemory: false },
    { mode: "review" as const, messageTs: undefined, createsMemory: false },
    { mode: "plan" as const, messageTs: undefined, createsMemory: false }
  ])("only queues memory for completed Act/Review answers ($mode, answer=$messageTs)", ({ mode, messageTs, createsMemory }) => {
    const memory = { enqueue: vi.fn(), creations: vi.fn().mockResolvedValue([]) };
    const { provider } = setup(memory as unknown as WorkspaceMemory);
    const rec = record("a");
    // The composer and active tab can change while this response is running.
    rec.mode = mode === "plan" ? "act" : "plan";
    provider.openChat(rec);
    provider.openChat(record("b"));
    mocks.sessions.get("a")!.emit({ kind: "turnEnd", messageId: "answer-a", mode, messageTs });
    if (createsMemory) expect(memory.enqueue).toHaveBeenCalledExactlyOnceWith("a", false, 2);
    else expect(memory.enqueue).not.toHaveBeenCalled();
  });

  it("reuses the current live session without reloading or cancelling it", async () => {
    const { provider, posted } = setup();
    provider.openChat(record("a"));
    const a = mocks.sessions.get("a")!;
    a.emit({ kind: "turnPreparing", reason: "server" });
    posted.length = 0;
    await provider.openChatById("a");
    provider.openChat(record("a"));
    expect(mocks.sessions.size).toBe(1);
    expect(a.cancel).not.toHaveBeenCalled();
    expect(posted.filter(message => !("type" in message && message.type === "recentChats") && !("kind" in message && message.kind === "visionCapability"))).toEqual([]);
  });

  it("restores streamed text, approvals and accounting without leaking background events", async () => {
    const { provider, posted, snapshot } = setup();
    provider.openChat(record("a"));
    const a = mocks.sessions.get("a")!;
    a.emit({ kind: "turnPreparing", reason: "server" });
    a.emit({ kind: "text", messageId: "response", delta: "hello" });
    provider.openChat(record("b"));
    posted.length = 0;
    a.emit({ kind: "text", messageId: "response", delta: " world" });
    a.emit({ kind: "toolCallProposed", toolId: "approval-a", messageId: "response", toolName: "write_file", argsJson: "{}", category: "write", approvalRequired: true });
    a.emit({ kind: "tokens", total: 123, limit: 4096 });
    expect(posted).toEqual([]);
    await provider.openChatById("a");
    expect(snapshot().busy).toBe(true);
    expect(snapshot().events).toContainEqual({ kind: "text", messageId: "response", delta: "hello world" });
    expect(snapshot().events).toContainEqual(expect.objectContaining({ kind: "toolCallProposed", toolId: "approval-a" }));
    expect(snapshot().events).toContainEqual({ kind: "tokens", total: 123, limit: 4096 });
    expect(a.cancel).not.toHaveBeenCalled();
  });

  it("restores a read that is still waiting for its result to enter the model prompt", async () => {
    const { provider, snapshot } = setup();
    const chat = record("a");
    provider.openChat(chat);
    const a = mocks.sessions.get("a")!;
    a.emit({ kind: "turnPreparing", reason: "server" });
    a.emit({ kind: "turnWorkStarted", messageId: "response", startedAt: 1 });
    a.emit({ kind: "toolCallProposed", toolId: "read-a", messageId: "response", toolName: "read_file", argsJson: '{"path":"a.txt"}', category: "read", approvalRequired: false });
    chat.messages.push({ role: "tool", content: "File contents", ts: 2, toolCall: {
      id: "read-a", name: "read_file", argsJson: '{"path":"a.txt"}', status: "executed"
    } });
    a.emit({ kind: "toolCallResolved", toolId: "read-a", status: "executed", resultPreview: "File contents" });
    provider.openChat(record("b"));
    a.emit({ kind: "contextActivity", activityIds: ["read-a"] });
    a.emit({ kind: "turnPreparing", reason: "server" });
    await provider.openChatById("a");
    expect(snapshot().busy).toBe(true);
    expect(snapshot().events).toContainEqual(expect.objectContaining({ kind: "toolCallProposed", toolId: "read-a" }));
    expect(snapshot().events).toContainEqual({ kind: "contextActivity", activityIds: ["read-a"] });
    expect(snapshot().events).toContainEqual(expect.objectContaining({ kind: "toolCallResolved", toolId: "read-a" }));
    expect(snapshot().events).not.toContainEqual({ kind: "contextActivity", activityIds: [] });
    const baseline = snapshot().events.find(event => "kind" in event && event.kind === "chatLoaded");
    expect(baseline).toEqual(expect.objectContaining({ record: expect.objectContaining({ messages: [] }) }));

    provider.openChat(record("b"));
    a.emit({ kind: "contextActivity", activityIds: [] });
    a.emit({ kind: "turnPreparing", reason: "server" });
    await provider.openChatById("a");
    expect(snapshot().events).toContainEqual({ kind: "contextActivity", activityIds: [] });
  });

  it("runs and drains each queue independently and cancels only the visible chat", async () => {
    const { provider, send } = setup();
    provider.openChat(record("a"));
    const first = send({ type: "send", mode: "act", text: "A", chatId: "a" });
    await send({ type: "queueMessage", mode: "act", id: "qa", text: "A follow-up", chatId: "a" });
    provider.openChat(record("b"));
    const second = send({ type: "send", mode: "act", text: "B", chatId: "b" });
    const a = mocks.sessions.get("a")!, b = mocks.sessions.get("b")!;
    expect(provider.getTabs().filter(tab => tab.running)).toHaveLength(2);
    a.finish();
    await vi.waitFor(() => expect(a.sent).toEqual(["A", "A follow-up"]));
    expect(b.sent).toEqual(["B"]);
    await send({ type: "cancel", chatId: "b" });
    await second;
    expect(a.cancel).not.toHaveBeenCalled();
    expect(b.cancel).toHaveBeenCalledOnce();
    expect(provider.getTabs().find(tab => tab.id === "a")?.running).toBe(true);
    a.finish();
    await first;
    expect(provider.getTabs().some(tab => tab.running)).toBe(false);
  });

  it("retains submitted modes through queue edits, reordering, tab switches and webview reloads", async () => {
    const { provider, send, posted } = setup();
    provider.openChat(record("a"));
    const turn = send({ type: "send", text: "Start", mode: "act" });
    await send({ type: "setChatMode", mode: "plan" });
    await send({ type: "queueMessage", id: "plan", text: "Plan it", mode: "plan" });
    await send({ type: "setChatMode", mode: "review" });
    await send({ type: "queueMessage", id: "review", text: "Review it", mode: "review" });
    await send({ type: "setChatMode", mode: "act" });
    await send({ type: "updateQueuedMessage", id: "plan", text: "Plan the fix" });
    await send({ type: "reorderQueuedMessages", ids: ["review", "plan"] });
    provider.openChat(record("b"));
    await provider.openChatById("a");
    await send({ type: "ready" });
    expect(posted.filter(message => "type" in message && message.type === "messageQueue").at(-1)).toEqual({
      type: "messageQueue",
      messages: [
        { id: "review", text: "Review it", mode: "review" },
        { id: "plan", text: "Plan the fix", mode: "plan" }
      ]
    });

    const a = mocks.sessions.get("a")!;
    a.finish();
    await vi.waitFor(() => expect(a.sent).toEqual(["Start", "Review it"]));
    expect(a.sentModes).toEqual(["act", "review"]);
    a.finish();
    await vi.waitFor(() => expect(a.sent).toEqual(["Start", "Review it", "Plan the fix"]));
    expect(a.sentModes).toEqual(["act", "review", "plan"]);
    expect(provider.getCurrentRecord()?.mode).toBe("act");
    a.finish();
    await turn;
  });

  it("keeps the submitted mode when a concurrent send becomes queued", async () => {
    const { provider, send } = setup();
    provider.openChat(record("a"));
    const turn = send({ type: "send", text: "First", mode: "act" });
    await send({ type: "send", text: "Next", mode: "review" });
    await send({ type: "setChatMode", mode: "act" });
    const a = mocks.sessions.get("a")!;
    a.finish();
    await vi.waitFor(() => expect(a.sentModes).toEqual(["act", "review"]));
    a.finish();
    await turn;
  });

  it.each(["acceptPlan", "revisePlan"] as const)("pauses queued work until a plan response and submits it in the right mode (%s)", async response => {
    const { provider, send, snapshot } = setup();
    provider.openChat(record("a"));
    const first = send({ type: "send", text: "Plan it", mode: "plan" });
    await send({ type: "queueMessage", id: "later", text: "Later review", mode: "review" });
    const a = mocks.sessions.get("a")!;
    a.finishPlan(10);
    await first;
    expect(a.sent).toEqual(["Plan it"]);
    await send({ type: "setChatMode", mode: "act" });
    expect(provider.getCurrentRecord()?.mode).toBe("plan");
    await send({ type: "ready" });
    expect(snapshot().events).toContainEqual(expect.objectContaining({ kind: "planFinal", messageTs: 10 }));
    await send({ type: "acceptPlan", messageTs: 9 });
    expect(a.sent).toEqual(["Plan it"]);

    const next = response === "acceptPlan"
      ? send({ type: "acceptPlan", messageTs: 10 })
      : send({ type: "revisePlan", messageTs: 10, text: "  Include validation  " });
    expect(a.sent[1]).toBe(response === "acceptPlan" ? "I accept your plan. Please implement." : "Include validation");
    expect(a.sentModes[1]).toBe(response === "acceptPlan" ? "act" : "plan");
    if (response === "acceptPlan") {
      a.finish();
      await vi.waitFor(() => expect(a.sent[2]).toBe("Later review"));
      a.finish();
    } else {
      a.finishPlan(20);
    }
    await next;
    expect(provider.getCurrentRecord()?.pendingPlanMessageTs).toBe(response === "acceptPlan" ? undefined : 20);
  });

  it.each(["acceptPlan", "cancelPlanning"] as const)("holds the queue across every planning revision until %s", async action => {
    const { provider, send, posted } = setup();
    provider.openChat(record("a"));
    const first = send({ type: "send", text: "Plan the first task", mode: "plan" });
    await send({ type: "queueMessage", id: "next", text: "Independent task", mode: "act" });
    const a = mocks.sessions.get("a")!;
    a.finishPlan(10);
    await first;
    for (const messageTs of [10, 20]) {
      const revision = send({ type: "revisePlan", messageTs, text: `Revise ${messageTs}` });
      expect(a.sent).not.toContain("Independent task");
      a.finishPlan(messageTs + 10);
      await revision;
      expect(a.sent).not.toContain("Independent task");
      expect(posted.filter(message => "type" in message && message.type === "messageQueue").at(-1)).toMatchObject({
        messages: [{ id: "next", text: "Independent task", mode: "act" }]
      });
    }
    await send({ type: "cancelPlanning", messageTs: 20 });
    expect(a.sent).not.toContain("Independent task");
    const resolved = send({ type: action, messageTs: 30 });
    if (action === "acceptPlan") {
      expect(a.sent.at(-1)).toBe("I accept your plan. Please implement.");
      a.finish();
    }
    await vi.waitFor(() => expect(a.sent.at(-1)).toBe("Independent task"));
    expect(a.sentModes.at(-1)).toBe("act");
    a.finish();
    await resolved;
    expect(a.sent.filter(text => text === "Independent task")).toHaveLength(1);
    if (action === "cancelPlanning") expect(a.sent).not.toContain("I accept your plan. Please implement.");
  });

  it("holds queued messages after an incomplete revision and releases them on cancellation", async () => {
    const { provider, send } = setup();
    provider.openChat(record("a"));
    const first = send({ type: "send", text: "Plan it", mode: "plan" });
    await send({ type: "queueMessage", id: "next", text: "Next task", mode: "review" });
    const a = mocks.sessions.get("a")!;
    a.finishPlan(10);
    await first;
    const revision = send({ type: "revisePlan", messageTs: 10, text: "Revise it" });
    a.finish();
    await revision;
    expect(a.sent).toEqual(["Plan it", "Revise it"]);
    await send({ type: "cancelPlanning" });
    await vi.waitFor(() => expect(a.sent).toEqual(["Plan it", "Revise it", "Next task"]));
    a.finish();
  });

  it("releases queued messages when the user stops an active planning turn", async () => {
    const { provider, send } = setup();
    provider.openChat(record("a"));
    const first = send({ type: "send", text: "Plan it", mode: "plan" });
    await send({ type: "queueMessage", id: "next", text: "Next task", mode: "review" });
    const a = mocks.sessions.get("a")!;
    await send({ type: "cancel" });
    await vi.waitFor(() => expect(a.sent).toEqual(["Plan it", "Next task"]));
    expect(a.sentModes).toEqual(["plan", "review"]);
    a.finish();
    await first;
  });

  it("keeps a closed tab running, retains its draft, and reopens the same session", async () => {
    const { provider, send, snapshot } = setup();
    provider.openChat(record("a"));
    const turn = send({ type: "send", mode: "act", text: "work" });
    await send({ type: "saveDraft", text: "next request", chatId: "a" });
    provider.closeTab("a");
    expect(provider.getCurrentRecord()).toBeUndefined();
    expect(provider.getTabs()).toContainEqual({ id: "a", title: "a", running: true, open: false });
    await provider.openChatById("a");
    expect(snapshot().draft).toBe("next request");
    const a = mocks.sessions.get("a")!;
    expect(a.cancel).not.toHaveBeenCalled();
    a.finish(); await turn;
  });

  it("rejects late actions addressed to the previous chat and restores drafts after ready", async () => {
    const { provider, send, snapshot } = setup();
    provider.openChat(record("a"));
    provider.openChat(record("b"));
    await send({ type: "cancel", chatId: "a" });
    await send({ type: "send", mode: "act", text: "wrong chat", chatId: "a" });
    await send({ type: "saveDraft", text: "draft A", chatId: "a" });
    expect(mocks.sessions.get("b")!.sent).toEqual([]);
    expect(mocks.sessions.get("b")!.cancel).not.toHaveBeenCalled();
    await provider.openChatById("a");
    await send({ type: "ready" });
    expect(snapshot().draft).toBe("draft A");
  });

  it("sanitizes transcript snapshots just like initial loads", async () => {
    const { provider, snapshot } = setup();
    provider.openChat({ ...record("a"), contextMessages: [{ role: "system", content: "private model context", ts: 1 }], recalledMemories: [] });
    const event = snapshot().events.find(event => "kind" in event && event.kind === "chatLoaded") as Extract<UiEvent, { kind: "chatLoaded" }>;
    expect(event.record.contextMessages).toBeUndefined();
    expect(event.record.recalledMemories).toBeUndefined();
    expect(event.contextMessageCount).toBe(1);
  });

  it("renames a live background chat through its session without changing the active chat", async () => {
    const { provider, snapshot } = setup();
    provider.openChat(record("a"));
    provider.openChat(record("b"));
    await provider.renameChat("a", "Renamed A");
    expect(mocks.sessions.get("a")!.renameTitle).toHaveBeenCalledWith("Renamed A");
    expect(provider.getCurrentRecord()?.id).toBe("b");
    await provider.openChatById("a");
    expect(snapshot().events).toContainEqual({ kind: "titleChanged", title: "Renamed A", animate: false });
  });

  it("waits for shutdown before deletion and ignores late events", async () => {
    const { provider, posted } = setup();
    provider.openChat(record("a"));
    const a = mocks.sessions.get("a")!;
    let finish!: () => void;
    a.shutdown.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const removed = provider.removeChat("a");
    let done = false;
    void removed.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    posted.length = 0;
    a.emit({ kind: "text", messageId: "late", delta: "late" });
    expect(posted).toEqual([]);
    finish(); await removed;
    expect(provider.getTabs()).toEqual([]);
  });

  it("shuts down all workspace sessions, including closed running tabs", async () => {
    const { provider } = setup();
    provider.openChat(record("a"));
    mocks.sessions.get("a")!.emit({ kind: "turnPreparing", reason: "server" });
    provider.closeTab("a");
    provider.openChat(record("b"));
    await provider.closeAll();
    for (const session of mocks.sessions.values()) expect(session.shutdown).toHaveBeenCalledOnce();
    expect(provider.getCurrentRecord()).toBeUndefined();
    expect(provider.getTabs()).toEqual([]);
  });

  it("imports pasted text without a suffix and completes a pasted file batch", async () => {
    const { provider, storage, send, posted } = setup();
    provider.openChat(record("a"));
    storage.importAttachmentBytes.mockImplementation(async (_chatId, fileName, bytes) => ({
      id: fileName, fileName, byteLength: bytes.length, mimeType: "text/plain", extension: "txt"
    }));
    await send({ type: "pasteText", chatId: "a", text: "a".repeat(10000) });
    expect(storage.importAttachmentBytes).toHaveBeenCalledWith("a", "Pasted text", Buffer.from("a".repeat(10000)), { allowImages: false });
    posted.length = 0;
    await send({ type: "pasteAttachments", chatId: "a", files: [
      { fileName: "main.ts", dataUrl: "data:video/mp2t;base64,Y29kZQ==" },
      { fileName: "notes.md", dataUrl: "data:text/markdown;base64,bm90ZXM=" }
    ] });
    expect(storage.importAttachmentBytes).toHaveBeenCalledWith("a", "main.ts", Buffer.from("code"), { allowImages: false });
    expect(storage.importAttachmentBytes).toHaveBeenCalledWith("a", "notes.md", Buffer.from("notes"), { allowImages: false });
    expect(posted.filter(m => "type" in m && m.type === "attachmentSelected")).toHaveLength(2);
    expect(posted.at(-1)).toEqual({ type: "attachmentImportState", pending: false });
  });

  it("rejects oversized text and malformed pasted data before importing files", async () => {
    const { provider, storage, send, posted } = setup();
    provider.openChat(record("a"));
    await send({ type: "pasteText", text: "a".repeat(1024 * 1024 + 1) });
    expect(posted).toContainEqual(expect.objectContaining({ type: "attachmentPasteFailed", error: expect.stringContaining("1 MiB") }));
    await send({ type: "pasteAttachments", files: [{ fileName: "file.txt", dataUrl: "data:text/plain;base64,%%%=" }] });
    expect(storage.importAttachmentBytes).not.toHaveBeenCalled();
    expect(posted.at(-1)).toEqual({ type: "attachmentImportState", pending: false });
  });

  it("keeps an attachment picker tied to its source chat after switching tabs", async () => {
    const { provider, storage, send, posted } = setup();
    provider.openChat(record("a"));
    let pick!: (uris: { fsPath: string }[]) => void;
    mocks.picker.mockReturnValue(new Promise(resolve => { pick = resolve; }));
    storage.importAttachment.mockResolvedValue({ id: "image", fileName: "image.png", mimeType: "image/png" });
    const attaching = send({ type: "selectAttachment", chatId: "a" });
    provider.openChat(record("b"));
    posted.length = 0;
    pick([{ fsPath: "/tmp/image.png" }]); await attaching;
    expect(storage.importAttachment).toHaveBeenCalledWith("a", "/tmp/image.png", { allowImages: false });
    expect(posted.some(message => "type" in message && message.type === "attachmentSelected")).toBe(false);
    await provider.openChatById("a");
    expect(posted).toContainEqual(expect.objectContaining({ type: "attachmentSelected", attachment: expect.objectContaining({ id: "image", previewUri: "/workspace/a/image.png" }) }));
  });

  it("blocks reopening a source until its pending deletion finishes", async () => {
    const { provider, storage } = setup();
    provider.openChat(record("a"));
    let finish!: () => void;
    storage.delete.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const deletion = provider.removeChat("a");
    await vi.waitFor(() => expect(storage.delete).toHaveBeenCalledWith("a"));
    await provider.openChatById("a");
    expect(storage.load).not.toHaveBeenCalled();
    expect(provider.getCurrentRecord()).toBeUndefined();
    finish(); await deletion;
  });

  it("prevents new sessions from racing a workspace-wide deletion", async () => {
    const { provider, storage } = setup();
    provider.openChat(record("a"));
    let finish!: () => void;
    storage.deleteAll.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const deletion = provider.clearChats();
    await vi.waitFor(() => expect(storage.deleteAll).toHaveBeenCalled());
    provider.openChat(record("b"));
    expect(provider.getCurrentRecord()).toBeUndefined();
    expect(provider.isClearingWorkspace()).toBe(true);
    finish(); await deletion;
    expect(provider.isClearingWorkspace()).toBe(false);
  });

  it("accepts rapid navigation even when the second click carries the previous chat ID", async () => {
    const { provider, send } = setup();
    provider.openChat(record("a"));
    provider.openChat(record("b"));
    provider.openChat(record("c"));
    await provider.openChatById("a");
    await send({ type: "openChat", id: "b", chatId: "a" });
    await send({ type: "openChat", id: "c", chatId: "a" });
    expect(provider.getCurrentRecord()?.id).toBe("c");
  });

  it("does not activate a slow earlier open request after a newer selection", async () => {
    const { provider, storage } = setup();
    let load!: (record: ChatRecord) => void;
    storage.load.mockReturnValue(new Promise<ChatRecord>(resolve => { load = resolve; }));
    const slow = provider.openChatById("a");
    provider.openChat(record("b"));
    load(record("a")); await slow;
    expect(provider.getCurrentRecord()?.id).toBe("b");
  });
});

describe("image attachment capabilities", () => {
  it.each([true, false])("gates pasted images with the connected model's vision flag (%s)", async supported => {
    const { provider, storage, send } = setup();
    mocks.metadata.mockResolvedValue({ modelAlias: "model-a", contextSize: 32768, supportsVision: supported });
    provider.openChat(record("a"));
    storage.importAttachmentBytes.mockResolvedValue({ id: "image", fileName: "image.png", mimeType: "image/png", extension: "png", byteLength: 8 });
    await send({ type: "pasteAttachments", chatId: "a", files: [{ fileName: "image.png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" }] });
    expect(storage.importAttachmentBytes).toHaveBeenCalledWith("a", "image.png", expect.any(Buffer), { allowImages: supported });
    expect(mocks.metadata).toHaveBeenCalledWith(mocks.settings.endpoint, { model: "model-a" });
  });

  it("ignores late capability responses from a previously selected model", async () => {
    const { provider, posted } = setup();
    let resolveOld!: (value: { supportsVision: boolean }) => void;
    mocks.metadata.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    provider.pushSettings();
    mocks.settings.model = "model-b";
    provider.pushSettings();
    await vi.waitFor(() => expect(posted.at(-1)).toMatchObject({ kind: "visionCapability", supported: false }));
    resolveOld({ supportsVision: true });
    await Promise.resolve();
    expect(posted.filter(message => "kind" in message && message.kind === "visionCapability")).not.toContainEqual(expect.objectContaining({ supported: true }));
  });

  it("does not restore a previous model's capability from a chat snapshot", async () => {
    const { provider, posted, snapshot } = setup();
    provider.openChat(record("a"));
    await Promise.resolve();
    mocks.settings.model = "model-b";
    posted.length = 0;
    mocks.sessions.get("a")!.emit({ kind: "visionCapability", supported: true, endpoint: mocks.settings.endpoint, model: "model-a" });
    expect(posted).toEqual([]);
    provider.openChat(record("b"));
    await provider.openChatById("a");
    expect(snapshot().events.some(event => "kind" in event && event.kind === "visionCapability")).toBe(false);
  });
});

describe("steering messages from the chat view", () => {
  it("routes guidance to the active turn while preserving the normal queue", async () => {
    const { provider, send, posted } = setup();
    provider.openChat(record("a"));
    const a = mocks.sessions.get("a")!;
    const turn = send({ type: "send", text: "Start", mode: "act", chatId: "a" });
    await send({ type: "queueMessage", id: "queued", text: "Later", mode: "review", chatId: "a" });
    await send({ type: "steerMessage", text: "Change direction", mode: "plan", chatId: "a" });
    expect(a.steerUserMessage).toHaveBeenCalledExactlyOnceWith("Change direction", []);
    expect(a.sent).toEqual(["Start"]);
    expect(a.cancel).not.toHaveBeenCalled();
    expect(posted.filter(m => "type" in m && m.type === "messageQueue").at(-1)).toMatchObject({
      messages: [{ id: "queued", text: "Later", mode: "review" }]
    });
    a.finish();
    await vi.waitFor(() => expect(a.sent).toEqual(["Start", "Later"]));
    a.finish();
    await turn;
    await provider.closeAll();
  });

  it("sends normally when the active turn has already finished", async () => {
    const { provider, send } = setup();
    provider.openChat(record("a"));
    const a = mocks.sessions.get("a")!;
    const turn = send({ type: "steerMessage", text: "Arrived late", mode: "review", chatId: "a" });
    expect(a.steerUserMessage).toHaveBeenCalledExactlyOnceWith("Arrived late", []);
    expect(a.sent).toEqual(["Arrived late"]);
    expect(a.sentModes).toEqual(["review"]);
    a.finish();
    await turn;
    await provider.closeAll();
  });

  it("ignores stale-tab guidance and replays steering bubbles after a reload", async () => {
    const { provider, send, snapshot } = setup();
    provider.openChat(record("a"));
    const a = mocks.sessions.get("a")!;
    const turn = send({ type: "send", text: "Start", mode: "act", chatId: "a" });
    const guidance: UiEvent = { kind: "userMessage", messageId: "guidance", messageTs: 12, text: "Guidance", mode: "act", steering: true };
    a.emit(guidance);
    provider.openChat(record("b"));
    await send({ type: "steerMessage", text: "Stale", mode: "act", chatId: "a" });
    expect(a.steerUserMessage).not.toHaveBeenCalled();
    expect(mocks.sessions.get("b")!.steerUserMessage).not.toHaveBeenCalled();
    await provider.openChatById("a");
    await send({ type: "ready" });
    expect(snapshot().events).toContainEqual(guidance);
    expect(snapshot().busy).toBe(true);
    a.finish();
    await turn;
    await provider.closeAll();
  });
});
