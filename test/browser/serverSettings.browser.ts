import { expect, test } from "@playwright/test";
import type { SideToExt } from "../../src/ui/messaging.js";
import { hostMessage, webview } from "./harness.js";

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: server selection, masked credentials, first-image status and failed validation`, async ({ page }) => {
    await webview(page, theme, "side");
    await hostMessage(page, { type: "settings", settings: { endpoint: "http://localhost:8000/v1", serverType: "auto", model: "qwen" }, reasoningEffort: "default" });
    await hostMessage(page, { type: "focusTab", tab: "settings" });
    const heading = page.locator('[data-settings-section="model"]');
    await heading.focus(); await page.keyboard.press("Enter");
    await expect(heading).toHaveAttribute("aria-expanded", "true");
    await expect(heading).toBeFocused();
    await expect(page.getByRole("button", { name: "Clear key" })).toHaveCount(0);
    const endpointRow = page.locator(".setting-action-row").filter({ has: page.locator("#endpoint") });
    await expect(endpointRow.locator("#saveEndpoint")).toBeVisible();
    await expect(page.getByText("Set verifies the connection and saves a new key securely. Leave empty to keep the saved key.")).toHaveCount(0);
    await page.locator("#serverType").selectOption("vllm");
    await page.locator("#serverApiKey").fill("test-secret");
    await expect(page.locator("#serverApiKey")).toHaveAttribute("type", "password");
    await page.locator(theme === "light" ? "#serverApiKey" : "#endpoint").focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#saveEndpoint")).toBeDisabled();
    await expect(page.locator("#serverApiKey")).toHaveValue("");
    await expect(page.locator(theme === "light" ? "#serverApiKey" : "#endpoint")).toBeFocused();
    const sent = await page.evaluate(() => (window as unknown as { posted: SideToExt[] }).posted);
    const validation = [...sent].reverse().find(m => m.type === "validateEndpoint");
    expect(validation).toMatchObject({ serverType: "vllm", apiKey: "test-secret" });
    if (validation?.type !== "validateEndpoint") throw new Error("No connection request");
    await hostMessage(page, { type: "endpointValidation", requestId: validation.requestId, ok: true,
      metadata: { backend: "vllm", modelAlias: "qwen", contextSize: 32768, supportsVision: true, imageSupport: "unknown" }, models: [{ id: "qwen" }], selectedModel: "qwen" });
    await hostMessage(page, { type: "serverCredential", endpoint: "http://localhost:8000/v1", configured: true });
    await expect(page.locator("#serverApiKey")).toHaveValue("");
    await expect(page.getByText("Checked on first image")).toBeVisible();
    await hostMessage(page, { type: "endpointValidation", ok: true,
      metadata: { backend: "vllm", modelAlias: "qwen", contextSize: 32768, supportsVision: true, imageSupport: "supported" }, models: [{ id: "qwen" }], selectedModel: "qwen" });
    await expect(page.locator(".endpoint-metadata")).toContainText("Supported");
    await page.locator("#saveEndpoint").focus(); await page.keyboard.press("Space");
    const retry = await page.evaluate(() => (window as unknown as { posted: SideToExt[] }).posted.filter(m => m.type === "validateEndpoint").at(-1));
    expect(retry).toMatchObject({ type: "validateEndpoint", url: "http://localhost:8000/v1" });
    if (retry?.type !== "validateEndpoint") throw new Error("No retry request");
    expect(retry.apiKey).toBeUndefined();
    await hostMessage(page, { type: "endpointValidation", requestId: retry.requestId, ok: false, error: "Model discovery returned HTTP 401. Check the server API key in Settings." });
    await expect(page.getByRole("alert")).toContainText("HTTP 401");
    await expect(page.getByText("Checked on first image")).toHaveCount(0);
    await expect(page.locator("#saveEndpoint")).toBeEnabled();
    await heading.click(); await page.mouse.move(0, 0);
    await expect(heading).toHaveAttribute("aria-expanded", "false");
    await heading.focus(); await page.keyboard.press("Space");
    await expect(heading).toBeFocused();
    await expect(page.locator("#serverType")).toBeVisible();
  });
}
