export type ServerType = "auto" | "llama.cpp" | "vllm";
export type ServerBackend = Exclude<ServerType, "auto">;
export type ModelProtocol = "responses" | "chat-completions";
export function normalizeModelProtocol(value: unknown): ModelProtocol {
  return value === "chat-completions" ? value : "responses";
}
export type ImageSupport = "supported" | "unsupported" | "unknown";

export function normalizeServerType(value: unknown): ServerType {
  return value === "llama.cpp" || value === "vllm" ? value : "auto";
}

export interface ServerMetadata {
  modelAlias: string;
  contextSize: number;
  /** Whether images may be submitted, including unverified vLLM models. */
  supportsVision: boolean;
  backend?: ServerBackend;
  imageSupport?: ImageSupport;
}

export interface ServerModel { id: string; contextSize?: number; owner?: string }
