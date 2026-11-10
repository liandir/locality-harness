import { expect, test } from "@playwright/test";
import { hostMessage, webview } from "./harness.js";

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: context loading replaces the fallback and clears on output or interruption`, async ({ page }) => {
    await page.clock.install();
    await webview(page, theme);
    await hostMessage(page, { kind: "userMessage", messageId: "user", messageTs: 1, text: "Next question", mode: "act" });
    await hostMessage(page, { kind: "turnPreparing", reason: "server" });
    await hostMessage(page, { kind: "turnStart", messageId: "response" });
    await expect(page.locator("#serverStatus")).toBeHidden();
    await page.clock.runFor(3_100);
    await expect(page.locator("#serverStatus")).toBeVisible();
    await expect(page.locator("#serverStatus")).toHaveText("Server pending");

    await hostMessage(page, { kind: "turnPreparing", reason: "context" });
    await expect(page.locator("#serverStatus")).toHaveText("Loading chat context");
    await expect(page.getByText("Server pending", { exact: true })).toHaveCount(0);
    // Finishing an auxiliary title must not overwrite reported prefill.
    await hostMessage(page, { kind: "titleGenerationFinished" });
    await page.clock.runFor(3_100);
    await expect(page.locator("#serverStatus")).toHaveText("Loading chat context");

    await hostMessage(page, { kind: "turnPreparing", reason: "server" });
    await expect(page.locator("#serverStatus")).toBeHidden();
    await page.clock.runFor(3_100);
    await expect(page.locator("#serverStatus")).toHaveText("Server pending");
    await hostMessage(page, { kind: "turnPreparing", reason: "context" });
    await hostMessage(page, { kind: "text", messageId: "response", delta: "Answer" });
    await expect(page.locator("#serverStatus")).toBeHidden();

    await hostMessage(page, { kind: "turnPreparing", reason: "context" });
    await expect(page.locator("#serverStatus")).toBeVisible();
    await hostMessage(page, { kind: "abort", reason: "Stopped by user.", messageTs: 2 });
    await page.clock.runFor(3_100);
    await expect(page.locator("#serverStatus")).toBeHidden();
  });
}
