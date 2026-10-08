import { sideFeature } from "../../../build/side.js";
import { escapeHtml as esc } from "../../html.js";
import { chevronIcon } from "../../icons.js";
import type { SettingsSection } from "../../messaging.js";
import type { SideViewState } from "./types.js";
import { DEFAULT_MEMORY_MAX_COUNT, MAX_MEMORY_COUNT } from "../../../chat/memoryLimits.js";
import { DEFAULT_REASONING_EFFORT, REASONING_NONE, availableReasoningEffort, normalizeReasoningEfforts, reasoningEffortChoices } from "../../../chat/reasoningEffort.js";

export function renderSettings(state: SideViewState, expandedSettings: ReadonlySet<SettingsSection>): string {
  const section = (id: SettingsSection, label: string, content: string): string =>
    settingsSection(id, label, content, expandedSettings.has(id));

  const s = state.settings;
  const endpoint = state.endpointDraft ?? String(s["endpoint"] ?? "http://localhost:8080/v1");
  const model = String(s["model"] ?? "local");
  const toolCallingMode = String(s["toolCallingMode"] ?? "compat-gemma4");
  const temperature = String(s["temperature"] ?? 0.8);
  const topK = String(s["topK"] ?? 40);
  const topP = String(s["topP"] ?? 0.95);
  const reasoningBudget = String(s["reasoningBudget"] ?? "");
  const reasoningEfforts = normalizeReasoningEfforts(s["reasoningEfforts"]);
  const reasoningEffort = availableReasoningEffort(state.reasoningEffort, reasoningEfforts);
  const reasoningEnabled = reasoningEffort !== REASONING_NONE;
  const selectedEffort = reasoningEnabled ? reasoningEffort : DEFAULT_REASONING_EFFORT;
  const showThinking = s["showThinking"] === true;
  const autoCompact = !!s["autoCompact"];
  const autoCompactPct = clampPercent(Number(s["autoCompactThresholdPercent"] ?? 80));
  const validationCls = state.endpointMsg?.ok === true ? "ok" : state.endpointMsg?.ok === false ? "err" : "";

  return `
    <div class="panel settings-panel">
      ${state.memorySettingError ? `<p class="memory-error" role="alert">${esc(state.memorySettingError)}</p>` : ""}
      ${section("model", "Model", `
        <label class="field-label" for="endpoint">Server URL</label>
        <div class="setting-action-row">
          <input id="endpoint" type="text" value="${esc(endpoint)}" ${state.endpointTesting ? "readonly" : ""} />
          <button id="saveEndpoint" class="action-btn" ${state.endpointTesting ? "disabled" : ""}>${state.endpointTesting ? "Connecting…" : "Set"}</button>
        </div>
        <div class="validation ${validationCls}" role="${state.endpointMsg?.ok === false ? "alert" : "status"}">${esc(state.endpointMsg?.text ?? "")}</div>
        ${state.serverModels.length > 0 ? `
          <label class="field-label" for="model">Model</label>
          <select id="model">
            ${state.serverModels.map(item => `<option value="${esc(item.id)}" ${item.id === model ? "selected" : ""}>${esc(item.id)}</option>`).join("")}
          </select>
        ` : ""}
        ${state.endpointMetadata ? `<div class="endpoint-metadata">
          <div><span>Reported model</span><strong>${esc(state.endpointMetadata.modelAlias)}</strong></div>
          <div><span>Context</span><strong>${esc(state.endpointMetadata.contextSize.toLocaleString())} tokens</strong></div>
          <div><span>Image input</span><strong>${state.endpointMetadata.supportsVision ? "Supported" : "Unavailable"}</strong></div>
        </div>` : ""}

        <div class="field-row">
          <div class="field-cell">
            <label class="field-label" for="temperature">Temperature</label>
            <input id="temperature" type="number" min="0" max="2" step="0.05" value="${esc(temperature)}" />
          </div>
          <div class="field-cell">
            <label class="field-label" for="topK">Top-k</label>
            <input id="topK" type="number" min="0" step="1" value="${esc(topK)}" />
          </div>
          <div class="field-cell">
            <label class="field-label" for="topP">Top-p</label>
            <input id="topP" type="number" min="0" max="1" step="0.05" value="${esc(topP)}" />
          </div>
        </div>
        ${switchControl("reasoningEnabled", "Activate Reasoning", reasoningEnabled)}
        <label class="field-label" for="reasoningEffort">Reasoning effort</label>
        <select id="reasoningEffort" ${reasoningEnabled ? "" : "disabled"}>
          ${reasoningEffortChoices(reasoningEfforts).map(choice => `<option value="${esc(choice.effort)}" ${choice.effort === selectedEffort ? "selected" : ""}>${esc(choice.label)}</option>`).join("")}
        </select>
        ${state.reasoningEffortError ? `<p class="validation err" role="alert">${esc(state.reasoningEffortError)}</p>` : ""}
        <label class="field-label" for="reasoningBudget">Reasoning budget</label>
        <div class="number-stepper">
          <input id="reasoningBudget" type="number" min="1" max="${Number.MAX_SAFE_INTEGER}" step="1" placeholder="Unlimited" value="${esc(reasoningBudget)}" ${reasoningEnabled ? "" : "disabled"} />
          <div class="number-stepper-actions">
            <button type="button" data-budget-step="1" aria-label="Increase reasoning budget" ${reasoningEnabled ? "" : "disabled"}>${chevronIcon()}</button>
            <button type="button" data-budget-step="-1" aria-label="Decrease reasoning budget" ${reasoningEnabled ? "" : "disabled"}>${chevronIcon()}</button>
          </div>
        </div>
        ${state.reasoningBudgetError ? `<p class="validation err" role="alert">${esc(state.reasoningBudgetError)}</p>` : ""}
      `)}

      ${section("tools", "Tools", `
        <label class="field-label" for="toolCallingMode">Tool calling</label>
        <select id="toolCallingMode">
          <option value="native" ${toolCallingMode === "native" ? "selected" : ""}>Native server only</option>
          <option value="compat-gemma4" ${toolCallingMode === "compat-gemma4" ? "selected" : ""}>Gemma 4 compatibility</option>
          <option value="compat-qwen3" ${toolCallingMode === "compat-qwen3" ? "selected" : ""}>Qwen 3 compatibility</option>
          <option value="compat-muse-glimmer" ${toolCallingMode === "compat-muse-glimmer" ? "selected" : ""}>Muse Glimmer compatibility</option>
          <option value="compat-gpt-oss" ${toolCallingMode === "compat-gpt-oss" ? "selected" : ""}>GPT-OSS compatibility</option>
        </select>

        <div class="tool-toggles">
          ${switchControl("memoryEnabled", "Activate memories", s.memoryEnabled === true)}
          ${switchControl("readToolsEnabled", "Activate reads", s.readToolsEnabled !== false)}
          ${switchControl("editToolsEnabled", "Activate edits", s.editToolsEnabled !== false)}
          ${sideFeature.renderTools?.(s, switchControl, esc) ?? ""}
        </div>
        ${sideFeature.renderSection?.(s, switchControl, esc) ?? ""}
      `)}

      ${section("chat", "Chat", `
        ${switchControl("showThinking", "Show thoughts", showThinking)}
        ${switchControl("steerWithEnter", "Steer/Queue messages", s.steerWithEnter === true)}
        <p class="setting-help">${s.steerWithEnter === true ? "Enter steers; Ctrl+Enter queues." : "Enter queues; Ctrl+Enter steers."}</p>
        ${renderMemorySettings(s)}
      `)}

      ${section("automation", "Automation", `
        <div id="toolAutoApprovals">${renderToolAutoApprovals(s)}</div>
        ${switchControl("autoCompact", "Auto-compact context", autoCompact)}
        <label class="range-setting" for="autoCompactThresholdPercent">
          <span class="range-setting-head">
            <span>Auto-compact threshold</span>
            <strong id="autoCompactThresholdValue">${autoCompactPct}%</strong>
          </span>
          <input id="autoCompactThresholdPercent" type="range" min="50" max="95" step="1" value="${autoCompactPct}" />
        </label>

        ${switchControl("autoGenerateMemories", "Auto-generate memories", s.autoGenerateMemories === true)}
        <p class="setting-help">Create or update a memory after Act and Review responses, independently of memory loading and tools.</p>
      `)}

      ${section("user", "User", `
        <button id="editUserSettings" class="action-btn wide-button">Edit User Settings</button>
        <button id="editWorkspacePrompts" class="action-btn wide-button">Edit workspace prompts</button>
        <button id="restorePrompts" class="action-btn wide-button">Restore default prompts</button>
      `)}

      ${section("reset", "Reset", `
        <button id="resetDefaults" class="action-btn wide-button danger">Restore all defaults</button>
      `)}
    </div>
  `;
}

