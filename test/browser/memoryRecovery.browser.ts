import { test, expect } from "@playwright/test";
import type { ChatRecord } from "../../src/chat/types.js";
import type { MemoryCreation } from "../../src/chat/memory.js";
import { hostMessage, webview } from "./harness.js";

const attemptId = "123e4567-e89b-42d3-a456-426614174002";
function failed(): MemoryCreation {
  return { messageTs: 2, status: "failed", operation: "update", attemptId,
    error: "The server stopped before completing the memory.",
    diagnostic: { stage: "generation", cause: "unexpected_eof", attempt: 3, retryable: true,
      message: "The server stopped before completing the memory.", completion: { completionEvidence: "none", completionTokens: 123 } } };
}
function record(): ChatRecord {
  return { id: "123e4567-e89b-42d3-a456-426614174001", workspaceRoot: "/workspace", title: "Memory recovery", createdAt: 1, updatedAt: 2,
    mode: "act", toolCallingMode: "native", reasoningEffort: "default", totalTokens: 0,
    messages: [{ role: "user", content: "Check parser", ts: 1 }, { role: "assistant", content: "Parser verified.", ts: 2 }], memoryCreations: [failed()] };
}
for (const theme of ["light", "dark"] as const) {
  test(`${theme}: restored memory failures disclose diagnostics and send a guarded retry`, async ({ page }) => {
    await webview(page, theme);
    await hostMessage(page, { kind: "chatLoaded", record: record() });
    const card = page.locator("[data-memory-creation]");
    const heading = card.locator(":scope > summary");
    await expect(heading).toContainText("Memory update failed");
    await heading.click();
    await expect(card).toContainText("server stopped");
    const details = card.getByText("Details", { exact: true });
    await details.click();
    await expect(card).toContainText("Server output tokens: 123");
    // Embedded diagnostics share the parent's surface.
    await expect(card.locator(".tool-output-surface")).toHaveCount(1);
    const retry = card.getByRole("button", { name: "Retry", exact: true });
    await retry.focus(); await page.keyboard.press("Enter");
    expect(await page.evaluate(() => (window as unknown as { posted: unknown[] }).posted)).toContainEqual({ type: "retryMemory", id: record().id, chatId: record().id, attemptId });
    await hostMessage(page, { kind: "memoryCreations", creations: [{ messageTs: 2, operation: "update", status: "retry_wait", attemptId }] });
    await expect(retry).toHaveCount(0);
    await expect(heading).toContainText("Memory retry scheduled");
    await expect(heading).not.toHaveClass(/active-tool-head/);
    await page.reload(); await webview(page, theme);
    await hostMessage(page, { kind: "chatLoaded", record: record() });
    await page.locator("[data-memory-creation] > summary").click();
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  });

  test(`${theme}: memory progress respects a manually paused viewport`, async ({ page }) => {
    await webview(page, theme);
    const rec = record();
    rec.messages = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 ? "assistant" as const : "user" as const,
      content: `Message ${index}: ${"Earlier conversation. ".repeat(15)}`, ts: index + 1
    }));
    rec.memoryCreations = [];
    await hostMessage(page, { kind: "chatLoaded", record: rec });
    const body = page.locator(".chat-body");
    await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await body.hover(); await page.mouse.wheel(0, -600);
    await expect(page.getByRole("button", { name: "Scroll to latest", exact: true })).toBeVisible();
    await hostMessage(page, { kind: "memoryCreations", creations: [{ ...failed(), messageTs: 40 }] });
    expect(await body.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeGreaterThan(100);
    await expect(page.getByRole("button", { name: "Scroll to latest", exact: true })).toBeVisible();
  });
}
