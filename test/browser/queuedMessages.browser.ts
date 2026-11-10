import { test, expect } from "@playwright/test";
import type { ChatRecord } from "../../src/chat/types.js";
import type { ChatToExt, UiQueuedMessage } from "../../src/ui/messaging.js";
import { hostMessage, webview } from "./harness.js";

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: queued messages can steer by pointer, Enter, and Space without clearing the composer`, async ({ page }) => {
    await webview(page, theme);
    const record: ChatRecord = {
      id: "123e4567-e89b-42d3-a456-426614174004", workspaceRoot: "/workspace", title: "Queued guidance",
      createdAt: 1, updatedAt: 1, toolCallingMode: "native", mode: "act", reasoningEffort: "default", totalTokens: 0,
      messages: [{ role: "user", content: "Start the task", mode: "act", ts: 1 }]
    };
    await hostMessage(page, { kind: "chatLoaded", record });
    let messages: UiQueuedMessage[] = [
      { id: "first", text: "First follow-up", mode: "review" },
      { id: "guidance", text: "Change direction", mode: "plan" },
      { id: "last", text: "Last follow-up", mode: "act" }
    ];
    await hostMessage(page, { type: "messageQueue", messages });
    const guidance = page.locator('[data-queued-message-id="guidance"]');
    await expect(guidance.getByRole("button", { name: "Steer", exact: true })).toBeDisabled();
    await hostMessage(page, { kind: "turnStart", messageId: "response" });
    await page.locator("#input").fill("Unsent composer draft");
    await guidance.getByRole("button", { name: "Steer", exact: true }).click();
    // Queue ownership remains with the host until the running session accepts it.
    await expect(guidance).toBeVisible();
    messages = messages.filter(message => message.id !== "guidance");
    await hostMessage(page, { type: "messageQueue", messages });
    await expect(guidance).toHaveCount(0);
    await expect(page.locator(".queued-message-text")).toHaveText(["First follow-up", "Last follow-up"]);
    await expect(page.locator("#input")).toHaveValue("Unsent composer draft");

    for (const [id, key] of [["first", "Enter"], ["last", "Space"]]) {
      const steer = page.locator(`[data-queued-message-id="${id}"]`).getByRole("button", { name: "Steer", exact: true });
      await steer.focus();
      await page.keyboard.press(key);
      messages = messages.filter(message => message.id !== id);
      await hostMessage(page, { type: "messageQueue", messages });
    }
    const posted = await page.evaluate(() => (window as unknown as { posted: ChatToExt[] }).posted);
    expect(posted.filter(message => message.type === "steerQueuedMessage")).toEqual([
      { type: "steerQueuedMessage", id: "guidance", chatId: record.id },
      { type: "steerQueuedMessage", id: "first", chatId: record.id },
      { type: "steerQueuedMessage", id: "last", chatId: record.id }
    ]);
    expect(posted.some(message => message.type === "cancel" || message.type === "removeQueuedMessage")).toBe(false);
    await expect(page.locator("#messageQueue")).toBeHidden();
    await expect(page.locator("#input")).toHaveValue("Unsent composer draft");
  });

  test(`${theme}: queue edits must be saved before steering and a stopped response disables steering`, async ({ page }) => {
    await webview(page, theme);
    await hostMessage(page, { kind: "turnStart", messageId: "response" });
    const message: UiQueuedMessage = { id: "guidance", text: "Original guidance", mode: "act" };
    await hostMessage(page, { type: "messageQueue", messages: [message] });
    const queued = page.locator('[data-queued-message-id="guidance"]');
    await queued.getByRole("button", { name: "Edit queued message", exact: true }).click();
    await page.getByRole("textbox", { name: "Edit queued message", exact: true }).fill("Updated guidance");
    await expect(queued.getByRole("button", { name: "Steer", exact: true })).toHaveCount(0);
    await queued.getByRole("button", { name: "Save queued message", exact: true }).click();
    await queued.getByRole("button", { name: "Steer", exact: true }).click();
    const actions = await page.evaluate(() => (window as unknown as { posted: ChatToExt[] }).posted
      .filter(message => message.type === "updateQueuedMessage" || message.type === "steerQueuedMessage"));
    expect(actions).toMatchObject([
      { type: "updateQueuedMessage", id: message.id, text: "Updated guidance" },
      { type: "steerQueuedMessage", id: message.id }
    ]);
    // A refused transfer refreshes the queue without losing the message.
    await hostMessage(page, { type: "messageQueue", messages: [{ ...message, text: "Updated guidance" }] });
    await hostMessage(page, { kind: "abort", reason: "Stopped by user.", messageTs: 2 });
    await expect(queued.locator(".queued-message-text")).toHaveText("Updated guidance");
    await expect(queued.getByRole("button", { name: "Steer", exact: true })).toBeDisabled();
  });
}
