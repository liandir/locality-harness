import { isWebSearchVerified } from "../webSearch/verification.js";
import { BRAVE_SEARCH_ENDPOINT } from "../webSearch/providers.js";
import { normalizeSearchMaxResults } from "../webSearch/limits.js";
import type * as vscode from "vscode";
import { readFeatureSettings as commands, featureSettingKeys as keys } from "../commands/full/settings.js";

export const featureSettingKeys = [...keys, "webSearchEndpoint", "webSearchMaxResults", "autoapproveWebSearch", "webRequestsEnabled"];
export function readFeatureSettings(cfg: vscode.WorkspaceConfiguration) {
  const configured = cfg.inspect<unknown>("webSearchEndpoint")?.globalValue;
  const endpoint = configured === undefined ? BRAVE_SEARCH_ENDPOINT
    : typeof configured === "string" ? configured.trim() : "";
  return {
    ...commands(cfg),
    webSearchEndpoint: endpoint,
    webSearchMaxResults: normalizeSearchMaxResults(cfg.get<unknown>("webSearchMaxResults")),
    webRequestsEnabled: cfg.get<boolean>("webRequestsEnabled") !== false,
    webToolsEnabled: isWebSearchVerified(endpoint),
    autoapproveWebSearch: cfg.inspect<boolean>("autoapproveWebSearch")?.globalValue === true
  };
}

export { seedFeatureSettings } from "../commands/full/settings.js";
