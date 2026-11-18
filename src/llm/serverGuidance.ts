import type { ServerBackend } from "./serverTypes.js";

/** Deployment advice is adapter-owned, independent of task/recovery policy. */
export function serverGuidance(backend?: ServerBackend) {
  const llama = backend === "llama.cpp";
  return {
    reasoning: llama
      ? "If llama-server was started with a positive --reasoning-budget, that fixed server value overrides per-request budgets; "
      : "Server reasoning configuration may override this request; ",
    tools: llama ? "start llama-server with --jinja and a tool-aware template" : "configure --enable-auto-tool-choice and --tool-call-parser",
    museVision: llama
      ? "Muse Glimmer image input requires llama.cpp b10353 or newer, --jinja, and --mmproj mmproj-Muse-Glimmer-30B-Q4_K_M.gguf. Verify that the projector matches the loaded model."
      : "The server rejected image input. Choose a vision-capable model and verify its server configuration.",
    museTools: llama
      ? "Muse Glimmer requires native server tool support. Use llama.cpp build b10353 or newer, start llama-server with --jinja, and do not configure <|eom|> as a stop token."
      : "Muse Glimmer requires native server tool support. Configure the vLLM tool parser and preserve end-of-message tokens."
  };
}
