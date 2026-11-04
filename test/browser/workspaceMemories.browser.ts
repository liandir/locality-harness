import { test, expect } from "@playwright/test";
import type { ChatRecord } from "../../src/chat/types.js";
import type { MemoryEditor } from "../../src/ui/messaging.js";
import type { WorkspaceNote } from "../../src/chat/workspaceNotes.js";
import { hostMessage, webview } from "./harness.js";
const note: WorkspaceNote = { version: 1, id: "123e4567-e89b-42d3-a456-426614174001", name: "Parser", contents: "### Reminder\n\nUse **grammar versions**.", createdAt: 1, updatedAt: 2, enabled: true };
const managed = { ...note, revision: "current-version" };
const posted = async (page: import("@playwright/test").Page) => page.evaluate(() => (window as unknown as { posted: unknown[] }).posted);
for (const theme of ["light", "dark"] as const) {
  test(theme + ": clear all memories matches chat colors and geometry and waits for host confirmation", async ({ page }) => {
    await webview(page, theme, "side");
    await hostMessage(page, { type: "focusTab", tab: "chats" });
    await hostMessage(page, { type: "chats", chats: [{ id: "chat", title: "Chat", updatedAt: 1 }] });
    const appearance = (button: HTMLElement) => {
      const style = getComputedStyle(button);
      return { width: style.width, height: style.height, radius: style.borderRadius, padding: style.padding, font: style.font,
        marginTop: style.marginTop, color: style.color, background: style.backgroundColor, border: style.borderColor, shadow: style.boxShadow };
    };
    const clearChats = page.getByRole("button", { name: "Clear all chats" });
    const chatResting = await clearChats.evaluate(appearance);
    await clearChats.hover();
    const chatHover = await clearChats.evaluate(appearance);
    await clearChats.click(); await page.mouse.move(990, 5);
    await expect(clearChats).toBeFocused();
    expect(await clearChats.evaluate(appearance)).toEqual(chatResting);
    await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
    await expect(clearChats).toBeFocused();
    const chatFocus = await clearChats.evaluate(appearance);
    await hostMessage(page, { type: "focusTab", tab: "memories" });
    await hostMessage(page, { type: "memories", memories: [managed, { ...managed, id: "disabled", name: "Disabled", enabled: false }] });
    const clear = page.getByRole("button", { name: "Clear all memories" });
    expect(await clear.evaluate(appearance)).toEqual(chatResting);
    const red = await clear.evaluate(button => {
      const probe = document.createElement("span"); probe.style.color = "var(--error-highlight-foreground)"; button.append(probe);
      const color = getComputedStyle(probe).color; probe.remove(); return color;
    });
    await clear.hover(); await expect(clear).toHaveCSS("color", red);
    expect(await clear.evaluate(appearance)).toEqual(chatHover);
    expect(chatHover.background).not.toBe(chatResting.background);
    await clear.click(); await page.mouse.move(990, 5);
    expect(await posted(page)).toContainEqual({ type: "clearMemories" });
    await expect(page.locator(".memory-entry")).toHaveCount(2);
    await expect(clear).toBeFocused();
    expect(await clear.evaluate(appearance)).toEqual(chatResting);
    await page.getByRole("searchbox", { name: "Search memories" }).fill("no matches");
    await expect(page.locator(".memory-entry")).toHaveCount(0); await expect(clear).toBeVisible();
    await page.keyboard.press("Tab"); await expect(clear).toBeFocused();
    expect(await clear.evaluate(appearance)).toEqual(chatFocus);
    await expect(clear).toHaveCSS("color", red); await page.keyboard.press("Enter"); await page.keyboard.press("Space");
    await hostMessage(page, { type: "memories", memories: [managed] });
    await hostMessage(page, { type: "memoryError", error: "Some memories could not be deleted." });
    await expect(page.getByRole("alert")).toContainText("could not be deleted");
    await expect(clear).toBeVisible();
    await hostMessage(page, { type: "memories", memories: [] });
    await expect(clear).toHaveCount(0);
  });
  test(theme + ": memory rows match chats and support inline viewing, keyboard actions and the shared menu", async ({ page }) => {
    await webview(page, theme, "side");
    await page.getByRole("button", { name: "Memories", exact: true }).click();
    await hostMessage(page, { type: "memories", memories: [managed], warnings: ["Cannot read broken.json"] });
    await expect(page.getByRole("alert")).toContainText("broken.json");
    await expect(page.getByRole("button", { name: "Create new memory" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Open", exact: true })).toHaveCount(0);
    const row = page.locator("[data-memory-open]");
    await expect(row).toHaveClass(/chat-row/);
    await expect(row).toHaveCSS("height", "24px");
    await expect(row.locator(".memory-enabled-dot")).toHaveCSS("background-color", theme === "dark" ? "rgb(204, 204, 204)" : "rgb(51, 51, 51)");
    await row.click(); await page.mouse.move(990, 5);
    expect(await posted(page)).toContainEqual({ type: "openMemory", id: note.id, readonly: true });
    const editor: MemoryEditor = { key: "editor", id: note.id, name: note.name, contents: note.contents, revision: managed.revision, mode: "view", draftName: note.name, draftContents: note.contents };
    await hostMessage(page, { type: "memoryPanel", panel: { editors: [editor], activeKey: editor.key } });
    await expect(row).toBeFocused(); await expect(row).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".memory-markdown strong")).toHaveText("grammar versions");
    await expect(page.locator(".memory-markdown h3")).toHaveCSS("text-transform", "none");
    await expect(page.locator(".memory-markdown h3")).toHaveCSS("display", "block");
    await expect(page.locator(".memory-markdown")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.keyboard.press("Space");
    expect(await posted(page)).toContainEqual({ type: "closeMemoryEditor", key: editor.key });
    await hostMessage(page, { type: "memoryPanel", panel: { editors: [editor] } });
    await expect(row).toBeFocused(); await expect(row).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    expect(await posted(page)).not.toContainEqual({ type: "openChat", id: undefined });
    await hostMessage(page, { type: "memoryPanel", panel: { editors: [editor], activeKey: editor.key } });
    await page.getByRole("button", { name: "Edit memory", exact: true }).click();
    expect(await posted(page)).toContainEqual({ type: "openMemory", id: note.id, readonly: false });
    await hostMessage(page, { type: "memoryPanel", panel: { editors: [{ ...editor, mode: "edit" }], activeKey: editor.key } });
    const contents = page.getByRole("textbox", { name: "Memory contents" });
    await expect(contents).toBeFocused(); await contents.fill("Unsaved **decision**");
    await hostMessage(page, { type: "memories", memories: [managed] });
    await expect(contents).toBeFocused(); await expect(contents).toHaveValue("Unsaved **decision**");
    await page.getByRole("button", { name: "Save memory", exact: true }).click();
    expect(await posted(page)).toContainEqual({ type: "memoryDraft", key: editor.key, contents: "Unsaved **decision**" });
    expect(await posted(page)).toContainEqual({ type: "saveMemoryEditor", key: editor.key });
    await hostMessage(page, { type: "memoryPanel", panel: { editors: [{ ...editor, mode: "edit", draftContents: "Unsaved **decision**", error: "This memory changed. Reopen it." }], activeKey: editor.key } });
    await expect(contents).toHaveValue("Unsaved **decision**");
    await expect(page.getByRole("alert")).toContainText("This memory changed");
    await page.getByRole("button", { name: "Cancel edit" }).click();
    expect(await posted(page)).toContainEqual({ type: "cancelMemoryEditor", key: editor.key });
    await hostMessage(page, { type: "memoryPanel", panel: { editors: [editor], activeKey: editor.key } });
    await row.focus(); await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menu")).toHaveClass(/chat-context-menu/);
    await expect(page.getByRole("menuitem")).toHaveText(["View memory", "Edit memory", "Disable memory", "Rename memory", "Delete memory"]);
    await page.getByRole("menuitem", { name: "Disable memory" }).click();
    expect(await posted(page)).toContainEqual({ type: "setMemoryEnabled", id: note.id, enabled: false, revision: managed.revision });
    await hostMessage(page, { type: "memories", memories: [{ ...managed, enabled: false }] });
    await expect(row.locator(".memory-enabled-dot")).not.toHaveClass(/enabled$/);
    await row.click({ button: "right" }); await page.getByRole("menuitem", { name: "Rename memory" }).click();
    expect(await posted(page)).toContainEqual({ type: "renameMemory", id: note.id, revision: managed.revision });
    await hostMessage(page, { type: "memoryPanel", panel: { editors: [{ ...editor, mode: "name" }], activeKey: editor.key } });
    const name = page.getByRole("textbox", { name: "Memory name" });
    await expect(name).toBeFocused(); await name.fill("Renamed"); await page.keyboard.press("Escape");
    await hostMessage(page, { type: "memoryPanel", panel: { editors: [editor], activeKey: editor.key } });
    await row.click({ button: "right" }); await page.getByRole("menuitem", { name: "Delete memory" }).click();
    expect(await posted(page)).toContainEqual({ type: "deleteMemory", id: note.id, revision: managed.revision });
    await expect(row).toBeVisible(); // The host owns deletion and its confirmation.
    await hostMessage(page, { type: "memoryPanel", panel: { editors: [] } });
    await hostMessage(page, { type: "memories", memories: [] }); await expect(row).toHaveCount(0);
    await hostMessage(page, { type: "memories", memories: [managed] });
    const search = page.getByRole("searchbox", { name: "Search memories" });
    await search.fill("missing"); await expect(search).toBeFocused(); await expect(row).toHaveCount(0);
    await search.fill("grammar"); await expect(row).toBeVisible();
    await page.getByRole("button", { name: "Chats", exact: true }).click();
    await hostMessage(page, { type: "chats", chats: [{ id: "chat", title: "Chat", updatedAt: 1 }] });
    await page.locator("[data-chat-context]").click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: /memory/i })).toHaveCount(0);
  });

  test(theme + ": new memories are named first and inline drafts restore after reload", async ({ page }) => {
    await webview(page, theme, "side");
    await hostMessage(page, { type: "focusTab", tab: "memories" });
    await page.getByRole("button", { name: "Create new memory" }).click();
    expect(await posted(page)).toContainEqual({ type: "newMemory" });
    const draft: MemoryEditor = { key: "new-draft", name: "", contents: "", mode: "name", draftName: "", draftContents: "" };
    await hostMessage(page, { type: "memoryPanel", panel: { editors: [draft], activeKey: draft.key } });
    const name = page.getByRole("textbox", { name: "Memory name" });
    await expect(name).toHaveCSS("height", "24px");
    await expect(page.locator(".memory-name-row")).toHaveCSS("height", "24px");
    for (const button of [page.getByRole("button", { name: "Cancel edit" }), page.getByRole("button", { name: "Confirm name" })]) {
      await expect(button).toHaveCSS("width", "20px"); await expect(button).toHaveCSS("height", "20px");
    }
    await expect(name).toBeFocused(); await name.fill("New memory"); await page.keyboard.press("Enter");
    expect(await posted(page)).toContainEqual({ type: "memoryDraft", key: draft.key, name: "New memory" });
    Object.assign(draft, { name: "New memory", draftName: "New memory", mode: "edit" });
    await hostMessage(page, { type: "memoryPanel", panel: { editors: [draft], activeKey: draft.key } });
    const contents = page.getByRole("textbox", { name: "Memory contents" });
    await expect(contents).toBeFocused(); await contents.fill("# New contents");
    draft.draftContents = "# New contents";
    await page.reload(); await webview(page, theme, "side");
    await hostMessage(page, { type: "memoryPanel", panel: { editors: [draft], activeKey: draft.key } });
    await hostMessage(page, { type: "focusTab", tab: "memories" });
    await expect(contents).toHaveValue("# New contents");
    await expect(page.locator(".chat-row-title")).toHaveText("New memory");
    const cancel = page.getByRole("button", { name: "Cancel edit" }), save = page.getByRole("button", { name: "Save memory" });
    for (const button of [cancel, save]) {
      await expect(button).toHaveCSS("width", "20px"); await expect(button).toHaveCSS("height", "20px");
    }
    await save.focus(); await page.keyboard.press("Space");
    expect(await posted(page)).toContainEqual({ type: "saveMemoryEditor", key: draft.key });
    const saved = { ...managed, name: draft.name, contents: draft.draftContents };
    await hostMessage(page, { type: "memories", memories: [saved] });
    await hostMessage(page, { type: "memoryPanel", panel: { editors: [{ ...draft, id: saved.id, contents: saved.contents, revision: saved.revision, mode: "view" }], activeKey: draft.key } });
    await expect(page.locator(".memory-entry")).toHaveCount(1);
    await expect(page.locator(".memory-markdown h1")).toHaveText("New contents");
    await expect(page.locator(".memory-enabled-dot")).toHaveClass(/enabled$/);
  });
  test(theme + ": memory settings have independent tools and per-query loading without generation", async ({ page }) => {
    await webview(page, theme, "side");
    await hostMessage(page, { type: "settings", settings: { memoryEnabled: true, memoryAutoLoad: false }, reasoningEffort: "default" });
    await hostMessage(page, { type: "focusTab", tab: "settings" });
    await page.locator('[data-settings-section="tools"]').click();
    await expect(page.getByLabel("Activate memories", { exact: true })).toBeChecked();
    await page.locator('[data-settings-section="chat"]').click();
    const auto = page.getByLabel("Auto-load memories", { exact: true });
    await expect(auto).not.toBeChecked(); await auto.focus(); await page.keyboard.press("Space");
    expect(await posted(page)).toContainEqual({ type: "saveSetting", key: "memoryAutoLoad", value: true });
    await expect(page.locator("#autoGenerateMemories")).toHaveCount(0);
  });
  for (const outcome of ["completed", "failed"] as const) {
    test(theme + ": auto recalls join " + outcome + " work and retain shared disclosure behavior", async ({ page }) => {
      await webview(page, theme);
      const second = { ...note, id: "123e4567-e89b-42d3-a456-426614174002", name: "Grammar" };
      const record: ChatRecord = { id: "chat", workspaceRoot: "/workspace", title: "Notes", mode: "act", toolCallingMode: "native", reasoningEffort: "default", totalTokens: 0, createdAt: 1, updatedAt: 3,
        messages: [{ role: "user", content: "Parser details?", ts: 1 }, { role: "assistant", content: outcome === "completed" ? "Parser checked." : "", ts: 3,
          interruption: outcome === "failed" ? { reason: "Server disconnected", mode: "act", reasoningEffort: "default" } : undefined }],
        memorySelections: [{ messageTs: 1, memories: [note, second] }] };
      await hostMessage(page, { kind: "chatLoaded", record });
      await expect(page.locator("[data-loaded-memories]")).toHaveCount(0);
      await expect(page.locator(".msg.user .tool-card")).toHaveCount(0);
      const work = page.locator(".work-section.conglomerate");
      await expect(work.locator(":scope > .work-head")).toContainText("Worked");
      await expect(work.locator(":scope > .work-head")).toHaveAttribute("aria-expanded", "false");
      for (let depth = 0; depth < 3 && !await page.locator(".tool-card").count(); depth++) {
        await page.locator('.work-head[aria-expanded="false"]:visible').first().click();
      }
      const cards = work.locator(".tool-card");
      await expect(cards).toHaveCount(2);
      await expect(cards.locator(".tool-name")).toHaveText(["Recalled", "Recalled"]);
      await expect(cards.locator(".tool-label")).toHaveText(["Parser", "Grammar"]);
      const card = cards.first(), heading = card.locator(":scope > .tool-head");
      await expect(heading).toHaveClass(/disclosure-trigger/);
      await page.mouse.move(990, 5);
      const resting = await heading.evaluate(el => getComputedStyle(el).color);
      await heading.hover();
      await expect(heading).not.toHaveCSS("color", resting);
      await heading.locator(".tool-name").click(); await page.mouse.move(990, 5);
      await expect(heading).toHaveAttribute("aria-expanded", "true");
      await expect(heading).toHaveCSS("color", resting);
      await expect(card.locator(".tool-output-surface")).toHaveCount(1);
      await expect(card.locator(".tool-output-surface strong")).toHaveText("grammar versions");
      await heading.focus(); await page.keyboard.press("Space");
      await expect(heading).toHaveAttribute("aria-expanded", "false");
      await page.keyboard.press("Enter");
      await expect(heading).toHaveAttribute("aria-expanded", "true");
      await expect(heading).toBeFocused();
      await hostMessage(page, { kind: "memorySelections", selections: record.memorySelections! });
      await expect(cards).toHaveCount(2); await expect(heading).toBeFocused();
      await expect(heading).toHaveAttribute("aria-expanded", "true");
      await card.getByRole("button", { name: "Parser", exact: true }).click();
      expect(await posted(page)).toContainEqual({ type: "openMemory", id: note.id, chatId: "chat" });
      // Tab switches and host snapshots preserve the ordinary tool/work expansion state.
      await hostMessage(page, { type: "chatSnapshot", id: "other", busy: false, draft: "", events: [] });
      await hostMessage(page, { type: "chatSnapshot", id: "chat", busy: false, draft: "", events: [{ kind: "chatLoaded", record }] });
      await expect(cards).toHaveCount(2);
      await expect(heading).toHaveAttribute("aria-expanded", "true");
      if (outcome === "failed") await expect(page.locator(".abort")).toContainText("Server disconnected");
      else await expect(page.locator(".assistant-markdown").last()).toContainText("Parser checked.");
    });
  }

  test(theme + ": live auto recalls follow steering and collapse with finished work", async ({ page }) => {
    await webview(page, theme);
    const record: ChatRecord = { id: "chat", workspaceRoot: "/workspace", title: "Notes", mode: "act", toolCallingMode: "native", reasoningEffort: "default", totalTokens: 0, createdAt: 1, updatedAt: 1,
      messages: [{ role: "user", content: "Parser details?", ts: 1 }] };
    await hostMessage(page, { kind: "chatLoaded", record });
    await hostMessage(page, { kind: "turnWorkStarted", messageId: "response", startedAt: 2 });
    await hostMessage(page, { kind: "memorySelections", selections: [{ messageTs: 1, memories: [note] }] });
    await expect(page.locator(".tool-name")).toHaveText("Recalled");
    await expect(page.locator(".tool-label")).toHaveText("Parser");
    await expect(page.locator(".tool-head")).not.toHaveClass(/active-tool-head/);
    await hostMessage(page, { kind: "text", messageId: "response", delta: "Checking parser." });
    await hostMessage(page, { kind: "userMessage", messageId: "steer", messageTs: 4, text: "Colors", mode: "act", steering: true });
    const colors = { ...note, name: "Colors", id: "123e4567-e89b-42d3-a456-426614174003" };
    await hostMessage(page, { kind: "memorySelections", selections: [{ messageTs: 1, memories: [note] }, { messageTs: 4, memories: [colors] }] });
    await expect(page.locator(".tool-label").last()).toHaveText("Colors");
    await hostMessage(page, { kind: "text", messageId: "response", delta: "Colors checked." });
    await hostMessage(page, { kind: "turnEnd", messageId: "response", mode: "act", messageTs: 6 });
    const summary = page.locator(".work-section.conglomerate > .work-head");
    await expect(summary).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".tool-card")).toHaveCount(0);
    await summary.click();
    for (let depth = 0; depth < 3 && await page.locator('.work-head[aria-expanded="false"]:visible').count(); depth++) {
      await page.locator('.work-head[aria-expanded="false"]:visible').first().click();
    }
    await expect(page.locator(".work-section.conglomerate .tool-name")).toHaveText(["Recalled", "Recalled"]);
    const timeline = await page.locator(".work-section.conglomerate > .work-body").innerText();
    expect(timeline.indexOf("Parser")).toBeLessThan(timeline.indexOf("Checking parser."));
    expect(timeline.indexOf("Checking parser.")).toBeLessThan(timeline.indexOf("Colors"));
    expect(timeline.lastIndexOf("Recalled")).toBeGreaterThan(timeline.indexOf("Colors"));
    await expect(page.locator("[data-loaded-memories]")).toHaveCount(0);
  });
}
