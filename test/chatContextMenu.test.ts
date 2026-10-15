import { describe, expect, it, vi } from "vitest";
import { chatContextActions } from "../src/ui/chatContextMenu.js";
import { historyIcon, pencilIcon, readFileIcon, memoryIcon, trashIcon } from "../src/ui/icons.js";

describe("shared chat context menu", () => {
  it("groups chat, memory, and delete actions with their existing icons", () => {
    const actions = chatContextActions({ id: "target", hasMemory: true, status: "ready" }, vi.fn());
    expect(actions.map(action => action.label)).toEqual([
      "Open chat", "Rename chat", "Edit memory", "View memory", "Regenerate memory", "Delete chat"
    ]);
    expect(actions.map(action => action.icon)).toEqual([historyIcon, pencilIcon, pencilIcon, readFileIcon, memoryIcon, trashIcon]);
    expect(actions.filter(action => action.separatorBefore).map(action => action.label)).toEqual(["Edit memory", "Delete chat"]);
    expect(actions.at(-1)?.destructive).toBe(true);
  });

  it("routes every action to the selected chat, including inactive tabs", () => {
    const send = vi.fn();
    for (const action of chatContextActions({ id: "background", hasMemory: true, status: "manual" }, send)) action.run("background");
    expect(send.mock.calls.map(([message]) => message)).toEqual([
      { type: "openChat", id: "background" },
      { type: "renameChat", id: "background" },
      { type: "openMemory", id: "background", readonly: false },
      { type: "openMemory", id: "background", readonly: true },
      { type: "regenerateMemory", id: "background" },
      { type: "deleteChat", id: "background" }
    ]);
  });

  it("offers Generate for a missing memory and disables View until it exists", () => {
    const actions = chatContextActions(undefined, vi.fn());
    expect(actions[2].disabled).not.toBe(true);
    expect(actions[3].disabled).toBe(true);
    expect(actions[4]).toMatchObject({ label: "Generate memory", disabled: false });
  });

  it.each(["queued", "generating"] as const)("disables regeneration while %s without blocking existing memory access", status => {
    const actions = chatContextActions({ id: "target", hasMemory: true, status }, vi.fn());
    expect(actions[3].disabled).toBe(false);
    expect(actions[4].disabled).toBe(true);
  });
});
