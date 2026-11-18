import { describe, expect, it } from "vitest";
import { compactAvailableForMessageCount, compactAvailableForMessages, MIN_COMPACT_MESSAGES } from "../src/chat/compactor.js";

describe("compact eligibility", () => {
  it("requires reducible history beyond the current request and its steering", () => {
    const messages = [{ role: "user" as const, content: "request", ts: 1 }, { role: "user" as const, steering: true, content: "guidance", ts: 2 }];
    expect(compactAvailableForMessages(messages)).toBe(false);
    expect(compactAvailableForMessages([{ role: "assistant", content: "earlier work", ts: 0 }, ...messages])).toBe(true);
  });
  it("is unavailable before the saved-message threshold", () => {
    expect(MIN_COMPACT_MESSAGES).toBe(2);
    expect(compactAvailableForMessageCount(MIN_COMPACT_MESSAGES - 1)).toBe(false);
  });

  it("is available at the saved-message threshold", () => {
    expect(compactAvailableForMessageCount(MIN_COMPACT_MESSAGES)).toBe(true);
  });
});
