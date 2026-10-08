import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  explicit: new Map<string, unknown>(),
  workspace: new Map<string, unknown>(),
  folders: new Map<string, unknown>(),
  update: vi.fn()
}));

vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => mocks.values.get(key),
      inspect: (key: string) => mocks.folders.has(key) ? { workspaceFolderValue: mocks.folders.get(key) } : mocks.workspace.has(key) ? { workspaceValue: mocks.workspace.get(key) } : mocks.explicit.has(key)
        ? { globalValue: mocks.explicit.get(key) }
        : { defaultValue: mocks.values.get(key) },
      update: mocks.update
    }),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() }))
  }
}));

beforeEach(() => {
  mocks.values.clear();
  mocks.explicit.clear();
  mocks.workspace.clear();
  mocks.folders.clear();
  mocks.update.mockClear();
  mocks.values.set("toolCallingMode", "compat-gemma4");
});

describe("tool calling settings", () => {
  it.each(["readToolsEnabled", "editToolsEnabled", "commandToolsEnabled"] as const)("defaults %s on and persists disabling without changing approval", async key => {
    const { readSettings, writeSetting, resetAllSettings } = await import("../src/config/settings.js");
    expect(readSettings()[key]).toBe(true);
    mocks.values.set(key, false);
    expect(readSettings()[key]).toBe(false);
    await writeSetting(key, false);
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith(key, false, 1);
    mocks.update.mockClear();
    await resetAllSettings();
    expect(mocks.update).toHaveBeenCalledWith(key, undefined, 1);
    expect(mocks.update).toHaveBeenCalledWith(key, undefined, 2);
  });

  it("uses the default profile when unset", async () => {
    const { readSettings } = await import("../src/config/settings.js");
    expect(readSettings().toolCallingMode).toBe("compat-gemma4");
  });

  it("uses the selected profile", async () => {
    mocks.values.set("toolCallingMode", "compat-muse-glimmer");
    const { readSettings } = await import("../src/config/settings.js");
    expect(readSettings().toolCallingMode).toBe("compat-muse-glimmer");
  });
});

describe("reasoning and model settings", () => {
  it("defaults Enter to queue and persists the steering preference", async () => {
    const { readSettings, writeSetting, resetAllSettings } = await import("../src/config/settings.js");
    expect(readSettings().steerWithEnter).toBe(false);
    mocks.values.set("steerWithEnter", true);
    expect(readSettings().steerWithEnter).toBe(true);
    await writeSetting("steerWithEnter", true);
    expect(mocks.update).toHaveBeenCalledWith("steerWithEnter", true, 1);
    await resetAllSettings();
    expect(mocks.update).toHaveBeenCalledWith("steerWithEnter", undefined, 1);
    expect(mocks.update).toHaveBeenCalledWith("steerWithEnter", undefined, 2);
  });

  it("hides thinking by default and accepts an explicit visible setting", async () => {
    const { readSettings } = await import("../src/config/settings.js");
    expect(readSettings().showThinking).toBe(false);
    mocks.values.set("showThinking", true);
    expect(readSettings().showThinking).toBe(true);
  });

  it("defaults to an unlimited reasoning budget and accepts a token limit", async () => {
    const { readSettings } = await import("../src/config/settings.js");
    expect(readSettings().reasoningBudget).toBeNull();
    mocks.values.set("reasoningBudget", 4096);
    expect(readSettings().reasoningBudget).toBe(4096);
  });

  it.each([undefined, null, -1, 0, -10, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "4096"])("reads invalid or empty saved budget %s as unlimited", async budget => {
    const { readSettings } = await import("../src/config/settings.js");
    mocks.values.set("reasoningBudget", budget);
    expect(readSettings().reasoningBudget).toBeNull();
  });

  it.each([null, 1, 4096, Number.MAX_SAFE_INTEGER])("saves valid reasoning budget %s", async budget => {
    const { writeSetting } = await import("../src/config/settings.js");
    await writeSetting("reasoningBudget", budget);
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith("reasoningBudget", budget, 1);
  });

  it.each([-1, 0, -10, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "4096", "", undefined])("rejects invalid reasoning budget %s before saving", async budget => {
    const { writeSetting } = await import("../src/config/settings.js");
    await expect(writeSetting("reasoningBudget", budget as number)).rejects.toThrow("positive whole number");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("defaults to the local model id", async () => {
    const { readSettings } = await import("../src/config/settings.js");
    expect(readSettings().model).toBe("local");
  });

  it("reads the configurable reasoning-effort dictionary", async () => {
    mocks.values.set("reasoningEfforts", { Quick: "minimal", Deep: "xhigh" });
    const { readSettings } = await import("../src/config/settings.js");
    expect(readSettings().reasoningEfforts).toEqual({ Quick: "minimal", Deep: "xhigh" });
  });
});


describe("approval setting scope", () => {
  it.each(["autoapproveReads", "autoapproveWrites", "autoapproveCommands"] as const)("updates the effective override for %s", async key => {
    const { writeSetting } = await import("../src/config/settings.js");
    await writeSetting(key, true, "effective");
    expect(mocks.update).toHaveBeenLastCalledWith(key, true, 1);
    mocks.workspace.set(key, false);
    await writeSetting(key, true, "effective");
    expect(mocks.update).toHaveBeenLastCalledWith(key, true, 2);
    mocks.folders.set(key, false);
    await writeSetting(key, true, "effective");
    expect(mocks.update).toHaveBeenLastCalledWith(key, true, 3);
  });
});

describe("workspace memory setting", () => {
  it("defaults to ten memories, bounds the count, and saves it for the workspace", async () => {
    const { readSettings, writeSetting } = await import("../src/config/settings.js");
    expect(readSettings().memoryMaxCount).toBe(10);
    for (const [value, expected] of [[3, 3], [12, 12], [3.9, 3], [0, 1], [200, 100], [NaN, 10]]) {
      mocks.values.set("memoryMaxCount", value);
      expect(readSettings().memoryMaxCount).toBe(expected);
    }
    await writeSetting("memoryMaxCount", 12);
    expect(mocks.update).toHaveBeenCalledWith("memoryMaxCount", 12, 2);
  });

  const switches = ["memoryEnabled", "memoryLoadOnStart", "autoGenerateMemories"] as const;
  it.each(switches)("%s is independently opt-in for this workspace and ignores global activation", async key => {
    const { readSettings, writeSetting, resetAllSettings } = await import("../src/config/settings.js");
    expect(readSettings()[key]).toBe(false);
    mocks.values.set(key, true);
    mocks.explicit.set(key, true);
    expect(readSettings()[key]).toBe(false);
    mocks.workspace.set(key, true);
    expect(readSettings()[key]).toBe(true);
    for (const other of switches.filter(other => other !== key)) expect(readSettings()[other]).toBe(false);
    await writeSetting(key, true);
    expect(mocks.update).toHaveBeenCalledWith(key, true, 2);
    await resetAllSettings();
    expect(mocks.update).toHaveBeenCalledWith(key, undefined, 2);
  });
});
