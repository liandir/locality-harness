import { describe, expect, it } from "vitest";
import * as esbuild from "esbuild";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import type { toolsForMode as toolSelector } from "../src/tools/toolDefinitions.js";
import type { buildSystemPrompt as promptBuilder } from "../src/llm/prompt.js";
import type { SideFeature } from "../src/build/sideContracts.js";
import type { FeatureContext, FeatureRuntime } from "../src/build/contracts.js";
import type { HarnessSettings } from "../src/config/settings.js";
import type { Memento, SecretStorage } from "vscode";
import type { SideHostFactory } from "../src/build/sideHostContracts.js";

interface Probe {
  toolsForMode: typeof toolSelector;
  buildSystemPrompt: typeof promptBuilder;
  sideFeature: SideFeature;
  createSideHost?: SideHostFactory;
  createFeatures(context: FeatureContext): FeatureRuntime[];
  readSettings(): HarnessSettings;
  writeSetting(key: string, value: unknown): Promise<void>;
  seedFeatureSettings(): Promise<void>;
}
const require = createRequire(import.meta.url);
const scriptsPath = pathToFileURL(path.resolve("scripts/build-profiles.mjs")).href;
const { profilePlugin, auditMetadata } = await import(scriptsPath) as {
  profilePlugin(profile: string): esbuild.Plugin;
  auditMetadata(profile: string, metadata: esbuild.Metafile): void;
};

