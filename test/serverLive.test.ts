import { describe, expect, it } from "vitest";
import { safeFetch } from "../src/network/safeFetch.js";
import { serverUrl, withConnectionDraft } from "../src/llm/connection.js";
import { fetchServerMetadata, complete, streamChat, type LlmStreamChunk } from "../src/llm/client.js";

// External servers only: this suite never installs models or starts a server.
const targets = [
  { name: "QWEN", model: "Qwen/Qwen3-4B", backend: "vllm" as const },
  { name: "GPTOSS", model: "openai/gpt-oss-20b", backend: "vllm" as const },
  { name: "VISION", model: "Qwen/Qwen2.5-VL-3B-Instruct", backend: "vllm" as const },
  { name: "LLAMA", model: "local", backend: "llama.cpp" as const }
];
for (const target of targets) {
  const endpoint = process.env[`LOCALITY_LIVE_${target.name}_ENDPOINT`];
  describe.skipIf(!endpoint)(`live ${target.name} server`, () => {
    it("validates metadata, bounded generation and model-specific capabilities", async () => {
      const url = endpoint!;
      const model = process.env[`LOCALITY_LIVE_${target.name}_MODEL`] ?? target.model;
      const key = process.env[`LOCALITY_LIVE_${target.name}_API_KEY`];
      await withConnectionDraft({ endpoint: url, model, serverType: "auto" }, key, async () => {
        const metadata = await fetchServerMetadata(url, { model, force: true });
        expect(metadata.backend).toBe(target.backend);
        expect(metadata.contextSize).toBeGreaterThan(0);
        if (target.backend === "vllm") {
          const version = await safeFetch(url, serverUrl(url, "version"), { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10_000) });
          expect(version.ok).toBe(true);
          expect(await version.json()).toMatchObject({ version: "0.32.0" });
        }
        const signal = AbortSignal.timeout(120_000);
        if (target.name === "VISION") {
          const text = await complete(url, { model, purpose: "auxiliary", max_tokens: 128, messages: [{ role: "user", content: [
            { type: "text", text: "Describe the image briefly." },
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" } }
          ] }] }, signal);
          expect(text.trim()).not.toBe("");
          expect((await fetchServerMetadata(url, { model })).imageSupport).toBe("supported");
        } else if (target.name === "QWEN") {
          const chunks: LlmStreamChunk[] = [];
          for await (const chunk of streamChat(url, { model, temperature: 0, max_tokens: 512, thinking_budget_tokens: 32,
            tools: [{ type: "function", function: { name: "read_status", description: "Read the current status", parameters: { type: "object", properties: {} } } }],
            messages: [{ role: "user", content: "Use read_status to check the current status." }] }, signal)) chunks.push(chunk);
          const tool = chunks.find(c => c.kind === "toolCall");
          expect(tool?.kind).toBe("toolCall");
          if (tool?.kind !== "toolCall") throw new Error("Model did not call the tool");
          expect(await complete(url, { model, purpose: "auxiliary", max_tokens: 256, messages: [
            { role: "user", content: "Read the status." },
            { role: "assistant", content: "", tool_calls: [{ id: tool.id!, type: "function", function: { name: tool.name, arguments: tool.argsJson } }] },
            { role: "tool", content: "All checks passed.", tool_call_id: tool.id }
          ] }, signal)).toBeTruthy();
        } else {
          expect(await complete(url, { model, max_tokens: 1024, ...(target.name === "GPTOSS" ? { reasoning_effort: "low" } : { purpose: "auxiliary" as const }),
            messages: [{ role: "user", content: "What is 2 + 2? Answer briefly." }] }, signal)).toBeTruthy();
        }
      });
    }, 180_000);
  });
}
