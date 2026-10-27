import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { SideToExt } from "../src/ui/messaging.js";

const mocks = vi.hoisted(() => ({
  settings: { endpoint: "http://127.0.0.1:8000/v1", model: "qwen", serverType: "auto" } as Record<string, unknown>,
  metadata: vi.fn(), write: vi.fn()
}));
vi.mock("vscode", () => ({ Uri: { joinPath: (...parts: string[]) => parts.join("/") } }));
vi.mock("../src/config/settings.js", () => ({
  onSettingsChange: () => ({ dispose() {} }), readSettings: () => ({ ...mocks.settings }),
  writeSetting: mocks.write
}));
vi.mock("../src/llm/client.js", () => ({
  fetchServerModels: async () => [{ id: "qwen" }], fetchServerMetadata: mocks.metadata
}));
import { SideViewProvider } from "../src/ui/sideView/provider.js";

const metadata = { backend: "vllm", modelAlias: "qwen", contextSize: 8192, supportsVision: true, imageSupport: "unknown" };
beforeEach(() => {
  mocks.settings = { endpoint: "http://127.0.0.1:8000/v1", model: "qwen", serverType: "auto" };
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
  it("rejects stale validation before saving settings or credentials", async () => {
    let finish!: (value: typeof metadata) => void;
    mocks.metadata.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = mount();
    const first = view.receive({ type: "validateEndpoint", url: "http://127.0.0.1:8001/v1", serverType: "vllm", apiKey: "stale-secret", requestId: 1 });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await view.receive({ type: "validateEndpoint", url: "http://127.0.0.1:8002/v1", serverType: "vllm", requestId: 2 });
    finish(metadata); await first;
    expect(mocks.settings.endpoint).toBe("http://127.0.0.1:8002/v1");
    expect(view.entries.size).toBe(0);
    expect(view.postMessage.mock.calls.some(([message]) => message.requestId === 1)).toBe(false);
  });

  it("persists masked credential status across reloads and replaces it by server", async () => {
    const view = mount();
    const url = "http://127.0.0.1:8000/v1";
    await view.receive({ type: "validateEndpoint", url, serverType: "vllm", apiKey: "private-key", requestId: 1 });
    expect(view.entries.size).toBe(1);
    expect(JSON.stringify(view.postMessage.mock.calls)).not.toContain("private-key");
    const restored = mount(view.entries);
    restored.provider.pushSettings();
    await vi.waitFor(() => expect(restored.postMessage).toHaveBeenCalledWith({ type: "serverCredential", endpoint: url, configured: true }));
    await restored.receive({ type: "validateEndpoint", url, serverType: "vllm", apiKey: "replacement-key", requestId: 2 });
    expect([...view.entries.values()]).toEqual(["replacement-key"]);
    expect(JSON.stringify(restored.postMessage.mock.calls)).not.toContain("replacement-key");
  });

  it("discards validation when the backend is changed during discovery", async () => {
    let finish!: (value: typeof metadata) => void;
    mocks.metadata.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = mount();
    const pending = view.receive({ type: "validateEndpoint", url: "http://127.0.0.1:8000/v1", serverType: "vllm", requestId: 3 });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await view.receive({ type: "saveSetting", key: "serverType", value: "llama.cpp" });
    finish(metadata); await pending;
    expect(mocks.settings.serverType).toBe("llama.cpp");
    expect(view.postMessage.mock.calls.some(([message]) => message.requestId === 3)).toBe(false);
  });
});
