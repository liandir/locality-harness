import { renderSettings, renderToolAutoApprovals, clampPercent } from "./settings.js";
import { renderMemories, bindMemories, memoryContextActions } from "./memories.js";
import type { SideViewState } from "./types.js";
import { escapeHtml as esc } from "../../html.js";
import { sideFeature } from "../../../build/side.js";
import { preserveFormFocus } from "../../formFocus.js";
import { installTooltips } from "../../tooltips.js";
import { chatContextActions, installChatContextMenu } from "../../chatContextMenu.js";
import { memoryIcon, searchIcon, trashIcon, plusIcon, settingsIcon, historyIcon } from "../../icons.js";
import { DEFAULT_MEMORY_MAX_COUNT, MAX_MEMORY_COUNT } from "../../../chat/memoryLimits.js";
import { isReasoningBudget } from "../../../chat/reasoningBudget.js";
import type { ExtToSide, SideToExt } from "../../messaging.js";
import type { SettingsSection, SideTab } from "../../messaging.js";
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_NONE,
  type ReasoningEffort
} from "../../../chat/reasoningEffort.js";

declare function acquireVsCodeApi(): {
  postMessage(msg: SideToExt): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

const state: SideViewState = {
  tab: "welcome",
  search: "",
  chats: [],
  settings: {},
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  serverModels: [],
  openTabs: [],
  memories: [],
  memoryPanel: { editors: [] },
  version: ""
};

let endpointRequestSequence = 0;
let expandedSettings = new Set<SettingsSection>();

const root = document.getElementById("app")!;
installTooltips();

function send(msg: SideToExt): void {
  if (msg.type === "saveSetting") state.settings[msg.key] = msg.value;
  vscode.postMessage(msg);
}

function render(preserveDrafts = true): void {
  const restoreFocus = preserveFormFocus(root, preserveDrafts);
  const keepSearchFocus = (document.activeElement as HTMLElement | null)?.id === "chatSearch";
  root.innerHTML = `
    <div class="tabs">
      ${tabBtn("welcome", "Welcome")}
      ${tabBtn("chats", "Chats")}
      ${tabBtn("memories", "Memories")}
      ${tabBtn("settings", "Settings")}
    </div>
    <div class="tab-body">
      ${state.tab === "welcome" ? renderWelcome() : state.tab === "chats" ? renderChats() : state.tab === "memories" ? renderMemories(state, ago) : renderSettings(state, expandedSettings)}
    </div>
  `;
  bind();
  restoreFocus();
  if (keepSearchFocus) {
    const input = root.querySelector("#chatSearch") as HTMLInputElement | null;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }
}

function tabBtn(id: SideTab, label: string): string {
  const active = state.tab === id ? "active" : "";
  const icon = id === "chats" ? historyIcon() : id === "settings" ? settingsIcon() : id === "memories" ? memoryIcon() : "";
  return `<button class="tab-btn ${active}" id="tab-${id}" data-tab="${id}">${icon}<span>${label}</span></button>`;
}

function renderWelcome(): string {
  return `
    <div class="panel welcome-panel">
      <section class="welcome-section welcome-hero">
        <span class="welcome-logo" aria-hidden="true"></span>
        <h2>Welcome to Locality</h2>
        <p class="welcome-copy">Your local AI coding assistant.</p>
      </section>

      <section class="welcome-actions">
        <div class="welcome-group">
          <p class="welcome-caption">Start chatting immediately.</p>
          <button id="newChat" class="action-btn welcome-button icon-label">${plusIcon()}<span>Start new chat</span></button>
        </div>
        <div class="welcome-group">
          <p class="welcome-caption">Continue, where you left off.</p>
          <button id="openRecentChats" class="action-btn welcome-button icon-label">${historyIcon()}<span>Open recent chats</span></button>
        </div>
        <div class="welcome-group">
          <p class="welcome-caption">Set things up, before you get started.</p>
          <button id="openSettings" class="action-btn welcome-button icon-label">${settingsIcon()}<span>Open settings</span></button>
        </div>
      </section>
      <footer class="welcome-footer">
        ${state.version ? `<span>v${esc(state.version)}</span><span aria-hidden="true">·</span>` : ""}
        <span>${esc(sideFeature.label.toLowerCase())}</span><span aria-hidden="true">·</span>
        <button id="openGithub" class="link-button" type="button">GitHub</button>
      </footer>
    </div>
  `;
}

function renderChats(): string {
  const query = state.search.trim().toLowerCase();
  const chats = query
    ? state.chats.filter(c => c.title.toLowerCase().includes(query))
    : state.chats;
  return `
    <div class="panel chats-panel">
      <section class="panel-section">
        <button id="newChat" class="action-btn welcome-button icon-label">${plusIcon()}<span>Start new chat</span></button>
      </section>

      ${state.openTabs.some(tab => tab.open !== false) ? `
        <section class="panel-section">
          <h3>Open</h3>
          <ul class="chat-list">${state.openTabs.filter(tab => tab.open !== false).map(t => renderChatEntry(t)).join("")}</ul>
        </section>
      ` : ""}

      <section class="panel-section">
        <h3>Find</h3>
        <div class="search-box">
          ${searchIcon()}
          <input id="chatSearch" type="search" value="${esc(state.search)}" placeholder="Search chats" />
        </div>
      </section>

      <section class="panel-section">
        <h3>Chats</h3>
        ${chats.length === 0 ? `<p class="empty-state">${query ? "No matching chats." : "No chats yet."}</p>` :
          `<ul class="chat-list">${chats.map(c => renderChatEntry(c)).join("")}</ul>`}
        ${state.chats.length > 0 ? `<button id="clearChats" class="action-btn wide-button danger icon-label clear-chats">${trashIcon()}<span>Clear all chats</span></button>` : ""}
      </section>
    </div>
  `;
}

function renderChatEntry(chat: { id: string; title: string; updatedAt?: number }): string {
  const running = state.openTabs.some(tab => tab.id === chat.id && tab.running);
  return `<li class="chat-entry">
    <div class="chat-row" data-open="${esc(chat.id)}" data-chat-context="${esc(chat.id)}" tabindex="0" role="button">
      <span class="chat-running-dot${running ? " running" : ""}" aria-label="${running ? "Running" : "Idle"}"></span>
      <span class="chat-row-title">${esc(chat.title)}</span>
      ${chat.updatedAt !== undefined ? `<time>${ago(chat.updatedAt)}</time>` : ""}
      <button class="icon-btn icon-btn-compact delete" data-delete="${esc(chat.id)}" data-tip="Delete" aria-label="Delete chat">${trashIcon()}</button>
    </div>
  </li>`;
}

function updateSettingsSections(): void {
  root.querySelectorAll<HTMLButtonElement>("[data-settings-section]").forEach(button => {
    const expanded = expandedSettings.has(button.dataset.settingsSection as SettingsSection);
    button.setAttribute("aria-expanded", String(expanded));
    document.getElementById(button.getAttribute("aria-controls")!)!.hidden = !expanded;
  });
}

function bind(): void {
  root.querySelectorAll<HTMLButtonElement>("[data-settings-section]").forEach(button => button.addEventListener("click", () => {
    const section = button.dataset.settingsSection as SettingsSection;
    const expanded = !expandedSettings.has(section);
    if (expanded) expandedSettings.add(section); else expandedSettings.delete(section);
    updateSettingsSections();
    send({ type: "setSettingsSectionExpanded", section, expanded });
  }));
  root.querySelectorAll<HTMLInputElement>(".tool-toggles input").forEach(input => input.addEventListener("change", () => {
    state.settings[input.id] = input.checked;
    const approvals = root.querySelector<HTMLElement>("#toolAutoApprovals")!;
    approvals.innerHTML = renderToolAutoApprovals(state.settings);
    bindApprovalSettings();
    sideFeature.bind(approvals, send);
    send({ type: "saveSetting", key: input.id, value: input.checked });
  }));
  root.querySelectorAll(".tab-btn").forEach(b => b.addEventListener("click", () => {
    const id = (b as HTMLElement).dataset.tab as SideTab;
    openTab(id);
  }));
  root.querySelector("#chatSearch")?.addEventListener("input", e => {
    state.search = (e.target as HTMLInputElement).value;
    render();
  });
  root.querySelectorAll("[data-open]").forEach(li => li.addEventListener("click", e => {
    if ((e.target as Element).closest("button")) return;
    send({ type: "openChat", id: (li as HTMLElement).dataset.open! });
  }));
  root.querySelectorAll("[data-delete]").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    send({ type: "deleteChat", id: (b as HTMLElement).dataset.delete! });
  }));
  root.querySelector("#newChat")?.addEventListener("click", () => send({ type: "newChat" }));
  root.querySelector("#clearChats")?.addEventListener("click", () => send({ type: "clearChats" }));
  root.querySelector("#openRecentChats")?.addEventListener("click", () => openTab("chats"));
  root.querySelector("#openSettings")?.addEventListener("click", () => openTab("settings"));
  root.querySelector("#openGithub")?.addEventListener("click", () => send({ type: "openGithub" }));
  const endpointInput = root.querySelector<HTMLInputElement>("#endpoint");
  endpointInput?.addEventListener("input", () => {
    state.endpointDraft = endpointInput.value;
    state.hasServerApiKey = false;
    state.endpointMsg = undefined;
    const notice = root.querySelector(".validation");
    if (notice) { notice.textContent = ""; notice.className = "validation"; }
  });
  const keyInput = root.querySelector<HTMLInputElement>("#serverApiKey");
  for (const input of [endpointInput, keyInput]) input?.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); root.querySelector<HTMLButtonElement>("#saveEndpoint")?.click(); }
  });
  root.querySelector("#saveEndpoint")?.addEventListener("click", () => {
    if (state.endpointTesting) return;
    const url = (root.querySelector("#endpoint") as HTMLInputElement).value;
    state.endpointDraft = url;
    state.endpointSubmitted = url;
    state.endpointTesting = true;
    state.endpointRequestId = ++endpointRequestSequence;
    state.endpointMsg = { text: "Detecting server and checking image support…" };
    state.endpointMetadata = undefined;
    state.serverModels = [];
    const apiKey = state.serverApiKeyDraft?.trim() || undefined;
    state.serverApiKeyDraft = undefined;
    if (keyInput) keyInput.value = "";
    render();
    send({ type: "validateEndpoint", url, requestId: state.endpointRequestId, apiKey });
  });
  keyInput?.addEventListener("input", event => {
    state.serverApiKeyDraft = (event.target as HTMLInputElement).value;
  });
  bindSetting("model", "change", v => v);
  bindSetting("toolCallingMode", "change", v => v);
  bindSetting("temperature", "change", v => Number(v));
  bindSetting("topK", "change", v => Number(v));
  bindSetting("topP", "change", v => Number(v));
  const budgetInput = root.querySelector<HTMLInputElement>("#reasoningBudget");
  budgetInput?.addEventListener("input", () => budgetInput.setCustomValidity(""));
  budgetInput?.addEventListener("change", () => {
    budgetInput.setCustomValidity("");
    const budget = budgetInput.value.trim() === "" ? null : Number(budgetInput.value);
    if (!isReasoningBudget(budget)) {
      budgetInput.setCustomValidity("Enter a positive whole number or leave empty for unlimited reasoning.");
    }
    if (!budgetInput.reportValidity()) return;
    state.reasoningBudgetError = undefined;
    state.settings.reasoningBudget = budget;
    send({ type: "saveSetting", key: "reasoningBudget", value: budget });
  });
  const stepBudget = (direction: number): void => {
    if (!budgetInput || budgetInput.disabled) return;
    budgetInput.setCustomValidity("");
    if (budgetInput.validity.badInput) { budgetInput.reportValidity(); return; }
    if (budgetInput.value === "") budgetInput.value = "1024";
    else if (budgetInput.reportValidity()) {
      budgetInput.value = String(Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Number(budgetInput.value) + direction)));
    } else return;
    budgetInput.dispatchEvent(new Event("change"));
  };
  root.querySelectorAll<HTMLButtonElement>("[data-budget-step]").forEach(button => {
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => stepBudget(Number(button.dataset.budgetStep)));
  });
  budgetInput?.addEventListener("keydown", event => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    stepBudget(event.key === "ArrowUp" ? 1 : -1);
  });
  root.querySelector<HTMLInputElement>("#reasoningEnabled")?.addEventListener("change", event => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    const effort = enabled ? DEFAULT_REASONING_EFFORT : REASONING_NONE;
    state.reasoningEffort = effort;
    state.reasoningEffortError = undefined;
    render();
    send({ type: "setReasoningEffort", effort });
  });
  root.querySelector<HTMLSelectElement>("#reasoningEffort")?.addEventListener("change", event => {
    const effort = (event.currentTarget as HTMLSelectElement).value as ReasoningEffort;
    state.reasoningEffort = effort;
    send({ type: "setReasoningEffort", effort });
  });
  bindSetting("memoryAutoLoad", "change", (_v, el) => (el as HTMLInputElement).checked);
  bindSetting("memoryMaxCount", "change", v => Math.floor(Math.max(1, Math.min(MAX_MEMORY_COUNT, Number(v) || DEFAULT_MEMORY_MAX_COUNT))));
  bindMemories(root, state, send, render);
  bindSetting("showThinking", "change", (_v, el) => (el as HTMLInputElement).checked);
  bindSetting("steerWithEnter", "change", (_v, el) => (el as HTMLInputElement).checked);
  bindSetting("autoCompact", "change", (_v, el) => (el as HTMLInputElement).checked);
  bindRangeSetting("autoCompactThresholdPercent");
  bindApprovalSettings();
  sideFeature.bind(root, send, render);
  root.querySelector("#editWorkspacePrompts")?.addEventListener("click", () => send({ type: "editWorkspacePrompts" }));
  root.querySelector("#editUserSettings")?.addEventListener("click", () => send({ type: "editUserSettingsJson" }));
  root.querySelector("#restorePrompts")?.addEventListener("click", () => send({ type: "restoreDefaultGeneratedPrompts" }));
  root.querySelector("#resetDefaults")?.addEventListener("click", () => send({ type: "resetAllDefaults" }));
}

