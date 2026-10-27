import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { SecretStorage } from "vscode";
import { normalizeServerType, type ServerBackend, type ServerType } from "./serverTypes.js";

export interface ConnectionSettings { endpoint: string; model?: string; serverType?: ServerType }
export interface ServerConnection extends ConnectionSettings {
  serverType: ServerType;
  apiKey?: string;
  backend?: ServerBackend;
  credentialError?: Error;
}

const scope = new AsyncLocalStorage<ServerConnection>();
let settingsProvider: (() => ConnectionSettings) | undefined;
let secretStorage: SecretStorage | undefined;
let credentialRevision = 0;

/** One shared connection service for every edition and generation consumer. */
export function configureServerConnections(provider?: () => ConnectionSettings, secrets?: SecretStorage): void {
  settingsProvider = provider;
  secretStorage = secrets;
  credentialRevision++;
}

export function serverRoot(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash) throw new Error("Server URLs cannot contain credentials, query parameters, or fragments.");
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + "/";
  return url.toString();
}

export function serverUrl(endpoint: string, route: string): string {
  return new URL(route.replace(/^\//, ""), serverRoot(endpoint)).toString();
}

function secretKey(endpoint: string): string { return `locality.modelApiKey:${serverRoot(endpoint)}`; }
export async function hasServerApiKey(endpoint: string, secrets = secretStorage): Promise<boolean> {
  return !!await secrets?.get(secretKey(endpoint));
}
export async function saveServerApiKey(endpoint: string, value: string, secrets = secretStorage): Promise<void> {
  if (!secrets) throw new Error("Secret storage is unavailable.");
  if (/[\r\n]/.test(value)) throw new Error("API keys must be a single line.");
  if (value.trim()) await secrets.store(secretKey(endpoint), value.trim());
  else await secrets.delete(secretKey(endpoint));
  credentialRevision++;
}

export async function connectionFor(endpoint: string, model?: string): Promise<ServerConnection> {
  const active = scope.getStore();
  if (active?.credentialError) throw active.credentialError;
  if (active) return active;
  const configured = settingsProvider?.();
  return {
    endpoint, model: model ?? configured?.model,
    // Preserve the pre-existing standalone client API; the extension configures auto.
    serverType: configured ? normalizeServerType(configured.serverType) : "llama.cpp",
    apiKey: await secretStorage?.get(secretKey(endpoint))
  };
}

export async function withServerConnection<T>(settings: ConnectionSettings, work: () => Promise<T>, fresh = false): Promise<T> {
  if (!fresh && scope.getStore()) return work();
  const connection: ServerConnection = {
    ...settings, serverType: settings.serverType ?? (settingsProvider ? "auto" : "llama.cpp")
  };
  if (secretStorage) {
    try { connection.apiKey = await secretStorage.get(secretKey(settings.endpoint)); }
    catch { connection.credentialError = new Error("Could not read the server API key from VS Code SecretStorage. Check the system credential store and retry."); }
  }
  return scope.run(connection, work);
}

/** Keep live feature settings while retaining this attempt's connection selection. */
export function capturedConnectionSettings<T extends ConnectionSettings>(settings: T): T {
  const active = scope.getStore();
  return active ? { ...settings, endpoint: active.endpoint, model: active.model, serverType: active.serverType } : settings;
}

/** A draft connection must never inherit an ongoing turn's connection. */
export async function withConnectionDraft<T>(settings: ConnectionSettings, apiKey: string | undefined, work: () => Promise<T>): Promise<T> {
  return scope.run({ ...settings, serverType: normalizeServerType(settings.serverType),
    apiKey: apiKey ?? await secretStorage?.get(secretKey(settings.endpoint)) }, work);
}

export function connectionIdentity(endpoint: string, model?: string): string {
  const c = scope.getStore() ?? settingsProvider?.();
  return JSON.stringify([serverRoot(c?.endpoint ?? endpoint), c?.model ?? model ?? "", (c && "backend" in c ? c.backend : undefined) ?? c?.serverType ?? "llama.cpp"]);
}

export function connectionCacheKey(c: ServerConnection): string {
  const credential = createHash("sha256").update(c.apiKey ?? "").digest("hex");
  return JSON.stringify([serverRoot(c.endpoint), c.model ?? "", c.serverType, credentialRevision, credential]);
}

export function connectionHeaders(c: ServerConnection): Record<string, string> {
  return c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {};
}

export function redactServerError(text: string, c: ServerConnection): string {
  return c.apiKey ? text.replaceAll(c.apiKey, "[redacted]") : text;
}
