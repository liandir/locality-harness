import { describe, expect, it, vi } from "vitest";
import { chatContextActions } from "../src/ui/chatContextMenu.js";
describe("chat context menu", () => {
  it("contains only chat actions and targets the selected chat", () => {
    const send = vi.fn(), actions = chatContextActions(send);
    expect(actions.map(action => action.label)).toEqual(["Open chat", "Rename chat", "Delete chat"]);
    for (const action of actions) action.run("background");
    expect(send.mock.calls.map(([message]) => message)).toEqual([
      { type: "openChat", id: "background" }, { type: "renameChat", id: "background" }, { type: "deleteChat", id: "background" }
    ]);
    expect(actions.at(-1)?.destructive).toBe(true);
  });
});
