import { test, expect, type Page } from "@playwright/test";
import type { ChatRecord } from "../../src/chat/types.js";
import type { ChatToExt } from "../../src/ui/messaging.js";
import { hostMessage, webview } from "./harness.js";

async function posted(page: Page): Promise<ChatToExt[]> {
  return page.evaluate(() => (window as unknown as { posted: ChatToExt[] }).posted);
}

for (const theme of ["light", "dark"] as const) {
  for (const initialMode of ["review", "plan"] as const) {
    test(`${theme}: draft survives ${initialMode} selection, subsequent mode changes, and reload`, async ({ page }) => {
      await webview(page, theme);
      const input = page.locator("#input");
      const text = "Check the composer\n  Preserve these details.  ";
      await input.fill(text);
      await page.locator("#chatMode").click();
      await expect(input).toHaveValue(text);
      await page.locator(`[data-chat-mode="${initialMode}"]`).click();
      await expect(input).toHaveValue(text);
      expect(await posted(page)).toContainEqual(expect.objectContaining({ type: "setChatMode", mode: initialMode }));
      const saved = (await posted(page)).reverse().find(message => message.type === "saveDraft");
      expect(saved).toMatchObject({ text });
      if (saved?.type !== "saveDraft") throw new Error("Composer did not save its draft");

      const record: ChatRecord = {
        id: "123e4567-e89b-42d3-a456-426614174003", workspaceRoot: "/workspace", title: "Draft",
        createdAt: 1, updatedAt: 1, toolCallingMode: "native", mode: "act",
        reasoningEffort: "default", totalTokens: 0, messages: []
      };
      // The host creates the first session and adopts its saved draft before
      // confirming the mode. Neither update may clear the composer.
      await hostMessage(page, { type: "chatSnapshot", id: record.id,
        events: [{ kind: "chatLoaded", record }], busy: false, draft: saved.text });
      await expect(input).toHaveValue(text);
      await hostMessage(page, { kind: "chatModeChanged", mode: initialMode });
      await expect(input).toHaveValue(text);

      for (const mode of [initialMode === "review" ? "plan" : "review", "act"] as const) {
        await page.locator("#chatMode").click();
        await page.locator(`[data-chat-mode="${mode}"]`).click();
        await hostMessage(page, { kind: "chatModeChanged", mode });
        await expect(input).toHaveValue(text);
        expect(await posted(page)).toContainEqual(expect.objectContaining({ type: "setChatMode", mode, chatId: record.id }));
      }

      await page.reload();
      await webview(page, theme);
      await hostMessage(page, { type: "chatSnapshot", id: record.id,
        events: [{ kind: "chatLoaded", record }], busy: false, draft: saved.text });
      await expect(input).toHaveValue(text);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      expect(await posted(page)).toContainEqual(expect.objectContaining({ type: "send", text: text.trim(), mode: "act", chatId: record.id }));
      await expect(input).toHaveValue("");
    });
  }
}
