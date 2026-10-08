import { describe, expect, it } from "vitest";
import { renderSettings, renderToolAutoApprovals } from "../src/ui/sideView/webview/settings.js";
import type { SideViewState } from "../src/ui/sideView/webview/types.js";

function state(settings: Record<string, unknown> = {}): SideViewState {
  return {
    tab: "settings", search: "", chats: [], settings, reasoningEffort: "default",
    serverModels: [], openTabs: [], version: "", memories: []
  };
}

function input(html: string, id: string): string {
  const match = html.match(new RegExp(`<input id="${id}"[^>]*>`));
  expect(match, `Missing setting ${id}`).not.toBeNull();
  return match![0];
}

describe("settings rendering", () => {
  it("preserves section order and host-owned expansion", () => {
    const html = renderSettings(state(), new Set(["tools", "automation"]));
    expect([...html.matchAll(/data-settings-section="([^"]+)" aria-expanded="([^"]+)"/g)]
      .map(([, section, expanded]) => [section, expanded])).toEqual([
      ["model", "false"], ["tools", "true"], ["chat", "false"],
      ["automation", "true"], ["user", "false"], ["reset", "false"]
    ]);
  });

  it.each(["memoryEnabled", "memoryLoadOnStart", "autoGenerateMemories"])("keeps %s independent of other memory switches", enabled => {
    const html = renderSettings(state({ [enabled]: true }), new Set());
    for (const key of ["memoryEnabled", "memoryLoadOnStart", "autoGenerateMemories"]) {
      expect(input(html, key).includes("checked")).toBe(key === enabled);
    }
  });

  it.each([false, true])("keeps read approvals available for enabled memory tools (memories: %s)", memoryEnabled => {
    const html = renderToolAutoApprovals({ memoryEnabled, readToolsEnabled: false, editToolsEnabled: false });
    expect(input(html, "autoapproveReads").includes("disabled")).toBe(!memoryEnabled);
    expect(input(html, "autoapproveWrites")).toContain("disabled");
  });

  it("retains an unsaved endpoint draft and escapes server-provided labels", () => {
    const view = state({ endpoint: "http://saved:8080", model: 'model<"name' });
    view.endpointDraft = 'http://draft:8081/?key="value"';
    view.serverModels = [{ id: 'model<"name' }];
    const html = renderSettings(view, new Set(["model"]));
    expect(input(html, "endpoint")).toContain('value="http://draft:8081/?key=&quot;value&quot;"');
    expect(html).toContain('value="model&lt;&quot;name" selected>model&lt;&quot;name</option>');
    expect(view.settings.endpoint).toBe("http://saved:8080");
  });
});
