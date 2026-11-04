import { test, expect } from "@playwright/test";
import type { ChatRecord } from "../../src/chat/types.js";
import type { WorkspaceNote } from "../../src/chat/workspaceNotes.js";
import { hostMessage, webview } from "./harness.js";
const note: WorkspaceNote = { version: 1, id: "123e4567-e89b-42d3-a456-426614174001", name: "Parser", contents: "Use **grammar versions**.", createdAt: 1, updatedAt: 2, enabled: true };
const managed = { ...note, revision: "current-version" };
const posted = async (page: import("@playwright/test").Page) => page.evaluate(() => (window as unknown as { posted: unknown[] }).posted);
for (const theme of ["light", "dark"] as const) {
  test(theme + ": Memories tab manages notes with pointer and keyboard and retains host-owned state", async ({ page }) => {
    await webview(page, theme, "side");
    const tab = page.getByRole("button", { name: "Memories", exact: true });
    await tab.focus(); await page.keyboard.press("Enter");
    await hostMessage(page, { type: "memories", memories: [managed], warnings: ["Cannot read broken.json"] });
    await expect(tab).toBeFocused();
    await expect(page.getByRole("alert")).toContainText("broken.json");
    const name = page.getByRole("button", { name: "Parser", exact: true });
    await name.click(); await page.mouse.move(990, 5);
    expect(await posted(page)).toContainEqual({ type: "openMemory", id: note.id, readonly: true });
    await expect(name).toBeFocused();
    await expect(name).toHaveCSS("text-decoration-line", "none");
    const edit = page.getByRole("button", { name: "Edit", exact: true });
    await edit.focus(); await page.keyboard.press("Space");
    expect(await posted(page)).toContainEqual({ type: "openMemory", id: note.id, readonly: false });
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    expect(await posted(page)).toContainEqual({ type: "renameMemory", id: note.id, revision: managed.revision });
    const enabled = page.getByRole("checkbox", { name: "Enable Parser", exact: true });
    await enabled.focus(); await page.keyboard.press("Space");
    expect(await posted(page)).toContainEqual({ type: "setMemoryEnabled", id: note.id, enabled: false, revision: managed.revision });
    await hostMessage(page, { type: "memories", memories: [{ ...managed, enabled: false }] });
    await expect(enabled).toBeFocused(); await expect(enabled).not.toBeChecked();
    const remove = page.getByRole("button", { name: "Delete Parser", exact: true });
    await remove.focus(); await page.keyboard.press("Enter");
    expect(await posted(page)).toContainEqual({ type: "deleteMemory", id: note.id, revision: managed.revision });
    await expect(name).toBeVisible(); // Removal waits for the host's confirmed result.
    await hostMessage(page, { type: "memories", memories: [] });
    await expect(name).toHaveCount(0);
    await hostMessage(page, { type: "memories", memories: [managed] });
    const search = page.getByRole("searchbox", { name: "Search memories" });
    await search.fill("missing"); await expect(search).toBeFocused(); await expect(name).toHaveCount(0);
    await search.fill("grammar"); await expect(name).toBeVisible();
    await page.getByRole("button", { name: "Chats", exact: true }).click();
    await hostMessage(page, { type: "chats", chats: [{ id: "chat", title: "Chat", updatedAt: 1 }] });
    await expect(page.locator("[data-memory-toggle]")).toHaveCount(0);
    await page.locator("[data-chat-context]").click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: /memory/i })).toHaveCount(0);
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