function bindApprovalSettings(): void {
  bindSetting("autoapproveReads", "change", (_v, el) => (el as HTMLInputElement).checked);
  bindSetting("autoapproveWrites", "change", (_v, el) => (el as HTMLInputElement).checked);
}

function openTab(tab: SideTab): void {
  state.tab = tab;
  send({ type: "openTab", tab });
  render();
}

function bindSetting(id: string, evt: string, getter: (v: string, el: Element) => unknown): void {
  const el = root.querySelector("#" + id);
  if (!el) return;
  el.addEventListener(evt, () => {
    const value = getter((el as HTMLInputElement).value, el);
    send({ type: "saveSetting", key: id, value });
  });
}

function bindRangeSetting(id: string): void {
  const el = root.querySelector("#" + id) as HTMLInputElement | null;
  if (!el) return;
  el.addEventListener("input", () => {
    updateAutoCompactThresholdLabel(clampPercent(Number(el.value)));
  });
  el.addEventListener("change", () => {
    const pct = clampPercent(Number(el.value));
    el.value = String(pct);
    updateAutoCompactThresholdLabel(pct);
    send({ type: "saveSetting", key: id, value: pct });
  });
}

function updateAutoCompactThresholdLabel(percent: number): void {
  const label = root.querySelector("#autoCompactThresholdValue") as HTMLElement | null;
  if (label) label.textContent = `${percent}%`;
}

