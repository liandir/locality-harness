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
  test(theme + ": per-message loaded memories share disclosure behavior and survive rerenders", async ({ page }) => {
    await webview(page, theme);
    const record: ChatRecord = { id: "chat", workspaceRoot: "/workspace", title: "Notes", mode: "act", toolCallingMode: "native", reasoningEffort: "default", totalTokens: 0, createdAt: 1, updatedAt: 2,
      messages: [{ role: "user", content: "Parser details?", ts: 1 }], memorySelections: [{ messageTs: 1, memories: [note] }] };
    await hostMessage(page, { kind: "chatLoaded", record });
    const details = page.locator("[data-loaded-memories]"), heading = details.locator("summary");
    await expect(heading).toHaveClass(/disclosure-trigger/);
    await heading.click(); await page.mouse.move(990, 5);
    await expect(heading).toBeFocused(); await expect(details).toHaveAttribute("open", "");
    await expect(details.locator(".tool-output-surface")).toHaveCount(1);
    await expect(details.locator("strong")).toContainText("grammar versions");
    await hostMessage(page, { kind: "memorySelections", selections: record.memorySelections! });
    await expect(heading).toBeFocused(); await expect(details).toHaveAttribute("open", "");
    await heading.focus(); await page.keyboard.press("Space"); await expect(details).not.toHaveAttribute("open", "");
    await page.keyboard.press("Enter"); await expect(details).toHaveAttribute("open", "");
    await details.getByRole("button", { name: "Parser", exact: true }).click();
    expect(await posted(page)).toContainEqual({ type: "openMemory", id: note.id, chatId: "chat" });
    await hostMessage(page, { kind: "memorySelections", selections: [{ messageTs: 1, memories: [] }] });
    await expect(details).toHaveCount(0);
  });
}
