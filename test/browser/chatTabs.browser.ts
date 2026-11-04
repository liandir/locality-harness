import { expect, test, type Locator } from "@playwright/test";
import type { ChatToExt } from "../../src/ui/messaging.js";
import { hostMessage, webview } from "./harness.js";

async function colors(tab: Locator): Promise<{ background: string; foreground: string }> {
  return tab.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, foreground: style.color };
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: chat tabs match sidebar selection, hover and keyboard focus`, async ({ page }) => {
    await webview(page, theme, "side");
    await page.mouse.move(990, 790);
    const sidebarActive = page.locator("#tab-welcome");
    const sidebarInactive = page.locator("#tab-chats");
    const activeColors = await colors(sidebarActive);
    const inactiveColors = await colors(sidebarInactive);
    await sidebarActive.hover();
    expect(await colors(sidebarActive)).toEqual(activeColors);
    await sidebarInactive.hover();
    const hoverColors = await colors(sidebarInactive);
    expect(hoverColors.background).not.toBe(activeColors.background);
    expect(hoverColors.background).not.toBe(inactiveColors.background);
    await page.mouse.move(990, 790);
    await sidebarActive.focus();
    await page.keyboard.press("Tab");
    await expect(sidebarInactive).toBeFocused();
    expect(await colors(sidebarInactive)).toEqual(hoverColors);

    await page.reload();
    await webview(page, theme);
    // Editor tab and list colors must not override the shared sidebar palette.
    await page.addStyleTag({ content: `:root {
      --vscode-tab-activeBackground: var(--vscode-editor-background);
      --vscode-tab-inactiveBackground: var(--vscode-sideBar-background);
      --vscode-tab-activeForeground: var(--vscode-errorForeground);
      --vscode-tab-inactiveForeground: var(--vscode-errorForeground);
      --vscode-list-hoverBackground: var(--surface-fill-strong);
    }` });
    await hostMessage(page, { type: "chatSnapshot", id: "first", events: [], busy: false, draft: "" });
    await hostMessage(page, { type: "chatTabs", tabs: [
      { id: "first", title: "First chat" }, { id: "second", title: "Second chat" }
    ] });
    await page.mouse.move(990, 790);
    const first = page.locator('.chat-tab[data-chat-context="first"]');
    const second = page.locator('.chat-tab[data-chat-context="second"]');
    const firstLabel = first.getByRole("tab");
    const secondLabel = second.getByRole("tab");
    const firstBox = await first.boundingBox();
    const secondBox = await second.boundingBox();
    expect(await colors(first)).toEqual(activeColors);
    expect(await colors(second)).toEqual(inactiveColors);

    await firstLabel.hover();
    expect(await colors(first)).toEqual(activeColors);
    expect(await first.boundingBox()).toEqual(firstBox);
    await firstLabel.click();
    await page.mouse.move(990, 790);
    await expect(firstLabel).toBeFocused();
    expect(await colors(first)).toEqual(activeColors);

    await secondLabel.hover();
    expect(await colors(second)).toEqual(hoverColors);
    expect(await second.boundingBox()).toEqual(secondBox);
    await secondLabel.click();
    await page.mouse.move(990, 790);
    await expect(secondLabel).toBeFocused();
    expect(await colors(second)).toEqual(inactiveColors);

    await page.keyboard.press("Tab");
    await expect(second.getByRole("button", { name: "Close Second chat" })).toBeFocused();
    expect(await colors(second)).toEqual(hoverColors);
    await page.keyboard.press("Shift+Tab");
    await expect(secondLabel).toBeFocused();
    expect(await colors(second)).toEqual(hoverColors);
    await expect(secondLabel).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await expect(secondLabel).toBeFocused();
    const opens = await page.evaluate(() => (window as unknown as { posted: ChatToExt[] }).posted
      .filter(message => message.type === "openChat" && message.id === "second"));
    expect(opens).toHaveLength(3);

    await hostMessage(page, { type: "chatSnapshot", id: "second", events: [], busy: false, draft: "" });
    await secondLabel.hover();
    await expect(secondLabel).toHaveAttribute("aria-selected", "true");
    expect(await colors(second)).toEqual(activeColors);
    expect(await colors(first)).toEqual(inactiveColors);
    expect(await second.boundingBox()).toEqual(secondBox);
  });
}
