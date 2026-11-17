import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { SideToExt } from "../src/ui/messaging.js";

const mocks = vi.hoisted(() => ({
  settings: { endpoint: "http://127.0.0.1:8000/v1", model: "qwen", serverType: "auto" } as Record<string, unknown>,
  metadata: vi.fn(), write: vi.fn(), verify: vi.fn()
}));
vi.mock("vscode", () => ({ Uri: { joinPath: (...parts: string[]) => parts.join("/") } }));
vi.mock("../src/config/settings.js", () => ({
  onSettingsChange: () => ({ dispose() {} }), readSettings: () => ({ ...mocks.settings }),
  writeSetting: mocks.write
}));
vi.mock("../src/llm/client.js", () => ({
  fetchServerModels: async () => [{ id: "qwen" }], fetchServerMetadata: mocks.metadata
}));
vi.mock("../src/llm/server.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/llm/server.js")>(), verifyServerProtocol: mocks.verify
}));
import { SideViewProvider } from "../src/ui/sideView/provider.js";

const metadata = { backend: "vllm", modelAlias: "qwen", contextSize: 8192, supportsVision: true, imageSupport: "supported" };
beforeEach(() => {
  mocks.settings = { endpoint: "http://127.0.0.1:8000/v1", model: "qwen", serverType: "auto" };
  mocks.verify.mockReset().mockResolvedValue(undefined);
  mocks.metadata.mockReset().mockResolvedValue(metadata);
  mocks.write.mockReset().mockImplementation(async (key: string, value: unknown) => { mocks.settings[key] = value; });
});
function mount(entries = new Map<string, string>()) {
  const secrets = { get: async (key: string) => entries.get(key), store: async (key: string, value: string) => { entries.set(key, value); }, delete: async (key: string) => { entries.delete(key); } };
  const context = { extensionUri: "/extension", secrets, extension: { packageJSON: { version: "2.2.0" } }, globalState: { get: () => [], update: vi.fn() } } as unknown as vscode.ExtensionContext;
  const postMessage = vi.fn();
  let receive!: (message: SideToExt) => Promise<void>;
  const provider = new SideViewProvider(context, () => undefined, vi.fn(), vi.fn(), () => []);
  provider.resolveWebviewView({ webview: { asWebviewUri: (uri: string) => uri, postMessage,
    onDidReceiveMessage: (handler: typeof receive) => { receive = handler; return { dispose() {} }; }
  }, onDidDispose: vi.fn() } as unknown as vscode.WebviewView);
  return { receive, postMessage, provider, entries };
}

describe("host-owned connection state", () => {
  it("waits for a pending protocol save before checking the connection", async () => {
    let finish!: () => void;
    mocks.write.mockImplementationOnce(async (key, value) => {
      await new Promise<void>(resolve => { finish = resolve; });
      mocks.settings[key] = value;
    });
    const view = mount();
    const saving = view.receive({ type: "saveSetting", key: "protocol", value: "chat-completions" });
    const checking = view.receive({ type: "validateEndpoint", url: "http://127.0.0.1:8000/v1", protocol: "chat-completions", requestId: 7 });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(mocks.metadata).not.toHaveBeenCalled();
    finish(); await Promise.all([saving, checking]);
    expect(mocks.verify).toHaveBeenCalledOnce();
    expect(view.postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: 7, protocol: "chat-completions", ok: true }));
  });

  it("invalidates pending validation when protocol changes", async () => {
    let finish!: (value: typeof metadata) => void;
    mocks.metadata.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = mount();
    const pending = view.receive({ type: "validateEndpoint", url: "http://127.0.0.1:8000/v1", protocol: "responses", requestId: 8 });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await view.receive({ type: "saveSetting", key: "protocol", value: "chat-completions" });
    finish(metadata); await pending;
    expect(view.postMessage.mock.calls.some(([message]) => message.requestId === 8)).toBe(false);
    expect(mocks.write).not.toHaveBeenCalledWith("endpoint", expect.anything());
  });

  it("does not save a connection when its selected generation protocol fails", async () => {
    mocks.verify.mockRejectedValueOnce(new Error("Responses is unavailable. Select Chat Completions in Protocol."));
    const view = mount();
    await view.receive({ type: "validateEndpoint", url: "http://127.0.0.1:8000/v1", protocol: "responses", apiKey: "key", requestId: 9 });
    expect(mocks.write).not.toHaveBeenCalled();
    expect(view.entries.size).toBe(0);
    expect(view.postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: 9, ok: false, error: expect.stringContaining("Select Chat Completions") }));
  });

  it("rejects stale validation before saving settings or credentials", async () => {
    let finish!: (value: typeof metadata) => void;
    mocks.metadata.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = mount();
    const first = view.receive({ type: "validateEndpoint", url: "http://127.0.0.1:8001/v1", apiKey: "stale-secret", requestId: 1 });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await view.receive({ type: "validateEndpoint", url: "http://127.0.0.1:8002/v1", requestId: 2 });
    finish(metadata); await first;
    expect(mocks.settings.endpoint).toBe("http://127.0.0.1:8002/v1");
    expect(view.entries.size).toBe(0);
    expect(view.postMessage.mock.calls.some(([message]) => message.requestId === 1)).toBe(false);
  });

  it("persists masked credential status across reloads and replaces it by server", async () => {
    const view = mount();
    const url = "http://127.0.0.1:8000/v1";
    await view.receive({ type: "validateEndpoint", url, apiKey: "private-key", requestId: 1 });
    expect(mocks.metadata).toHaveBeenCalledWith(url, { model: "qwen", force: true, probeImages: true });
    expect(mocks.write).not.toHaveBeenCalledWith("serverType", expect.anything());
    expect(view.entries.size).toBe(1);
    expect(JSON.stringify(view.postMessage.mock.calls)).not.toContain("private-key");
    const restored = mount(view.entries);
    restored.provider.pushSettings();
    await vi.waitFor(() => expect(restored.postMessage).toHaveBeenCalledWith({ type: "serverCredential", endpoint: url, configured: true }));
    await restored.receive({ type: "validateEndpoint", url, apiKey: "replacement-key", requestId: 2 });
    expect([...view.entries.values()]).toEqual(["replacement-key"]);
    expect(JSON.stringify(restored.postMessage.mock.calls)).not.toContain("replacement-key");
  });

  it("discards validation when the model is changed during the image check", async () => {
    let finish!: (value: typeof metadata) => void;
    mocks.metadata.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = mount();
    const pending = view.receive({ type: "validateEndpoint", url: "http://127.0.0.1:8000/v1", requestId: 3 });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await view.receive({ type: "saveSetting", key: "model", value: "replacement-model" });
    finish(metadata); await pending;
    expect(mocks.settings.model).toBe("replacement-model");
    expect(view.postMessage.mock.calls.some(([message]) => message.requestId === 3)).toBe(false);
  });

  it("does not save the connection or key when image probing fails", async () => {
    mocks.metadata.mockRejectedValueOnce(new Error("Image support check returned HTTP 401."));
    const view = mount();
    await view.receive({ type: "validateEndpoint", url: "http://127.0.0.1:8001", apiKey: "wrong", requestId: 4 });
    expect(mocks.write).not.toHaveBeenCalled();
    expect(view.entries.size).toBe(0);
    expect(view.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "endpointValidation", protocol: "responses", requestId: 4, ok: false, error: expect.stringContaining("HTTP 401") }));
  });
});
