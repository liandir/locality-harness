import { describe, expect, it } from "vitest";
import { PlanResponse } from "../src/chat/planResponse.js";
import { interruptionMessage } from "../src/ui/chatView/webview/interruption.js";

describe("streamed final-plan boundaries", () => {
  it("hides delimiters at every chunk boundary without buffering the plan", () => {
    const text = "I checked the code.\n<proposed_plan>\n## Plan\n- Implement 漢字\n- Verify\n</proposed_plan>";
    for (let split = 0; split <= text.length; split++) {
      const stream = new PlanResponse();
      const visible = stream.feed(text.slice(0, split)) + stream.feed(text.slice(split)) + stream.end();
      expect(visible).toBe("I checked the code.\n\n## Plan\n- Implement 漢字\n- Verify\n");
      expect(stream.complete).toBe(true);
    }
  });
  it("publishes content before the closing delimiter and terminal evidence", () => {
    const stream = new PlanResponse();
    expect(stream.feed("<proposed_plan>\nFirst step")).toBe("\nFirst step");
    expect(stream.complete).toBe(false);
    expect(stream.feed("\nSecond step\n</proposed_plan>")).toBe("\nSecond step\n");
    expect(stream.complete).toBe(true);
  });
  it("preserves literal delimiters in inline code and code fences", () => {
    const body = "- Handle `<proposed_plan>` literally.\n```xml\n<proposed_plan>\nexample\n</proposed_plan>\n```\n- Verify parsing.";
    const stream = new PlanResponse();
    let visible = "";
    for (const char of `<proposed_plan>\n${body}\n</proposed_plan>`) visible += stream.feed(char);
    visible += stream.end();
    expect(visible.trim()).toBe(body);
    expect(stream.complete).toBe(true);
  });
  it("preserves a literal partial delimiter in prose", () => {
    const stream = new PlanResponse();
    expect(stream.feed("Explain the operator <") + stream.end()).toBe("Explain the operator <");
    expect(stream.complete).toBe(false);
  });
  it.each([
    "I will inspect the code.", "<proposed_plan>\n \n</proposed_plan>",
    "<proposed_plan>\nUnfinished", "<proposed_plan>\nOne\n</proposed_plan>\n<proposed_plan>\nTwo\n</proposed_plan>",
    "<proposed_plan>\nOne\n<proposed_plan>\nTwo\n</proposed_plan>",
    "<proposed_plan>\nPlan\n</proposed_plan>\nWhich option?", "</proposed_plan>",
    "<proposed_plan>\nPlan\n</proposed_plan>\n<proposed_"
  ])("does not approve incomplete or ambiguous output %s", text => {
    const stream = new PlanResponse(); stream.feed(text); stream.end();
    expect(stream.complete).toBe(false);
  });
});

describe("inline interruption messages", () => {
  it("keeps deliberate cancellation concise", () => {
    expect(interruptionMessage("Stopped by user.", { cause: "user_cancel", completionTokens: 42 })).toBe("Stopped by user.");
  });
  it("includes useful server facts directly in the message", () => {
    expect(interruptionMessage("Connection interrupted.", { cause: "transport", completionEvidence: "none", httpStatus: 503, promptTokens: 10, completionTokens: 20 }))
      .toBe("Connection interrupted. (HTTP 503; the server did not confirm completion; server input: 10 tokens; server output: 20 tokens)");
  });
});
