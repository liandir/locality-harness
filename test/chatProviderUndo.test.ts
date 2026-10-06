import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { ChatRecord, ChatStorage } from "../src/chat/storage.js";
import type { ChatToExt, ExtToChat } from "../src/ui/messaging.js";

const mocks = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), documents: [] as { uri: { scheme: string; fsPath: string }; isDirty: boolean }[] }));
vi.mock("vscode", () => ({ window: { showWarningMessage: mocks.warning, showErrorMessage: mocks.error }, workspace: { textDocuments: mocks.documents } }));
vi.mock("../src/config/settings.js", () => ({ readSettings: () => ({ reasoningEfforts: {} }) }));
vi.mock("../src/chat/session.js", () => ({ ChatSession: class {} }));
import { ChatViewProvider } from "../src/ui/chatView/provider.js";

beforeEach(() => { vi.clearAllMocks(); mocks.documents.length = 0; mocks.warning.mockResolvedValue("Undo"); });

function fixture() {
  const record = { id: "chat", workspaceRoot: "/tmp", messages: [
    { role: "user", ts: 1, content: "edit" },
    { role: "tool", ts: 2, content: "edited", toolCall: { id: "edit", name: "edit_file", argsJson: "{}", status: "executed",
      fileChange: { path: "a.ts", added: 1, removed: 1, diffPreview: "" },
      fileUndo: { path: "a.ts", previous: "original secret", next: "modified" }, fileUndoState: "available" } }
  ] } as ChatRecord;
  const undo = vi.fn(async (_ts: number, check: (path: string) => Promise<void>) => { await check("/tmp/a.ts"); });
  const session = { getRecord: () => record, isTurnActive: () => false, isPlanning: () => false, undoResponseFiles: undo };
  const storage = { list: vi.fn(async () => []) } as unknown as ChatStorage;
  let currentStorage: ChatStorage | undefined = storage;
  const changed = vi.fn();
  const provider = new ChatViewProvider({} as vscode.ExtensionContext, () => currentStorage, () => "/tmp", vi.fn(), vi.fn(), vi.fn(), changed);
  const internal = provider as unknown as {
    active: { session: typeof session; storage: ChatStorage; removed: boolean; messageLoopRunning: boolean; queuedMessages: unknown[]; open: boolean };
    runtimes: Map<string, unknown>;
    onMessage(message: ChatToExt): Promise<void>;
    prepareMessage(message: ExtToChat): ExtToChat;
  };
  internal.active = { session, storage, removed: false, messageLoopRunning: false, queuedMessages: [], open: true };
  internal.runtimes.set(record.id, internal.active);
  return { internal, undo, record, changed, switchWorkspace: () => { currentStorage = undefined; } };
}

describe("file Undo host action", () => {
  it("confirms the specific batch, checks the file, and refreshes affected views", async () => {
    const f = fixture();
    await f.internal.onMessage({ type: "undoResponseFiles", userMessageTs: 1 });
    expect(mocks.warning).toHaveBeenCalledWith("Undo edits to 1 file?", expect.objectContaining({ modal: true, detail: expect.stringContaining("a.ts") }), "Undo");
    expect(f.undo).toHaveBeenCalledExactlyOnceWith(1, expect.any(Function));
    expect(f.changed).toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("does nothing after cancellation", async () => {
    const f = fixture();
    mocks.warning.mockResolvedValue(undefined);
    await f.internal.onMessage({ type: "undoResponseFiles", userMessageTs: 1 });
    expect(f.undo).not.toHaveBeenCalled();
  });

  it("rechecks workspace identity after the confirmation dialog", async () => {
    const f = fixture();
    mocks.warning.mockImplementation(async () => { f.switchWorkspace(); return "Undo"; });
    await f.internal.onMessage({ type: "undoResponseFiles", userMessageTs: 1 });
    expect(f.undo).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("workspace or chat changed"));
  });

  it("refuses undo while another response can edit the workspace", async () => {
    const f = fixture();
    f.internal.runtimes.set("other", { messageLoopRunning: true });
    await f.internal.onMessage({ type: "undoResponseFiles", userMessageTs: 1 });
    expect(f.undo).not.toHaveBeenCalled();
    expect(mocks.warning).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("all responses"));
  });

  it("refuses to replace an editor's unsaved contents", async () => {
    const f = fixture();
    mocks.documents.push({ uri: { scheme: "file", fsPath: "/tmp/a.ts" }, isDirty: true });
    await f.internal.onMessage({ type: "undoResponseFiles", userMessageTs: 1 });
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("unsaved edits"));
  });

  it("also refuses undo while a managed process from a completed turn is running", async () => {
    const f = fixture();
    f.internal.runtimes.set("server", { runningProcesses: new Set(["dev-server"]) });
    await f.internal.onMessage({ type: "undoResponseFiles", userMessageTs: 1 });
    expect(f.undo).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("managed processes"));
  });

  it("keeps full snapshots in the host when sending saved history to the webview", () => {
    const f = fixture();
    const payload = f.internal.prepareMessage({ kind: "chatLoaded", record: f.record });
    expect(JSON.stringify(payload)).not.toContain("original secret");
    expect(JSON.stringify(payload)).toContain('"fileUndoState":"available"');
    expect(f.record.messages[1].toolCall?.fileUndo?.previous).toBe("original secret");
  });
});