function ago(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3600_000) return Math.floor(d / 60_000) + "m";
  if (d < 86400_000) return Math.floor(d / 3600_000) + "h";
  return Math.floor(d / 86400_000) + "d";
}

window.addEventListener("message", ev => {
  const msg = ev.data as ExtToSide;
  if (sideFeature.receive?.(msg)) { render(); return; }
  switch (msg.type) {
    case "settingsSections":
      expandedSettings = new Set(msg.expanded);
      updateSettingsSections();
      break;
    case "settingSaved":
      if (["memoryEnabled", "memoryAutoLoad", "memoryMaxCount"].includes(msg.key)) {
        state.memorySettingError = msg.ok ? undefined : msg.error;
        render();
      }
      if (msg.key === "reasoningEffort" && !msg.ok) { state.reasoningEffortError = msg.error; render(); }
      if (msg.key === "reasoningBudget" && !msg.ok) { state.reasoningBudgetError = msg.error; render(); }
      break;
    case "memories": state.memories = msg.memories; state.memoryWarnings = msg.warnings; state.memoryError = undefined; render(); break;
    case "memoryPanel": {
      const previous = state.memoryPanel.editors.find(editor => editor.key === state.memoryPanel.activeKey);
      state.memoryPanel = msg.panel;
      const active = msg.panel.editors.find(editor => editor.key === msg.panel.activeKey);
      const focusEditor = active && (active.key !== previous?.key || active.mode !== previous?.mode);
      render();
      if (focusEditor) {
        const id = active.mode === "name" ? `memory-name-${active.key}` : active.mode === "edit" ? `memory-contents-${active.key}` : `memory-row-${active.id ?? `draft:${active.key}`}`;
        root.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.focus();
      }
      break;
    }
    case "memoryError": state.memoryError = msg.error; render(); break;
    case "appInfo": state.version = msg.version; render(); break;
    case "settings":
      if (msg.resetDrafts) {
        state.endpointDraft = undefined;
        state.endpointSubmitted = undefined;
        state.endpointRequestId = undefined;
        state.endpointTesting = false;
        state.endpointMsg = undefined;
        state.endpointMetadata = undefined;
        state.serverModels = [];
      }
      state.settings = msg.settings;
      state.reasoningEffort = msg.reasoningEffort;
      state.memorySettingError = undefined;
      render(!msg.resetDrafts); break;
    case "reasoningEffort": state.reasoningEffort = msg.effort; state.reasoningEffortError = undefined; render(); break;
    case "chats": state.chats = msg.chats; render(); break;
    case "focusTab": state.tab = msg.tab; render(); break;
    case "serverCredential":
      if (msg.endpoint === (state.endpointDraft ?? state.settings.endpoint)) { state.hasServerApiKey = msg.configured; render(); }
      break;
    case "endpointValidation":
      if (msg.requestId !== state.endpointRequestId && (state.endpointTesting || msg.requestId !== undefined)) break;
      state.endpointTesting = false;
      state.endpointRequestId = undefined;
      if (msg.ok && state.endpointSubmitted !== undefined) {
        state.settings.endpoint = state.endpointSubmitted;
        state.endpointDraft = undefined;
      }
      state.endpointSubmitted = undefined;
      state.endpointMsg = msg.ok
        ? { ok: true, text: `Connected — ${msg.resolved?.join(", ") ?? "allowed endpoint"}`.trim() }
        : { ok: false, text: msg.error ?? "Validation failed." };
      state.endpointMetadata = msg.ok ? msg.metadata : undefined;
      state.serverModels = msg.ok ? msg.models ?? [] : [];
      if (msg.ok && msg.selectedModel) state.settings = { ...state.settings, model: msg.selectedModel };
      render(); break;
    case "openTabs": state.openTabs = msg.tabs; render(); break;
  }
});

send({ type: "ready" });
render();

installChatContextMenu(root, () => chatContextActions(send));
installChatContextMenu(root, id => memoryContextActions(state, send, id), "data-memory-context");

root.addEventListener("keydown", event => {
  const row = (event.target as HTMLElement).closest<HTMLElement>(".chat-row[data-open]");
  if (row && event.target === row && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    send({ type: "openChat", id: row.dataset.open! });
  }
});
