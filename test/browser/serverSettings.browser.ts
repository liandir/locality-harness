import { expect, test } from "@playwright/test";
import type { SideToExt } from "../../src/ui/messaging.js";
import { hostMessage, webview } from "./harness.js";
import { imageProbeDataUrl } from "../../src/llm/imageProbe.js";

test("connection probe image decodes without a file asset", async ({ page }) => {
  const dimensions = await page.evaluate(async url => {
    const image = new Image();
    image.src = url;
    await image.decode();
    return [image.naturalWidth, image.naturalHeight];
  }, imageProbeDataUrl());
  expect(dimensions).toEqual([28, 28]);
});

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: protocol defaults, keyboard selection, stale checks and reload`, async ({ page }) => {
    await webview(page, theme, "side");
    await hostMessage(page, { type: "settings", settings: { endpoint: "http://localhost:8000/v1" }, reasoningEffort: "default" });
    await hostMessage(page, { type: "focusTab", tab: "settings" });
    await page.locator('[data-settings-section="model"]').click();
    const protocol = page.getByLabel("Protocol", { exact: true });
    await expect(protocol).toHaveValue("responses");
    await protocol.focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Tab");
    await expect(protocol).toHaveValue("chat-completions");
    expect(await page.evaluate(() => (window as unknown as { posted: SideToExt[] }).posted))
      .toContainEqual({ type: "saveSetting", key: "protocol", value: "chat-completions" });
    await page.locator("#saveEndpoint").click();
    await protocol.selectOption("responses");
    await expect(protocol).toBeEnabled();
    await expect(page.locator("#saveEndpoint")).toBeEnabled();
    await hostMessage(page, { type: "endpointValidation", protocol: "chat-completions", ok: false, error: "Stale error" });
    await expect(page.getByText("Stale error")).toHaveCount(0);
    await hostMessage(page, { type: "endpointValidation", protocol: "responses", ok: false, error: "Responses is unavailable. Select Chat Completions in Protocol." });
    await expect(page.getByRole("alert")).toContainText("Select Chat Completions");
    await hostMessage(page, { type: "settings", settings: { protocol: "chat-completions" }, reasoningEffort: "default" });
    await expect(protocol).toHaveValue("chat-completions");
    await webview(page, theme, "side");
    await hostMessage(page, { type: "settings", settings: { protocol: "chat-completions" }, reasoningEffort: "default" });
    await hostMessage(page, { type: "focusTab", tab: "settings" });
    await page.locator('[data-settings-section="model"]').click();
    await expect(page.getByLabel("Protocol", { exact: true })).toHaveValue("chat-completions");
  });

  test(`${theme}: automatic server detection, masked credentials, image status and failed validation`, async ({ page }) => {
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
    await expect(page.locator("#serverType")).toHaveCount(0);
    await page.locator("#serverApiKey").fill("test-secret");
    await expect(page.locator("#serverApiKey")).toHaveAttribute("type", "password");
    await page.locator(theme === "light" ? "#serverApiKey" : "#endpoint").focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#saveEndpoint")).toBeDisabled();
    await expect(page.locator("#serverApiKey")).toHaveValue("");
    await expect(page.locator(theme === "light" ? "#serverApiKey" : "#endpoint")).toBeFocused();
    const sent = await page.evaluate(() => (window as unknown as { posted: SideToExt[] }).posted);
    const validation = [...sent].reverse().find(m => m.type === "validateEndpoint");
    expect(validation).toMatchObject({ apiKey: "test-secret" });
    expect(validation).not.toHaveProperty("serverType");
    if (validation?.type !== "validateEndpoint") throw new Error("No connection request");
    await hostMessage(page, { type: "endpointValidation", requestId: validation.requestId, ok: true,
      metadata: { backend: "vllm", modelAlias: "qwen", contextSize: 32768, supportsVision: true, imageSupport: "supported" }, models: [{ id: "qwen" }], selectedModel: "qwen" });
    await hostMessage(page, { type: "serverCredential", endpoint: "http://localhost:8000/v1", configured: true });
    await expect(page.locator("#serverApiKey")).toHaveValue("");
    await expect(page.locator(".endpoint-metadata")).toContainText("vLLM");
    await expect(page.locator(".endpoint-metadata")).toContainText("Supported");
    await hostMessage(page, { type: "endpointValidation", ok: true,
      metadata: { backend: "llama.cpp", modelAlias: "qwen", contextSize: 32768, supportsVision: false, imageSupport: "unsupported" }, models: [{ id: "qwen" }], selectedModel: "qwen" });
    await expect(page.locator(".endpoint-metadata")).toContainText("llama.cpp");
    await expect(page.locator(".endpoint-metadata")).toContainText("Unavailable");
    await page.locator("#saveEndpoint").focus(); await page.keyboard.press("Space");
    const retry = await page.evaluate(() => (window as unknown as { posted: SideToExt[] }).posted.filter(m => m.type === "validateEndpoint").at(-1));
    expect(retry).toMatchObject({ type: "validateEndpoint", url: "http://localhost:8000/v1" });
    if (retry?.type !== "validateEndpoint") throw new Error("No retry request");
    expect(retry.apiKey).toBeUndefined();
    await hostMessage(page, { type: "endpointValidation", requestId: retry.requestId, ok: false, error: "Model discovery returned HTTP 401. Check the server API key in Settings." });
    await expect(page.getByRole("alert")).toContainText("HTTP 401");
    await expect(page.locator(".endpoint-metadata")).toHaveCount(0);
    await expect(page.locator("#saveEndpoint")).toBeEnabled();
    await heading.click(); await page.mouse.move(0, 0);
    await expect(heading).toHaveAttribute("aria-expanded", "false");
    await heading.focus(); await page.keyboard.press("Space");
    await expect(heading).toBeFocused();
    await expect(page.locator("#endpoint")).toBeVisible();
    await expect(page.locator("#serverType")).toHaveCount(0);
  });
}
