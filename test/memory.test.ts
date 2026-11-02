import { describe, expect, it } from "vitest";
import { redactMemorySecrets, validMemory, validMemoryCreation } from "../src/chat/memory.js";
describe("legacy memory compatibility", () => {
  it("keeps historical successes and failures readable", () => {
    expect(validMemory({ text: "Legacy", sourceRevision: "a".repeat(64), generatedAt: 1, enabled: true, manual: false })).toBe(true);
    expect(validMemoryCreation({ messageTs: 2, status: "created", text: "Legacy", generatedAt: 3 })).toBe(true);
    expect(validMemoryCreation({ messageTs: 2, status: "failed", error: "Offline" })).toBe(true);
  });
  it("redacts credentials from note inputs", () => {
    const text = redactMemorySecrets('password="secret-value" api_key=abc123 Bearer abc.def sk-1234567890123456');
    for (const secret of ["secret-value", "abc123", "abc.def", "sk-1234567890123456"]) expect(text).not.toContain(secret);
  });
});
