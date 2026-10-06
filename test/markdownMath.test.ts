import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import mdKatex from "@vscode/markdown-it-katex";

// Exercise the plugin's resolved KaTeX dependency, not just the direct import.
const md = new MarkdownIt({ html: false, linkify: false, breaks: false }).use(mdKatex);

describe("chat Markdown math", () => {
  it("renders inline and display math with the Markdown plugin", () => {
    const inline = md.render(String.raw`The fraction is $\frac{1}{2}$.`);
    const block = md.render("$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$");

    expect(inline).toContain('class="katex"');
    expect(inline).not.toContain('class="katex-display"');
    expect(block).toContain('class="katex-display"');
    for (const html of [inline, block]) {
      expect(html).toContain("<math");
      expect(html).not.toContain("katex-error");
    }
  });

  it("keeps incomplete streamed math and invalid expressions readable", () => {
    expect(md.render(String.raw`Working on $\frac{1}`)).toContain(String.raw`$\frac{1}`);
    const html = md.render(String.raw`$\undefinedcommand{<img src=x onerror=alert(1)>}$`);
    expect(html).toContain("katex-error");
    expect(html).not.toContain("<img");
  });

  it.each([
    String.raw`$\href{javascript:alert(1)}{click}$`,
    String.raw`$\includegraphics{https://example.invalid/tracker.png}$`
  ])("does not render trusted commands from model output: %s", input => {
    const html = md.render(input);
    expect(html).toContain('class="katex"');
    expect(html).not.toMatch(/<(?:a|img)\b/);
  });

  // GHSA-238p-pmpm-9mq7: inherited options and setting metadata must not
  // turn on trusted rendering, even if another dependency polluted them.
  it.each([
    ["trust", true],
    ["default", true],
    ["processor", () => true]
  ] as const)("ignores an inherited %s setting", (property, value) => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, property);
    let html: string;
    try {
      Object.defineProperty(Object.prototype, property, { value, configurable: true, writable: true });
      html = md.render(String.raw`$\href{javascript:alert(1)}{click}$ and $\includegraphics{https://example.invalid/tracker.png}$`);
    } finally {
      if (previous) Object.defineProperty(Object.prototype, property, previous);
      else Reflect.deleteProperty(Object.prototype, property);
    }

    expect(html).toContain('class="katex"');
    expect(html).not.toContain("katex-error");
    expect(html).not.toMatch(/<(?:a|img)\b/);
  });
});
