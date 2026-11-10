import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { SideToExt } from "../src/ui/messaging.js";

const mocks = vi.hoisted(() => ({ personalization: "Saved preferences", writeSetting: vi.fn() }));
vi.mock("vscode", () => ({ Uri: { joinPath: (...parts: string[]) => parts.join("/") } }));
vi.mock("../src/config/settings.js", () => ({
  onSettingsChange: () => ({ dispose() {} }),
  readSettings: () => ({ endpoint: "invalid", personalization: mocks.personalization }),
  writeSetting: mocks.writeSetting
}));
import { SideViewProvider } from "../src/ui/sideView/provider.js";

let provider: SideViewProvider;
let receive: (message: SideToExt) => Promise<void>;
const postMessage = vi.fn();
function mount(): void {
  provider.resolveWebviewView({
    webview: {
      asWebviewUri: (uri: string) => uri, postMessage,
      onDidReceiveMessage: (handler: typeof receive) => { receive = handler; return { dispose() {} }; }
    },
    onDidDispose: vi.fn()
  } as unknown as vscode.WebviewView);
}
beforeEach(() => {
  postMessage.mockClear();
  mocks.personalization = "Saved preferences";
  mocks.writeSetting.mockReset().mockImplementation(async (_key, value: string) => { mocks.personalization = value; });
  provider = new SideViewProvider({
    extensionUri: "/extension", extension: { packageJSON: { version: "test" } },
    globalState: { get: () => [], update: vi.fn() }
  } as unknown as vscode.ExtensionContext, () => undefined, vi.fn(), vi.fn(), () => []);
  mount();
});

describe("personalization editor", () => {
  it("keeps drafts in the host across refreshes and webview reloads, then saves or cancels explicitly", async () => {
    await receive({ type: "personalizationDraft", value: "Use British English.\nKeep it concise." });
    provider.pushSettings();
    expect(mocks.writeSetting).not.toHaveBeenCalled();
    mount();
    await receive({ type: "ready" });
    expect(postMessage).toHaveBeenCalledWith({ type: "personalizationEditor", editor: { draft: "Use British English.\nKeep it concise." } });
    await receive({ type: "savePersonalization" });
    expect(mocks.writeSetting).toHaveBeenCalledExactlyOnceWith("personalization", "Use British English.\nKeep it concise.");
    expect(postMessage).toHaveBeenCalledWith({ type: "personalizationEditor", editor: {} });
    await receive({ type: "personalizationDraft", value: "Discard this edit" });
    await receive({ type: "cancelPersonalization" });
    expect(mocks.personalization).toBe("Use British English.\nKeep it concise.");
    expect(mocks.writeSetting).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: "personalizationEditor", editor: {} });
  });

  it("retains a failed draft for retry and allows clearing saved preferences", async () => {
    mocks.writeSetting.mockRejectedValueOnce(new Error("Settings file is read-only"));
    await receive({ type: "personalizationDraft", value: "New preferences" });
    await receive({ type: "savePersonalization" });
    expect(mocks.personalization).toBe("Saved preferences");
    expect(postMessage).toHaveBeenCalledWith({ type: "personalizationEditor", editor: { draft: "New preferences", error: "Settings file is read-only" } });
    await receive({ type: "savePersonalization" });
    expect(mocks.personalization).toBe("New preferences");
    await receive({ type: "personalizationDraft", value: "" });
    await receive({ type: "savePersonalization" });
    expect(mocks.personalization).toBe("");
  });

  it("prevents overlapping saves and resets the draft when settings are reset", async () => {
    let finish!: () => void;
    mocks.writeSetting.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await receive({ type: "personalizationDraft", value: "In flight" });
    const saving = receive({ type: "savePersonalization" });
    await vi.waitFor(() => expect(finish).toBeDefined());
    await receive({ type: "savePersonalization" });
    await receive({ type: "cancelPersonalization" });
    await receive({ type: "personalizationDraft", value: "Stale input" });
    expect(mocks.writeSetting).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({ type: "personalizationEditor", editor: { draft: "In flight", saving: true } });
    finish(); await saving;
    await receive({ type: "personalizationDraft", value: "Unsaved" });
    provider.pushSettings(true);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "personalizationEditor", editor: {} });
  });
});
