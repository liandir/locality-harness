import { test, expect, type Page } from "@playwright/test";
import type { ChatRecord } from "../../src/chat/types.js";
import { buildLineDiff } from "../../src/chat/diffPreview.js";
import { editDiffCases } from "../fixtures/editDiff.js";
import { hostMessage, webview, type Theme } from "./harness.js";

async function start(page: Page, theme: Theme): Promise<ChatRecord> {
  await webview(page, theme);
  const record: ChatRecord = {
    id: "123e4567-e89b-42d3-a456-426614174003", workspaceRoot: "/workspace", title: "Edit counts",
    createdAt: 1, updatedAt: 1, toolCallingMode: "native", mode: "act", reasoningEffort: "default", totalTokens: 0,
    messages: [{ role: "user", content: "Edit the file", ts: 1 }]
  };
  await hostMessage(page, { kind: "chatLoaded", record });
  await hostMessage(page, { kind: "turnStart", messageId: "response" });
  return record;
}

async function counts(page: Page, added: number, removed: number): Promise<void> {
  await expect(page.locator(".tool-card .diff-stat.add")).toHaveText(`+${added}`);
  await expect(page.locator(".tool-card .diff-stat.del")).toHaveText(`-${removed}`);
}

for (const theme of ["light", "dark"] as const) {
  for (const scenario of editDiffCases) {
    test(`${theme}: ${scenario.name} counts agree before approval and after execution`, async ({ page }) => {
      await start(page, theme);
      await hostMessage(page, { kind: "toolCallProgress", toolId: "edit", messageId: "response", toolName: scenario.tool,
        path: "sample.txt", contentLines: 999 });
      const head = page.locator(".tool-card > .tool-head");
      await expect(head).toBeVisible();
      await expect(page.locator(".tool-card .diff-stat-group")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Approve this time", exact: true })).toHaveCount(0);
      const diff = buildLineDiff(scenario.previous ?? "", scenario.next);
      await hostMessage(page, { kind: "toolCallProposed", toolId: "edit", messageId: "response", toolName: scenario.tool,
        category: "write", argsJson: JSON.stringify({ path: "sample.txt", ...scenario.args }), approvalRequired: true, ...diff });
      await expect(page.getByRole("button", { name: "Approve this time", exact: true })).toBeVisible();
      await counts(page, scenario.added, scenario.removed);
      // Expanding by keyboard preserves the same counts in the diff header.
      await head.focus();
      await page.keyboard.press("Enter");
      await expect(head).toHaveAttribute("aria-expanded", "true");
      await counts(page, scenario.added, scenario.removed);
      await expect(page.locator(".tool-diff")).toBeVisible();
      if (scenario.name === "capped preview") await expect(page.locator(".tool-diff")).toContainText("large diff preview capped");
      await page.getByRole("button", { name: "Approve this time", exact: true }).click();
      await hostMessage(page, { kind: "toolCallResolved", toolId: "edit", status: "approved" });
      await counts(page, scenario.added, scenario.removed);
      await hostMessage(page, { kind: "toolCallResolved", toolId: "edit", status: "executed", ...diff });
      await counts(page, scenario.added, scenario.removed);
      await head.focus();
      await page.keyboard.press("Space");
      await expect(head).toHaveAttribute("aria-expanded", "false");
      await counts(page, scenario.added, scenario.removed);
    });
  }

  for (const status of ["failed", "rejected"] as const) {
    test(`${theme}: ${status} edits clear proposal counts`, async ({ page }) => {
      await start(page, theme);
      await hostMessage(page, { kind: "toolCallProposed", toolId: "edit", messageId: "response", toolName: "edit_file",
        category: "write", argsJson: '{"path":"sample.txt"}', approvalRequired: true, ...buildLineDiff("old", "new") });
      await counts(page, 1, 1);
      await hostMessage(page, { kind: "toolCallResolved", toolId: "edit", status, resultPreview: "The edit was not applied." });
      await expect(page.locator(".tool-card .diff-stat-group")).toHaveCount(0);
    });
  }

  test(`${theme}: capped previews never become counts when host counts are unavailable`, async ({ page }) => {
    await start(page, theme);
    const scenario = editDiffCases.at(-1)!;
    await hostMessage(page, { kind: "toolCallProposed", toolId: "edit", messageId: "response", toolName: "edit_file",
      category: "write", argsJson: '{"path":"sample.txt"}', approvalRequired: true,
      diffPreview: buildLineDiff(scenario.previous!, scenario.next).diffPreview });
    await expect(page.locator(".tool-card")).toBeVisible();
    await expect(page.locator(".tool-card .diff-stat-group")).toHaveCount(0);
  });

  test(`${theme}: full counts survive reload with a capped preview`, async ({ page }) => {
    const record = await start(page, theme);
    const scenario = editDiffCases.at(-1)!;
    record.messages.push({ role: "tool", ts: 2, content: "Edited file", toolCall: {
      name: "edit_file", argsJson: '{"path":"sample.txt"}', status: "executed",
      fileChange: { path: "sample.txt", ...buildLineDiff(scenario.previous!, scenario.next) }
    } });
    record.messages.push({ role: "assistant", ts: 3, content: "Done." });
    await page.reload();
    await webview(page, theme);
    await hostMessage(page, { kind: "chatLoaded", record });
    const head = page.locator(".tool-card > .tool-head");
    for (let depth = 0; depth < 3 && !await head.count(); depth++) await page.locator('.work-head[aria-expanded="false"]').first().click();
    await counts(page, 1300, 1300);
    await head.locator(".tool-name").click();
    await expect(head).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".tool-diff")).toBeVisible();
    await counts(page, 1300, 1300);
  });
}
