import { createRequire as __createRequire } from 'node:module';const require = __createRequire(import.meta.url);

// extensions/thinking-compression/durable.ts
import { createHash } from "node:crypto";
import { defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";

// extensions/thinking-compression/src/config-core.ts
var COMPRESSOR_INSTRUCTIONS = 'Return only JSON: {"thinking":"concise continuation memo"}. Preserve decisions, constraints, uncertainty, and facts. Do not answer the user, invoke tools, provide chain-of-thought, or include credentials.';

// extensions/thinking-compression/src/eligibility.ts
function isConfiguredSource(config, model) {
  return config.enabled === true && !!model && config.sources.some((source) => source.provider === model.provider && source.model === model.id);
}
function candidateFromMessage(message, sourceAllowed, minimumTokens) {
  if (!sourceAllowed || message?.role !== "assistant" || !Array.isArray(message.content)) return void 0;
  for (let index = 0; index < message.content.length; index++) {
    const block = message.content[index];
    if (!block || block.type !== "thinking" || typeof block.thinking !== "string") continue;
    const signed = Object.prototype.hasOwnProperty.call(block, "thinkingSignature") || Object.prototype.hasOwnProperty.call(block, "signature");
    const encrypted = Object.prototype.hasOwnProperty.call(block, "encrypted") || Object.prototype.hasOwnProperty.call(block, "encryptedThinking");
    const replayRequired = Object.prototype.hasOwnProperty.call(block, "reasoningId") || Object.prototype.hasOwnProperty.call(block, "replayToken");
    if (signed || encrypted || replayRequired || block.thinking.length < minimumTokens * 4) continue;
    return { index, thinking: block.thinking, signed, encrypted, replayRequired };
  }
  return void 0;
}

// extensions/thinking-compression/src/compressor.ts
function visibleText(message) {
  if (!Array.isArray(message?.content)) return void 0;
  const text = message.content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
  return text || void 0;
}

// extensions/thinking-compression/durable.ts
function hashOf(text) {
  return createHash("sha256").update(text).digest("hex");
}
async function compressThinking(api, config, message, thinking, context) {
  const target = api.models.getModel(config.compressor.provider, config.compressor.model);
  if (!target) return void 0;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, config.compressor.timeoutMs);
  context.abortSignal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await api.models.completeSimple(target, {
      systemPrompt: COMPRESSOR_INSTRUCTIONS,
      messages: [{ role: "user", content: JSON.stringify({ thinking, visibleAssistantText: visibleText(message) }), timestamp: Date.now() }]
    }, {
      maxTokens: config.compressor.maxOutputTokens,
      signal: controller.signal
    });
    const content = visibleText(result);
    if (!content) return void 0;
    const parsed = JSON.parse(content);
    const replacement = parsed && typeof parsed === "object" ? parsed.thinking : void 0;
    if (typeof replacement !== "string" || !replacement.trim() || /\b(tool_calls?|function_call)\b/i.test(replacement)) return void 0;
    if (replacement.length >= thinking.length || 1 - replacement.length / thinking.length < config.minimumSavingsRatio) return void 0;
    return replacement.trim();
  } catch {
    return void 0;
  } finally {
    clearTimeout(timer);
    context.abortSignal?.removeEventListener("abort", abort);
  }
}
function createThinkingCompressionDurableExtension(config) {
  const cache = /* @__PURE__ */ new Map();
  return defineExtension({
    name: "thinking-compression",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (request, api, context) => {
          if (!config.enabled || !config.compressor) return void 0;
          const compressor = config.compressor;
          let changed = false;
          const messages = await Promise.all(request.messages.map(async (message) => {
            if (message.role !== "assistant") return message;
            const source = { provider: message.provider, id: message.responseModel ?? message.model };
            if (!isConfiguredSource(config, source)) return message;
            const candidate = candidateFromMessage(message, true, config.minimumThinkingTokens);
            if (!candidate) return message;
            const block = message.content[candidate.index];
            if (!block || block.type !== "thinking") return message;
            const key = hashOf(candidate.thinking);
            let replacement = cache.get(key);
            if (replacement === void 0) {
              const compressed = await compressThinking(api, { ...config, compressor }, message, candidate.thinking, context);
              if (compressed === void 0) return message;
              replacement = compressed;
              cache.set(key, replacement);
            }
            const content = [...message.content];
            content[candidate.index] = { ...block, thinking: replacement };
            changed = true;
            return { ...message, content };
          }));
          return changed ? { messages } : void 0;
        }
      })
    ]
  });
}
var durable_default = createThinkingCompressionDurableExtension;
export {
  createThinkingCompressionDurableExtension,
  durable_default as default
};
