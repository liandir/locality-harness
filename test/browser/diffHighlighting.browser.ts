import { expect, test } from "@playwright/test";
import { buildLineDiff } from "../../src/chat/diffPreview.js";
import { hostMessage, webview } from "./harness.js";

// The preview omits the closing quotes of this docstring between two hunks.
const helpText = (title: string, limit: number) => [
  "def help_text():",
  `    '''${title}`,
  "    Read the current settings.",
  "    Exit when finished.",
  "    '''",
  "",
  `LIMIT = ${limit}`
];

const previous = [
  "def load(value):",
  "    r'''Old options.",
  "    from here, return <value>.",
  "    if value is None:",
  "    '''",
  "    return False",
  "",
  ...helpText("Old help.", 1)
].join("\n");

const next = [
  "def load(value):",
  '    r"""Load a .env file.',
  "",
  "    from the environment, return <value>.",
  '    """',
  "    if value is None:",
  "        return True",
  "",
  ...helpText("Updated help.", 2)
].join("\n");

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: Python diff rows match multiline highlighting on their side of the edit`, async ({ page }) => {
    await webview(page, theme);
    await hostMessage(page, { kind: "turnStart", messageId: "edit" });
    // Fenced blocks give us full-file reference highlighting in the active theme.
    await hostMessage(page, { kind: "text", messageId: "edit",
      delta: [previous, next].map(source => "```python\n" + source + "\n```").join("\n\n") });
    await hostMessage(page, { kind: "toolCallProposed", messageId: "edit", toolId: "diff",
      toolName: "edit_file", argsJson: '{"path":"backend.py"}', category: "write",
      approvalRequired: true, ...buildLineDiff(previous, next) });
    await page.locator(".tool-card > .tool-head .tool-name").click();

    const blocks = page.locator("code.language-python");
    await expect(blocks.first().locator(".line [style]").first()).toBeVisible();
    const references = await blocks.evaluateAll(elements =>
      elements.map(block => Array.from(block.querySelectorAll(".line"), line => line.innerHTML)));
    const omission = page.locator(".diff-line.neutral").filter({ hasText: "..." });
    await expect(omission.locator(".diff-code")).toHaveText("...");
    await expect(omission.locator("[style]")).toHaveCount(0);
    const rows = await page.locator(".diff-line").evaluateAll(elements => elements.map(row => ({
      side: row.classList.contains("del") ? 0 : 1,
      line: Number(row.querySelector(".diff-no")!.textContent),
      tokens: row.querySelector(".diff-code .line")?.innerHTML ?? ""
    })).filter(row => row.line > 0));
    for (const row of rows) {
      expect(row.tokens, `side ${row.side}, line ${row.line}`).toBe(references[row.side][row.line - 1]);
    }
  });
}
