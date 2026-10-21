import type { Page } from "@playwright/test";
import type { ExtToChat, ExtToSide } from "../../src/ui/messaging.js";
export type Theme = "light" | "dark";

export async function hostMessage(page: Page, message: ExtToChat | ExtToSide): Promise<void> {
  await page.evaluate(data => window.dispatchEvent(new MessageEvent("message", { data })), message);
}

export async function webview(page: Page, theme: Theme, view = "chat"): Promise<void> {
  await page.setContent(`<html><head></head><body class="vscode-${theme}"><div id="app"></div></body></html>`);
  // Theme inputs only: production CSS owns every interaction and semantic fill.
  await page.addStyleTag({ content: `:root {
    --vscode-foreground: ${theme === "dark" ? "#cccccc" : "#333333"};
    --vscode-descriptionForeground: ${theme === "dark" ? "#999999" : "#666666"};
    --vscode-sideBar-background: ${theme === "dark" ? "#181818" : "#f3f3f3"};
    --vscode-editor-background: ${theme === "dark" ? "#1f1f1f" : "#ffffff"};
    --vscode-errorForeground: ${theme === "dark" ? "#f48771" : "#a1260d"};
    --vscode-font-family: sans-serif; --vscode-font-size: 13px;
  }
  /* These checks assert states, independently of transition timing. */
  *, *::before, *::after { transition: none !important; }` });
  await page.addStyleTag({ path: `media/${view}.css` });
  await page.addStyleTag({ path: "media/chatControls.css" });
  await page.evaluate(() => {
    Object.assign(window, { posted: [], acquireVsCodeApi: () => ({
      postMessage: (message: unknown) => (window as unknown as { posted: unknown[] }).posted.push(message), getState: () => undefined, setState: () => undefined
    }) });
  });
  await page.addScriptTag({ path: `dist/webview/${view}.js` });
}

