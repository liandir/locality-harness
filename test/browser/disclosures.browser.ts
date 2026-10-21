import { test, expect, type Page, type Locator } from "@playwright/test";
import type { ChatRecord } from "../../src/chat/types.js";
import type { MemoryCreation } from "../../src/chat/memory.js";
import { hostMessage, webview, type Theme } from "./harness.js";

type Row = "memory-created" | "memory-failed" | "memory-generating" | "tool-executed" | "tool-failed" | "tool-rejected" | "future-tool" | "plan-submitted" | "plan-failed";

async function chatRow(page: Page, theme: Theme, row: Row): Promise<Locator> {
  await webview(page, theme);
  const record: ChatRecord = {
    id: "123e4567-e89b-42d3-a456-426614174001", workspaceRoot: "/workspace",
    title: "Disclosure regression", createdAt: 1, updatedAt: 3,
    toolCallingMode: "native", mode: "act", reasoningEffort: "default", totalTokens: 0,
    messages: [{ role: "user", content: "Check parser", ts: 1 }]
  };
  if (row.startsWith("memory-")) {
    record.messages.push({ role: "assistant", content: "Parser checked.", ts: 3 });
    const status = row.slice("memory-".length) as MemoryCreation["status"];
    record.memoryCreations = [{ messageTs: 3, operation: "update", status,
      text: "Parser decisions.", generatedAt: 4, error: status === "failed" ? "Memory generation failed." : undefined }];
  } else {
    const status = row.endsWith("-failed") ? "failed" : row === "tool-rejected" ? "rejected" : "executed";
    record.messages.push({ role: "tool", content: status === "executed" ? "Parser contents" : "Could not read parser", ts: 2,
      toolCall: { name: row.startsWith("plan-") ? "submit_plan" : row === "future-tool" ? "future_tool" : row === "tool-executed" ? "list_dir" : "read_file", argsJson: row.startsWith("plan-") ? '{"markdown":"Implement and verify"}' : '{"path":"parser.ts"}', status } });
    record.messages.push({ role: "assistant", content: "Parser checked.", ts: 3 });
  }
  await hostMessage(page, { kind: "chatLoaded", record });
  const head = page.locator(".tool-card > .tool-head").first();
  // Restored tool history starts collapsed, unlike post-answer memory activity.
  for (let depth = 0; depth < 3 && !await head.count(); depth++) {
    await page.locator('.work-head[aria-expanded="false"]').first().click();
  }
  await page.mouse.move(990, 5);
  await expect(head).toBeVisible();
  return head;
}

async function keyboardFocus(page: Page, target: Locator): Promise<void> {
  // Start before the app and use real Tab input so :focus-visible is exercised.
  await page.evaluate(() => {
    const start = document.createElement("button");
    start.id = "tab-start";
    start.textContent = "Start";
    document.body.prepend(start);
    start.focus();
  });
  for (let index = 0; index < 40; index++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate(element => element === document.activeElement)) return;
  }
  throw new Error("Disclosure was not keyboard reachable");
}

async function foreground(head: Locator): Promise<string[]> {
  return head.evaluate(element => [element, ...Array.from(element.querySelectorAll(".tool-name, .tool-icon svg, .disclosure-icon"))]
    .map(child => getComputedStyle(child).color));
}