async function probe(profile: string, values: Record<string, unknown> = {}, workspaceValues: Record<string, unknown> = { safeCommandPatterns: [".*"] }, verified = true) {
  const result = await esbuild.build({
    stdin: { contents: `
      export { toolsForMode } from './src/tools/toolDefinitions.ts';
      export { buildSystemPrompt } from './src/llm/prompt.ts';
      export { createFeatures } from './src/build/runtime.js';
      export { sideFeature } from './src/build/side.js';
      export { createSideHost } from './src/build/sideHost.js';
      export { readSettings, writeSetting } from './src/config/settings.ts';
      export { seedFeatureSettings } from './src/build/settings.js';
    `, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, platform: "node", format: "cjs", write: false, metafile: true,
    external: ["vscode"], plugins: [profilePlugin(profile)]
  });
  auditMetadata(profile, result.metafile!);
  const module = { exports: {} };
  const cfg = { get: (key: string) => values[key], inspect: (key: string) => ({ globalValue: values[key], workspaceValue: workspaceValues[key] }), update: async (key: string, value: unknown) => { values[key] = value; } };
  vm.runInNewContext(result.outputFiles[0].text, {
    module, exports: module.exports, require: (name: string) => name === "vscode" ? { workspace: { getConfiguration: () => cfg }, ConfigurationTarget: { Global: 1, Workspace: 2 } } : require(name),
    process, URL, AbortController, Buffer, setTimeout, clearTimeout, queueMicrotask, console
  });
  const api = module.exports as Probe;
  api.createSideHost?.({} as SecretStorage, () => {}, { get: () => verified && typeof values.webSearchEndpoint === "string" && values.webSearchEndpoint ? new URL(String(values.webSearchEndpoint)).href.replace(/\/$/, "") : undefined } as unknown as Memento);
  return { api, text: result.outputFiles[0].text, metadata: result.metafile! };
}

describe("edition composition", () => {
  it.each(["no-commands", "safe-list", "commands", "advanced"])("honors tool switches across %s modes and transports", async profile => {
    const { api } = await probe(profile, { webSearchEndpoint: "https://search.example" });
    for (const key of ["readToolsEnabled", "editToolsEnabled", ...(profile !== "no-commands" ? ["commandToolsEnabled"] : []), ...(profile === "advanced" ? ["webRequestsEnabled"] : [])]) {
      await api.writeSetting(key, false);
    }
    const settings = api.readSettings();
    for (const mode of ["act", "plan", "review"] as const) for (const transport of ["native", "legacy"] as const) {
      const names = api.toolsForMode(mode, transport, false, true, settings).map(tool => tool.name);
      expect(names).toEqual(mode === "act" ? ["ask_user_question", "update_todos"] : ["ask_user_question"]);
      const prompt = api.buildSystemPrompt({ family: "gemma4", mode, nativeTools: transport === "native", memoryEnabled: false, supportsVision: true, workspaceRoot: "/tmp", featureSettings: settings });
      expect(prompt).not.toMatch(/run_command|wait_process|stop_process|web_search|read_webpage|search_memories|recall_memory|view_image is available|declaration:read_file|declaration:write_file/);
      expect(api.toolsForMode(mode, transport, true, true, settings).map(tool => tool.name))
        .toEqual(["search_memories", "recall_memory", ...names]);
      const memoryPrompt = api.buildSystemPrompt({ family: "gemma4", mode, nativeTools: transport === "native", memoryEnabled: true, workspaceRoot: "/tmp", featureSettings: settings });
      expect(memoryPrompt).toContain("Workspace memories are available through search_memories and recall_memory");
    }
    const disabled: string[] = [];
    api.sideFeature.render(settings as unknown as Record<string, unknown>, (key, _label, _checked, inactive) => { if (inactive) disabled.push(key); return ""; }, value => value);
    if (profile !== "no-commands") expect(disabled).toContain(profile === "safe-list" ? "autoapproveSafeCommands" : "autoapproveCommands");
    if (profile === "advanced") expect(disabled).toContain("autoapproveWebSearch");
    if (profile === "no-commands") await expect(api.writeSetting("commandToolsEnabled", true)).rejects.toThrow("unavailable");
    if (profile !== "advanced") await expect(api.writeSetting("webRequestsEnabled", true)).rejects.toThrow("unavailable");
    await api.writeSetting("readToolsEnabled", true);
    expect(api.toolsForMode("act", "native", true, true, api.readSettings()).map(tool => tool.name)).toContain("read_file");
    expect(api.toolsForMode("act", "native", true, true, api.readSettings()).map(tool => tool.name)).not.toContain("edit_file");
  });

  it.each(["no-commands", "safe-list", "commands", "advanced"])("aligns %s tools, prompts, runtimes and settings", async profile => {
    const { api, text } = await probe(profile, { webSearchEndpoint: "http://localhost:8888", safeCommandPatterns: ["git status"] });
    const settings = api.readSettings();
    const features = api.createFeatures({ workspaceRoot: "/tmp", emit() {}, async appendResult() {} });
    for (const mode of ["act", "plan", "review"] as const) for (const transport of ["native", "legacy"] as const) {
      const names = api.toolsForMode(mode, transport, false, false, settings).map(tool => tool.name);
      for (const name of ["run_command", "wait_process", "stop_process"]) {
        expect(names.includes(name)).toBe(profile !== "no-commands" && mode === "act");
      }
      if (mode !== "act") {
        for (const name of ["write_file", "create_file", "edit_file", "insert_text", "replace_range", "update_todos"]) {
          expect(names).not.toContain(name);
        }
      }
      expect(names).not.toContain("run_process");
      expect(names.includes("web_search")).toBe(profile === "advanced");
      expect(names.includes("read_webpage")).toBe(profile === "advanced");
      for (const family of ["gemma4", "qwen3", "muse-glimmer", "gpt-oss"] as const) {
        const prompt = api.buildSystemPrompt({ family, mode, nativeTools: transport === "native", workspaceRoot: "/tmp", featureSettings: settings });
        expect(prompt).not.toContain("run_process");
        expect(prompt.includes("SAFE-LIST CONFIGURATION")).toBe(profile === "safe-list" && mode === "act");
        if (profile === "no-commands" || mode !== "act") {
          for (const name of ["run_command", "wait_process", "stop_process"]) expect(prompt).not.toContain(name);
        }
        if (mode !== "act") {
          for (const name of ["write_file", "create_file", "edit_file", "insert_text", "replace_range", "update_todos"]) {
            expect(prompt).not.toContain(name);
          }
        }
        if (profile !== "advanced") expect(prompt).not.toContain("web_search");
        expect(prompt).not.toContain('"availability"');
        expect(prompt).not.toContain("You are offline");
      }
    }
    const registered = features.flatMap(feature => [...feature.tools]);
    expect(registered).not.toContain("run_process");
    expect(registered.includes("run_command")).toBe(profile !== "no-commands");
    expect(registered.includes("web_search")).toBe(profile === "advanced");
    const command = features.find(feature => feature.tools.includes("run_command"));
    if (command) {
      expect(command.autoApprovalSetting).toBe(profile === "safe-list" ? "autoapproveSafeCommands" : "autoapproveCommands");
      expect(command.needsApproval(api.readSettings())).toBe(true);
      await api.writeSetting(command.autoApprovalSetting!, true);
      expect(command.needsApproval(api.readSettings())).toBe(false);
    }
    for (const feature of features.filter(feature => feature.category(feature.tools[0]) === "search")) {
      expect(feature.autoApprovalSetting).toBe("autoapproveWebSearch");
      expect(feature.autoApprovalScope).toBe("global");
      await api.writeSetting(feature.autoApprovalSetting!, true);
      expect(feature.needsApproval(api.readSettings())).toBe(false);
    }
    const html = api.sideFeature.render(settings as unknown as Record<string, unknown>, (key, label) => `${key}:${label}`, value => value)
      + (api.sideFeature.renderSection?.(settings as unknown as Record<string, unknown>, (key, label) => `${key}:${label}`, value => value) ?? "");
    expect(html.includes("Auto-approve safe commands")).toBe(profile === "safe-list");
    expect(html.includes("Auto-approve web requests")).toBe(profile === "advanced");
    expect(html.includes('id="webSearchMaxResults"')).toBe(profile === "advanced");
    expect(html.includes('id="webSearchEndpoint"')).toBe(profile === "advanced");
    expect(html.includes('id="webSearchApiKey"')).toBe(profile === "advanced");
    expect(typeof api.createSideHost === "function").toBe(profile === "advanced");
    if (profile !== "advanced") {
      expect(text).not.toContain("autoapproveWebSearch");
      expect(text).not.toMatch(/read_webpage|webToolsEnabled|webSearchApiKey|validateWebSearch|webSearchSettings|pinnedTransport|Bearer|api\.search\.brave\.com|X-Subscription-Token/);
      expect(text).not.toContain("webSearchMaxResults");
      expect(settings).not.toHaveProperty("webSearchMaxResults");
      await expect(api.writeSetting("webSearchMaxResults", 20)).rejects.toThrow("unavailable");
      expect(settings).not.toHaveProperty("webSearchEndpoint");
      expect(settings).not.toHaveProperty("autoapproveWebSearch");
      await expect(api.writeSetting("autoapproveWebSearch", true)).rejects.toThrow("unavailable");
      await expect(api.writeSetting("webSearchEndpoint", "https://search.example")).rejects.toThrow("unavailable");
    }
    if (profile === "no-commands") {
      expect(text).not.toMatch(/run_command|run_process|wait_process|stop_process|child_process|web_search|safeCommandPatterns/);
      expect(html).toBe("");
      await expect(api.writeSetting("autoapproveCommands", true)).rejects.toThrow("unavailable");
    }
    if (profile !== "safe-list") expect(text).not.toContain("matchesSafeList");
    if (profile !== "advanced") expect(text).not.toContain("searchWeb");
    if (profile === "safe-list") {
      expect(settings.safeCommandPatterns).toEqual(["git status"]);
      expect(settings.autoapproveSafeCommands).toBe(false);
      expect(settings).not.toHaveProperty("autoapproveCommands");
      await expect(features[0].prepare("run_command", { command: "mkdir foo" }, settings)).rejects.toThrow("does not match");
    }
  });

  it.each([undefined, "", "https://unverified.example"])("omits both web tools and prompt instructions until verified (%s)", async endpoint => {
    const { api } = await probe("advanced", { webSearchEndpoint: endpoint, webToolsEnabled: true }, { webToolsEnabled: true }, false);
    const settings = api.readSettings();
    expect(settings.webToolsEnabled).toBe(false);
    await expect(api.writeSetting("webToolsEnabled", true)).rejects.toThrow("unavailable");
    for (const mode of ["act", "plan", "review"] as const) for (const transport of ["native", "legacy"] as const) {
      expect(api.toolsForMode(mode, transport, false, false, settings).map(tool => tool.name)).not.toContain("web_search");
      expect(api.toolsForMode(mode, transport, false, false, settings).map(tool => tool.name)).not.toContain("read_webpage");
      for (const family of ["gemma4", "qwen3", "muse-glimmer", "gpt-oss"] as const) {
        expect(api.buildSystemPrompt({ family, mode, nativeTools: transport === "native", workspaceRoot: "/tmp", featureSettings: settings })).not.toMatch(/web_search|read_webpage/);
      }
    }
  });

  it("does not let workspace settings grant safe command permissions", async () => {
    const { api } = await probe("safe-list", { safeCommandPatterns: [] });
    expect(api.readSettings().safeCommandPatterns).toEqual([]);
    const { api: invalid } = await probe("safe-list", { safeCommandPatterns: null });
    expect(invalid.readSettings().safeCommandPatterns).toBeNull();
  });

  it("omits explicitly disabled search and refuses stale search tools without a destination", async () => {
    const { api } = await probe("advanced", { webSearchEndpoint: "" });
    expect(api.toolsForMode("act", "native", false, false, api.readSettings()).map(tool => tool.name)).not.toContain("web_search");
    const feature = api.createFeatures({ workspaceRoot: "/tmp", emit() {}, async appendResult() {} }).find(item => item.tools.includes("web_search"))!;
    expect(feature.needsApproval(api.readSettings())).toBe(true);
    await expect(feature.prepare("web_search", { query: "docs" }, api.readSettings())).rejects.toThrow("Verify");
  });

  it("defaults to Brave without enabling web tools and ignores workspace overrides", async () => {
    const { api } = await probe("advanced", {}, { webSearchEndpoint: "https://workspace.example", autoapproveWebSearch: true });
    const settings = api.readSettings();
    expect(settings.webSearchEndpoint).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(settings.webToolsEnabled).toBe(false);
    expect(settings.autoapproveWebSearch).toBe(false);
    const feature = api.createFeatures({ workspaceRoot: "/tmp", emit() {}, async appendResult() {} }).find(item => item.tools.includes("web_search"))!;
    expect(feature.needsApproval(settings)).toBe(true);
    await expect(feature.prepare("web_search", { query: "docs" }, settings)).rejects.toThrow("Verify");
    expect(api.toolsForMode("act", "native", false, false, settings).map(tool => tool.name)).not.toContain("web_search");
    await api.writeSetting("webSearchEndpoint", "https://search.example");
    expect(api.readSettings().webToolsEnabled).toBe(false);
    const { api: verified } = await probe("advanced", { webSearchEndpoint: "https://search.example" });
    const configured = verified.readSettings();
    for (const mode of ["act", "plan", "review"] as const) {
      expect(api.toolsForMode(mode, "native", false, false, configured).map(tool => tool.name)).toContain("web_search");
      expect(api.buildSystemPrompt({ family: "gemma4", mode, nativeTools: true, workspaceRoot: "/tmp", featureSettings: configured })).toContain("The user approves each web request");
    }
  });

  it("saves the search result limit from Tools settings and advertises it in every mode", async () => {
    const values: Record<string, unknown> = { webSearchEndpoint: "https://search.example" };
    const { api } = await probe("advanced", values);
    expect(api.readSettings().webSearchMaxResults).toBe(10);
    const listeners = new Map<string, (event: Event) => void>();
    const root = { querySelector: (selector: string) => ({ addEventListener: (_event: string, listener: (event: Event) => void) => listeners.set(selector, listener) }) } as unknown as HTMLElement;
    const messages: unknown[] = [];
    api.sideFeature.bind(root, message => messages.push(message));
    for (const [raw, expected] of [["20", 20], ["3", 3], ["30", 20], ["0", 1], ["3.8", 3], ["", 10]] as const) {
      const input = { value: String(raw) };
      listeners.get("#webSearchMaxResults")!({ currentTarget: input } as unknown as Event);
      expect(input.value).toBe(String(expected));
      expect(messages.at(-1)).toEqual({ type: "saveSetting", key: "webSearchMaxResults", value: expected });
      await api.writeSetting("webSearchMaxResults", expected);
      expect(values.webSearchMaxResults).toBe(expected);
      const settings = api.readSettings();
      expect(settings.webSearchMaxResults).toBe(expected);
      const html = api.sideFeature.renderSection!(settings as unknown as Record<string, unknown>, () => "", value => value);
      expect(html).toContain("Maximum number of search results");
      expect(html).toContain(`min="1" max="20" step="1" value="${expected}"`);
      for (const mode of ["act", "plan", "review"] as const) for (const transport of ["native", "legacy"] as const) {
        const prompt = api.buildSystemPrompt({ family: "gemma4", mode, nativeTools: transport === "native", workspaceRoot: "/tmp", featureSettings: settings });
        expect(prompt).toContain(`at most ${expected} results per call`);
      }
    }
    for (const [value, expected] of [[undefined, 10], [null, 10], ["20", 10], [NaN, 10], [Infinity, 10], [-1, 1], [50, 20], [4.8, 4]] as const) {
      await api.writeSetting("webSearchMaxResults", value);
      expect(api.readSettings().webSearchMaxResults).toBe(expected);
    }
  });

  it("saves search auto-approval from the Advanced switch and updates prompts in all modes", async () => {
    const { api } = await probe("advanced", { webSearchEndpoint: "https://search.example" });
    const listeners = new Map<string, (event: Event) => void>();
    const root = { querySelector: (selector: string) => ({ addEventListener: (_event: string, listener: (event: Event) => void) => listeners.set(selector, listener) }) } as unknown as HTMLElement;
    const messages: unknown[] = [];
    api.sideFeature.bind(root, message => messages.push(message));
    expect(listeners.has("#webSearchEndpoint")).toBe(true);
    listeners.get("#autoapproveWebSearch")!({ target: { checked: true } } as unknown as Event);
    expect(messages).toEqual([{ type: "saveSetting", key: "autoapproveWebSearch", value: true }]);
    await api.writeSetting("autoapproveWebSearch", true);
    const settings = api.readSettings();
    expect(settings.autoapproveWebSearch).toBe(true);
    const feature = api.createFeatures({ workspaceRoot: "/tmp", emit() {}, async appendResult() {} }).find(item => item.tools.includes("web_search"))!;
    expect(feature.needsApproval(settings)).toBe(false);
    const html = api.sideFeature.render(settings as unknown as Record<string, unknown>, (key, _label, checked) => `${key}:${checked}`, value => value);
    expect(html).toContain("autoapproveWebSearch:true");
    for (const mode of ["act", "plan", "review"] as const) {
      const prompt = api.buildSystemPrompt({ family: "gemma4", mode, nativeTools: true, workspaceRoot: "/tmp", featureSettings: settings });
      expect(prompt).toContain("The user has enabled automatic web-request approval.");
      expect(prompt).not.toContain("The user approves each web request");
    }
    await api.writeSetting("autoapproveWebSearch", false);
    expect(feature.needsApproval(api.readSettings())).toBe(true);
  });

  it("does not persist the default endpoint and preserves configured or disabled endpoints", async () => {
    const values: Record<string, unknown> = {};
    const { api } = await probe("advanced", values);
    await api.seedFeatureSettings();
    expect(values.webSearchEndpoint).toBeUndefined();
    for (const endpoint of ["https://custom.example", ""]) {
      await api.writeSetting("webSearchEndpoint", endpoint);
      await api.seedFeatureSettings();
      expect(values.webSearchEndpoint).toBe(endpoint);
      expect(api.readSettings().webSearchEndpoint).toBe(endpoint);
    }
  });

  it("ignores workspace search overrides and accepts only explicit boolean auto-approval", async () => {
    const { api } = await probe("advanced", { webSearchEndpoint: " https://user.example/ ", autoapproveWebSearch: false }, { webSearchEndpoint: "https://workspace.example", autoapproveWebSearch: true });
    expect(api.readSettings()).toMatchObject({ webSearchEndpoint: "https://user.example/", autoapproveWebSearch: false });
    const { api: invalid } = await probe("advanced", { webSearchEndpoint: 123, autoapproveWebSearch: "true" });
    expect(invalid.readSettings()).toMatchObject({ webSearchEndpoint: "", autoapproveWebSearch: false });
  });

  it("rechecks safe policy, command identity and workspace identity after approval", async () => {
    const { api } = await probe("safe-list", { safeCommandPatterns: ["mkdir [a-z]+"] });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "locality-approval-"));
    try {
      await fs.mkdir(path.join(directory, "first"));
      await fs.mkdir(path.join(directory, "second"));
      const root = path.join(directory, "workspace");
      await fs.symlink(path.join(directory, "first"), root, "dir");
      const [feature] = api.createFeatures({ workspaceRoot: root, emit() {}, async appendResult() {} });
      const args = { command: "mkdir one" };
      await feature.prepare("run_command", args, api.readSettings());
      await expect(feature.prepare("run_command", args, { ...api.readSettings(), safeCommandPatterns: [] })).rejects.toThrow("does not match");
      args.command = "mkdir two";
      await expect(feature.prepare("run_command", args, api.readSettings())).rejects.toThrow("changed while approval");
      args.command = "mkdir one";
      await fs.unlink(root);
      await fs.symlink(path.join(directory, "second"), root, "dir");
      await expect(feature.prepare("run_command", args, api.readSettings())).rejects.toThrow("changed while approval");
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

  it.each([
    ["no-commands", "src/tools/terminalTool.ts"],
    ["safe-list", "src/features/commands/full/runtime.ts"],
    ["commands", "src/features/webSearch/runtime.ts"],
    ["advanced", "src/features/commands/safeList/runtime.ts"]
  ])("rejects even unused cross-edition imports in %s", async (profile, file) => {
    await expect(esbuild.build({ stdin: { contents: `import './${file}';`, resolveDir: process.cwd() }, bundle: true, platform: "node", write: false, external: ["vscode"], plugins: [profilePlugin(profile)], logLevel: "silent" })).rejects.toThrow("must not include");
  });
});
