import { expect, test } from "@playwright/test";
import type { SideToExt } from "../../src/ui/messaging.js";
import { hostMessage, webview } from "./harness.js";

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: personalization is always shown in User and preserves edits, focus, and save failures`, async ({ page }) => {
    await webview(page, theme, "side");
    await hostMessage(page, { type: "settings", settings: { personalization: "Use British English." }, reasoningEffort: "default" });
    await hostMessage(page, { type: "focusTab", tab: "settings" });
    const heading = page.locator('[data-settings-section="user"]');
    const input = page.locator("#personalization");
    await expect(input).toBeHidden();
    await heading.click();
    await page.mouse.move(990, 5);
    await expect(input).toBeVisible();
    await expect(input).toHaveValue("Use British English.");
    await expect(heading).toBeFocused();
    await expect(heading).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('[data-settings-section="personalization"]')).toHaveCount(0);
    await expect(input).toHaveAccessibleName("Personalization");
    await expect(input).toHaveCSS("border-radius", "10px");
    await expect(input).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    await expect(input).toHaveCSS("outline-style", "none");
    await expect(page.locator("#savePersonalization")).toBeDisabled();
    await heading.focus(); await page.keyboard.press("Enter");
    await expect(heading).toBeFocused(); await expect(input).toBeHidden();
    await page.keyboard.press("Space");
    await expect(heading).toBeFocused(); await expect(input).toBeVisible();
    const draft = "Use British English.\nKeep explanations concise.\nPrefer TypeScript examples.";
    await input.fill(draft);
    await input.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(4, 9));
    await hostMessage(page, { type: "appInfo", version: "test" });
    await expect(input).toBeFocused(); await expect(input).toHaveValue(draft);
    expect(await input.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([4, 9]);
    await page.locator("#tab-chats").click(); await page.locator("#tab-settings").click();
    await expect(input).toHaveValue(draft);
    const save = page.getByRole("button", { name: "Save personalization", exact: true });
    const resting = await save.evaluate(element => getComputedStyle(element).backgroundColor);
    await save.click();
    await page.mouse.move(990, 5);
    await expect(save).toBeFocused();
    await expect(save).toHaveCSS("background-color", resting);
    await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
    await expect(save).toBeFocused();
    expect(await save.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(resting);
    await page.keyboard.press("Enter"); await page.keyboard.press("Space");
    const posted = await page.evaluate(() => (window as unknown as { posted: SideToExt[] }).posted);
    expect(posted).toContainEqual({ type: "personalizationDraft", value: draft });
    expect(posted).toContainEqual({ type: "savePersonalization" });
    await hostMessage(page, { type: "personalizationEditor", editor: { draft, saving: true } });
    await expect(input).toHaveAttribute("readonly", "");
    await expect(page.locator("#savePersonalization")).toBeDisabled();
    await hostMessage(page, { type: "personalizationEditor", editor: { draft, error: "Settings file is read-only" } });
    await expect(input).toHaveValue(draft); await expect(input).toBeEditable();
    await expect(page.locator("#personalization-error")).toHaveText("Settings file is read-only");
    await expect(page.locator("#savePersonalization")).toBeEnabled();
    await page.locator("#cancelPersonalization").click();
    await hostMessage(page, { type: "personalizationEditor", editor: {} });
    await expect(input).toHaveValue("Use British English.");
    await expect(page.locator("#personalization-error")).toBeHidden();
    await input.fill(draft);
    await hostMessage(page, { type: "settings", settings: { personalization: draft }, reasoningEffort: "default" });
    await hostMessage(page, { type: "personalizationEditor", editor: {} });
    await expect(input).toHaveValue(draft); await expect(page.locator("#savePersonalization")).toBeDisabled();
    await page.locator("#editUserSettings").focus(); await page.mouse.move(990, 5);
    await page.screenshot({ path: `/tmp/locality-personalization-${theme}.png` });
    await input.fill("");
    await expect(page.locator("#savePersonalization")).toBeEnabled();
    await hostMessage(page, { type: "settings", settings: { personalization: "" }, reasoningEffort: "default", resetDrafts: true });
    await expect(input).toHaveValue("");
    await expect(page.locator("#savePersonalization")).toBeDisabled();
  });

  test(`${theme}: personalization uses the memory editor's field, icons, and action spacing`, async ({ page }) => {
    await webview(page, theme, "side");
    await hostMessage(page, { type: "focusTab", tab: "memories" });
    await hostMessage(page, { type: "memoryPanel", panel: { activeKey: "reference", editors: [{
      key: "reference", mode: "edit", name: "Reference", draftName: "Reference", contents: "Preferences", draftContents: "Preferences"
    }] } });
    await page.locator("#tab-memories").click(); await page.mouse.move(990, 5);
    const appearance = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      return { height: style.height, padding: style.padding, radius: style.borderRadius, font: style.font,
        color: style.color, background: style.backgroundColor, border: style.borderColor, outline: style.outlineStyle };
    };
    const actionSpacing = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      return { gap: style.gap, marginTop: style.marginTop, justifyContent: style.justifyContent };
    };
    const field = await page.locator(".memory-content-input").evaluate(appearance);
    const actions = await page.locator(".memory-edit-actions").evaluate(actionSpacing);
    const save = await page.locator("#memory-save-reference").evaluate(appearance);
    const saveIcon = await page.locator("#memory-save-reference svg").evaluate(element => element.outerHTML);
    const cancelIcon = await page.locator("#memory-cancel-reference svg").evaluate(element => element.outerHTML);
    await page.locator("#memory-save-reference").hover();
    const hover = await page.locator("#memory-save-reference").evaluate(appearance);

    await hostMessage(page, { type: "settings", settings: { personalization: "Preferences" }, reasoningEffort: "default" });
    await hostMessage(page, { type: "personalizationEditor", editor: { draft: "Updated preferences" } });
    await hostMessage(page, { type: "focusTab", tab: "settings" });
    await page.locator('[data-settings-section="user"]').click(); await page.mouse.move(990, 5);
    expect(await page.locator("#personalization").evaluate(appearance)).toEqual(field);
    expect(await page.locator(".settings-editor-actions").evaluate(actionSpacing)).toEqual(actions);
    expect(await page.locator("#savePersonalization").evaluate(appearance)).toEqual(save);
    expect(await page.locator("#cancelPersonalization").evaluate(appearance)).toEqual(save);
    expect(await page.locator("#savePersonalization svg").evaluate(element => element.outerHTML)).toBe(saveIcon);
    expect(await page.locator("#cancelPersonalization svg").evaluate(element => element.outerHTML)).toBe(cancelIcon);
    await page.locator("#savePersonalization").hover();
    expect(await page.locator("#savePersonalization").evaluate(appearance)).toEqual(hover);
    await page.locator("#cancelPersonalization").hover();
    expect(await page.locator("#cancelPersonalization").evaluate(appearance)).toEqual(hover);
  });
}