for (const theme of ["light", "dark"] as const) {
  test.describe(theme, () => {
    for (const row of ["memory-created", "memory-failed", "tool-executed", "tool-failed", "tool-rejected", "future-tool", "plan-submitted", "plan-failed"] as const) {
      test(`${row}: pointer focus does not latch emphasis; keyboard focus remains visible`, async ({ page }) => {
        const head = await chatRow(page, theme, row);
        const icon = head.locator(":scope > .disclosure-icon");
        const resting = await foreground(head);
        await head.hover();
        await expect.poll(() => foreground(head)).not.toEqual(resting);
        await expect(head.locator(".tool-name")).toHaveCSS("color", await head.evaluate(element => getComputedStyle(element).color));
        const hovered = await foreground(head);
        await head.locator(".tool-name").click();
        await page.mouse.move(990, 5);
        await expect.poll(() => foreground(head)).toEqual(resting);
        // Native summaries retain pointer focus; custom history rows activate
        // on pointerdown without claiming focus. Both retain keyboard access.
        if (row.startsWith("memory-")) await expect(head).toBeFocused();
        await expect.poll(() => head.evaluate(element => element.matches(":focus-visible"))).toBe(false);
        await expect(icon).toHaveCSS("opacity", "1");
        await head.locator(".tool-name").click();
        await page.mouse.move(990, 5);
        await expect.poll(() => foreground(head)).toEqual(resting);
        await expect(icon).toHaveCSS("opacity", "0");
        await head.locator(".tool-name").click();
        await page.mouse.move(990, 5);
        await keyboardFocus(page, head);
        await expect.poll(() => foreground(head)).toEqual(hovered);
        await expect(head).toHaveCSS("outline-style", "none");
        const expanded = await icon.evaluate(element => getComputedStyle(element).transform);
        await page.keyboard.press("Enter");
        await expect.poll(() => icon.evaluate(element => getComputedStyle(element).transform)).not.toBe(expanded);
        await page.keyboard.press("Space");
        await expect(icon).toHaveCSS("transform", expanded);
        await expect(head).toBeFocused();
      });
    }

    test("active memory restores shimmer after pointer exit and keeps expansion on updates", async ({ page }) => {
      const head = await chatRow(page, theme, "memory-generating");
      const name = head.locator(".tool-name");
      await expect(name).toHaveCSS("color", "rgba(0, 0, 0, 0)");
      await head.click();
      await expect(name).not.toHaveCSS("color", "rgba(0, 0, 0, 0)");
      await page.mouse.move(990, 5);
      await expect(name).toHaveCSS("color", "rgba(0, 0, 0, 0)");
      await hostMessage(page, { kind: "memoryCreations", creations: [{ messageTs: 3, status: "failed", operation: "update", error: "Generation failed." }] });
      await expect(page.locator("details[data-memory-creation]")).toHaveAttribute("open", "");
      await expect(head).toContainText("Memory update failed");
      await expect(head.locator(".tool-name")).not.toHaveCSS("color", "rgba(0, 0, 0, 0)");
    });

    test("active disclosure remains readable with reduced motion", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const head = await chatRow(page, theme, "memory-generating");
      const name = head.locator(".tool-name");
      const resting = await foreground(head);
      await expect(name).not.toHaveCSS("color", "rgba(0, 0, 0, 0)");
      await head.click();
      await expect.poll(() => foreground(head)).not.toEqual(resting);
      await page.mouse.move(990, 5);
      await expect.poll(() => foreground(head)).toEqual(resting);
    });

    test("nested file links distinguish pointer focus from keyboard focus", async ({ page }) => {
      const head = await chatRow(page, theme, "tool-failed");
      const link = head.locator(".tool-path-link").first();
      const resting = await foreground(head);
      await link.click();
      await page.mouse.move(990, 5);
      await expect.poll(() => foreground(head)).toEqual(resting);
      await expect(link).toBeFocused();
      await keyboardFocus(page, link);
      await expect.poll(() => foreground(head)).not.toEqual(resting);
    });

    test("settings use the same disclosure interaction", async ({ page }) => {
      await webview(page, theme, "side");
      await hostMessage(page, { type: "focusTab", tab: "settings" });
      const head = page.locator(".settings-section-heading").first();
      const resting = await foreground(head);
      await head.click();
      await expect(head).toHaveAttribute("aria-expanded", "true");
      await page.mouse.move(990, 5);
      await expect.poll(() => foreground(head)).toEqual(resting);
      await keyboardFocus(page, head);
      await expect.poll(() => foreground(head)).not.toEqual(resting);
      await page.keyboard.press("Space");
      await expect(head).toHaveAttribute("aria-expanded", "false");
    });
  });
}
