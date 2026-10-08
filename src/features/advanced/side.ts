import { sideFeature as commands } from "../commands/full/side.js";
import type { SideFeature } from "../../build/sideContracts.js";
import { MAX_SEARCH_RESULTS, normalizeSearchMaxResults } from "../webSearch/limits.js";

// Drafts stay in this webview only; never persist the key in getState/setState.
let endpoint: string | undefined;
let apiKey = "";
let loaded = false;
let dirty = false;
let testing = false;
let status: { ok?: boolean; text: string } | undefined;

export const sideFeature: SideFeature = {
  label: "Advanced",
  renderTools: (settings, toggle, escape) => (commands.renderTools?.(settings, toggle, escape) ?? "")
    + toggle("webRequestsEnabled", "Activate web requests", settings.webRequestsEnabled !== false),
  render: (settings, toggle, escape) => commands.render(settings, toggle, escape)
    + toggle("autoapproveWebSearch", "Auto-approve web requests", settings.autoapproveWebSearch === true, settings.webRequestsEnabled === false || settings.webToolsEnabled !== true),
  renderSection(settings, _toggle, escape) {
    const disabled = testing || !loaded ? "disabled" : "";
    return `<fieldset id="webSearchSettings" class="connection-settings" aria-label="Web search settings" ${settings.webRequestsEnabled === false ? "disabled" : ""}>
        <label class="field-label" for="webSearchEndpoint">Web search endpoint</label>
        <div class="setting-action-row">
          <input id="webSearchEndpoint" type="text" value="${escape(endpoint ?? String(settings.webSearchEndpoint ?? ""))}" placeholder="https://search.example.org" ${disabled} />
          <button id="setWebSearch" class="action-btn" aria-label="Test and save web search settings" ${disabled}>${testing ? "Testing…" : "Set"}</button>
        </div>
        <label class="field-label" for="webSearchApiKey">API-key</label>
        <input id="webSearchApiKey" type="password" autocomplete="off" spellcheck="false" placeholder="Required for some endpoints" ${disabled} />
        ${status ? `<div class="validation ${status.ok === false ? "err" : status.ok ? "ok" : ""}" role="${status.ok === false ? "alert" : "status"}">${escape(status.text)}</div>` : ""}
        <label class="field-label" for="webSearchMaxResults">Maximum number of search results</label>
        <input id="webSearchMaxResults" type="number" min="1" max="${MAX_SEARCH_RESULTS}" step="1" value="${normalizeSearchMaxResults(settings.webSearchMaxResults)}" aria-describedby="webSearchMaxResultsHelp" />
        <p id="webSearchMaxResultsHelp" class="setting-help">Caps results per search. The model may request fewer.</p>
      </fieldset>`;
  },
  bind(root, send, render) {
    commands.bind(root, send);
    const searchSettings = root.querySelector<HTMLFieldSetElement>("#webSearchSettings");
    root.querySelector<HTMLInputElement>("#webRequestsEnabled")?.addEventListener("change", event => {
      if (searchSettings) searchSettings.disabled = !(event.currentTarget as HTMLInputElement).checked;
    });
    root.querySelector<HTMLInputElement>("#webSearchMaxResults")?.addEventListener("change", event => {
      if (searchSettings?.disabled) return;
      const input = event.currentTarget as HTMLInputElement;
      const value = normalizeSearchMaxResults(input.value.trim() ? Number(input.value) : undefined);
      input.value = String(value);
      send({ type: "saveSetting", key: "webSearchMaxResults", value });
    });
    const endpointInput = root.querySelector<HTMLInputElement>("#webSearchEndpoint");
    const keyInput = root.querySelector<HTMLInputElement>("#webSearchApiKey");
    // Assign as an input property, keeping credentials out of generated markup.
    if (keyInput) keyInput.value = apiKey;
    endpointInput?.addEventListener("input", () => {
      endpoint = endpointInput.value; dirty = true; status = undefined;
    });
    keyInput?.addEventListener("input", () => {
      apiKey = keyInput.value; dirty = true; status = undefined;
    });
    const submit = (): void => {
      if (searchSettings?.disabled || !loaded || testing) return;
      endpoint = endpointInput?.value.trim() ?? "";
      apiKey = keyInput?.value.trim() ?? "";
      dirty = true;
      testing = true;
      status = { text: endpoint ? "Testing search connection…" : "Disabling search…" };
      send({ type: "validateWebSearch", endpoint, apiKey });
      render?.();
    };
    root.querySelector("#setWebSearch")?.addEventListener("click", submit);
    for (const input of [endpointInput, keyInput]) input?.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); submit(); }
    });
    root.querySelector<HTMLInputElement>("#autoapproveWebSearch")?.addEventListener("change", event => {
      send({ type: "saveSetting", key: "autoapproveWebSearch", value: (event.target as HTMLInputElement).checked });
    });
  },
  receive(message) {
    if (message.type === "webSearchSettings") {
      if (message.reset) { dirty = false; testing = false; status = undefined; }
      if (!dirty) {
        if (endpoint !== message.endpoint) status = undefined;
        endpoint = message.endpoint;
        apiKey = message.apiKey;
        status = message.error ? { ok: false, text: message.error }
          : message.verified ? { ok: true, text: "Connection verified." } : undefined;
      }
      loaded = true;
      return true;
    }
    if (message.type === "webSearchValidation") {
      testing = false;
      if (message.ok) {
        endpoint = message.endpoint ?? "";
        if (!endpoint) apiKey = "";
        dirty = false;
      }
      status = { ok: message.ok, text: message.ok ? (endpoint ? "Connection verified." : "Web search disabled.") : message.error ?? "Search connection failed." };
      return true;
    }
    return false;
  }
};
