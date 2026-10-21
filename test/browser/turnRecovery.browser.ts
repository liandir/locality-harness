import { test, expect, type Page } from "@playwright/test";
import type { ChatRecord } from "../../src/chat/types.js";
import { hostMessage, webview } from "./harness.js";

function record(plan = false): ChatRecord {
  return {
    id: "123e4567-e89b-42d3-a456-426614174002", workspaceRoot: "/workspace", title: "Recovery",
    createdAt: 1, updatedAt: 4, toolCallingMode: "native", mode: plan ? "plan" : "act",
    planning: plan, reasoningEffort: "default", totalTokens: 100,
    messages: [
      { role: "user", content: "Inspect the code", ts: 1 },
      { role: "assistant", content: "", reasoningContent: "Thinking through the files", events: [{ kind: "thought", text: "Thinking through the files", t: 2 }], ts: 3 },
      { role: "assistant", content: "", ts: 4, interruption: {
        reason: "The server stream ended before confirming completion. The response is incomplete.",
        mode: plan ? "plan" : "act", reasoningEffort: "default",
        diagnostics: { cause: "unexpected_eof", completionEvidence: "none", completionTokens: 30751 }
      } }
    ]
  };
}

async function posted(page: Page) {
  return page.evaluate(() => (window as unknown as { posted: unknown[] }).posted);
}

for (const theme of ["light", "dark"] as const) {
  test.describe(theme, () => {
    test("a restored interruption stays outside collapsed work and exposes diagnostics and Continue", async ({ page }) => {
      await webview(page, theme);
      await hostMessage(page, { kind: "chatLoaded", record: record() });
      const error = page.locator(".abort-part");
      await expect(error).toBeVisible();
      await expect(error).toContainText("response is incomplete");
      expect(await error.evaluate(element => !!element.closest(".work-section"))).toBe(false);
      const details = page.getByText("Details", { exact: true });
      await page.mouse.move(990, 5);
      const resting = await details.evaluate(element => getComputedStyle(element).color);
      await details.click();
      await page.mouse.move(990, 5);
      await expect(details).toHaveCSS("color", resting);
      await expect(error).toContainText("30751");
      await details.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(".interruption-details")).not.toHaveAttribute("open");
      await page.keyboard.press("Space");
      await expect(page.locator(".interruption-details")).toHaveAttribute("open", "");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      expect(await posted(page)).toContainEqual(expect.objectContaining({ type: "continueChat", messageTs: 4 }));
    });

    test("failed live turns show their error and let the user release queued work", async ({ page }) => {
      await webview(page, theme);
      const initial = record();
      initial.messages = initial.messages.slice(0, 1);
      await hostMessage(page, { kind: "chatLoaded", record: initial });
      await hostMessage(page, { kind: "turnWorkStarted", messageId: "response", startedAt: 2 });
      await hostMessage(page, { kind: "turnStart", messageId: "response" });
      await hostMessage(page, { kind: "thought", messageId: "response", delta: "Thinking" });
      await hostMessage(page, { type: "messageQueue", messages: [{ id: "next", text: "Next task", mode: "act" }] });
      await hostMessage(page, { kind: "abort", reason: "The server sent malformed streaming data.", messageTs: 4, diagnostics: { cause: "protocol_error" } });
      await expect(page.locator(".abort-part")).toBeVisible();
      await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Run queued messages" }).click();
      expect(await posted(page)).toContainEqual(expect.objectContaining({ type: "resumeMessageQueue", messageTs: 4 }));
    });

    test("incomplete planning keeps its normal composer and cancellation without plan approval", async ({ page }) => {
      await webview(page, theme);
      await hostMessage(page, { kind: "chatLoaded", record: record(true) });
      await expect(page.getByRole("button", { name: "Accept plan", exact: true })).toHaveCount(0);
      await expect(page.locator("#input")).toBeVisible();
      await page.locator("#input").fill("Please finish planning");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      expect(await posted(page)).toContainEqual(expect.objectContaining({ type: "send", text: "Please finish planning", mode: "plan" }));
      // Restoring persisted state restores the same incomplete composer.
      await page.reload();
      await webview(page, theme);
      await hostMessage(page, { kind: "chatLoaded", record: record(true) });
      await page.getByRole("button", { name: "Cancel planning", exact: true }).click();
      expect(await posted(page)).toContainEqual(expect.objectContaining({ type: "cancelPlanning" }));
    });

    test("approval appears only after submission completes and survives reload", async ({ page }) => {
      await webview(page, theme);
      const initial = record(true);
      initial.messages = initial.messages.slice(0, 1);
      await hostMessage(page, { kind: "chatLoaded", record: initial });
      await hostMessage(page, { kind: "turnStart", messageId: "plan" });
      await hostMessage(page, { kind: "text", messageId: "plan", delta: "- [ ] Implement\n- [ ] Verify" });
      await hostMessage(page, { kind: "planFinal", messageId: "plan", messageTs: 5, markdown: "- [ ] Implement\n- [ ] Verify" });
      await expect(page.getByRole("button", { name: "Accept plan", exact: true })).toHaveCount(0);
      await hostMessage(page, { kind: "turnEnd", messageId: "plan", mode: "plan", messageTs: 5 });
      await expect(page.getByRole("button", { name: "Accept plan", exact: true })).toBeEnabled();
      initial.messages.push({ role: "assistant", content: "- [ ] Implement\n- [ ] Verify", ts: 5 });
      initial.pendingPlanMessageTs = 5;
      await hostMessage(page, { kind: "chatLoaded", record: initial });
      await page.getByRole("button", { name: "Accept plan", exact: true }).click();
      expect(await posted(page)).toContainEqual(expect.objectContaining({ type: "acceptPlan", messageTs: 5 }));
    });

    test("an interruption does not resume following after the user scrolls up", async ({ page }) => {
      await webview(page, theme);
      const initial = record();
      initial.messages = Array.from({ length: 40 }, (_, index) => ({
        role: index % 2 ? "assistant" as const : "user" as const,
        content: `Message ${index}: ${"Earlier conversation. ".repeat(15)}`, ts: index + 1
      }));
      initial.messages.push({ role: "user", content: "Continue investigating", ts: 41 });
      await hostMessage(page, { kind: "chatLoaded", record: initial });
      const body = page.locator(".chat-body");
      await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await body.hover();
      await page.mouse.wheel(0, -600);
      await expect(page.getByRole("button", { name: "Scroll to latest", exact: true })).toBeVisible();
      await hostMessage(page, { kind: "turnStart", messageId: "interrupted" });
      await hostMessage(page, { kind: "thought", messageId: "interrupted", delta: "More investigation" });
      await hostMessage(page, { kind: "abort", reason: "Connection interrupted", messageTs: 42, diagnostics: { cause: "transport" } });
      await expect(page.getByRole("button", { name: "Scroll to latest", exact: true })).toBeVisible();
      expect(await body.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeGreaterThan(100);
    });

    test("a dangling saved approval timestamp cannot create an approval panel", async ({ page }) => {
      await webview(page, theme);
      const initial = record(true);
      initial.pendingPlanMessageTs = 99;
      await hostMessage(page, { kind: "chatLoaded", record: initial });
      await expect(page.getByRole("button", { name: "Accept plan", exact: true })).toHaveCount(0);
      await expect(page.locator("#input")).toBeVisible();
    });
  });
}