function renderMemorySettings(settings: Record<string, unknown>): string {
  return `<div class="memory-settings">
    ${switchControl("memoryLoadOnStart", "Load memories at chat start", settings.memoryLoadOnStart === true)}
    <p class="setting-help">Load relevant workspace memories from the first message. Independent of memory tools and generation.</p>
    <label class="field-label" for="memoryMaxCount">Maximum memories / search results</label>
    <input id="memoryMaxCount" type="number" min="1" max="${MAX_MEMORY_COUNT}" step="1" value="${esc(String(settings.memoryMaxCount ?? DEFAULT_MEMORY_MAX_COUNT))}" />
  </div>`;
}

export function renderToolAutoApprovals(s: Record<string, unknown>): string {
  return switchControl("autoapproveReads", "Auto-approve reads", !!s.autoapproveReads, s.readToolsEnabled === false && s.memoryEnabled !== true)
    + switchControl("autoapproveWrites", "Auto-approve edits", !!s.autoapproveWrites, s.editToolsEnabled === false)
    + sideFeature.render(s, switchControl, esc);
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 80;
  return Math.min(95, Math.max(50, Math.round(value)));
}

function switchControl(id: string, label: string, checked: boolean, disabled = false): string {
  return `<label class="switch-row${disabled ? " disabled" : ""}" for="${id}">
    <span>${esc(label)}</span>
    <input id="${id}" type="checkbox" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}/>
    <span class="switch" aria-hidden="true"></span>
  </label>`;
}

function settingsSection(id: SettingsSection, label: string, content: string, expanded: boolean): string {
  return `<section class="panel-section settings-section">
    <h3><button type="button" class="settings-section-heading" data-settings-section="${id}" aria-expanded="${expanded}" aria-controls="settings-${id}"><span>${label}</span>${chevronIcon()}</button></h3>
    <div class="settings-section-content" id="settings-${id}" ${expanded ? "" : "hidden"}>${content}</div>
  </section>`;
}
