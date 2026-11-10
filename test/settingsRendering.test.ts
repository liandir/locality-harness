import { describe, expect, it } from "vitest";
import { renderSettings, renderToolAutoApprovals } from "../src/ui/sideView/webview/settings.js";
import type { SideViewState } from "../src/ui/sideView/webview/types.js";

function state(settings: Record<string, unknown> = {}): SideViewState {
  return {
    tab: "settings", search: "", chats: [], settings, reasoningEffort: "default",
    serverModels: [], openTabs: [], version: "", memories: [], memoryPanel: { editors: [] }
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
      ["model", "false"], ["chat", "false"], ["tools", "true"],
      ["automation", "true"], ["user", "false"], ["reset", "false"]
    ]);
  });

  it("shows personalization directly in User with a safely escaped draft and memory-style controls", () => {
    const view = state({ personalization: "Saved preferences" });
    view.personalizationEditor = { draft: '</textarea><script>bad()</script>\nNew preferences', error: "Could not save <file>" };
    const html = renderSettings(view, new Set(["user"]));
    expect(html).not.toContain('data-settings-section="personalization"');
    expect(html).toContain('for="personalization">Personalization</label>');
    expect(html).toContain('class="settings-textarea"');
    expect(html).toContain('&lt;/textarea&gt;&lt;script&gt;bad()&lt;/script&gt;\nNew preferences');
    expect(html).not.toContain('<script>bad()');
    expect(html).toContain('Could not save &lt;file&gt;');
    expect(html).toContain('id="savePersonalization" class="action-btn icon-btn icon-btn-compact"');
    expect(html).toContain('id="cancelPersonalization" class="action-btn icon-btn icon-btn-compact"');
    expect(html.indexOf('data-settings-section="user"')).toBeLessThan(html.indexOf('id="personalization"'));
  });

  it.each(["memoryEnabled", "memoryAutoLoad"])("keeps %s independent of other memory switches", enabled => {
    const html = renderSettings(state({ [enabled]: true }), new Set());
    for (const key of ["memoryEnabled", "memoryAutoLoad"]) {
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
