import { createRequire as __createRequire } from 'node:module';const require = __createRequire(import.meta.url);

// extensions/thinking-compression/src/config.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

// extensions/thinking-compression/src/config-core.ts
var DISABLED_CONFIG = {
  enabled: false,
  sources: [],
  minimumThinkingTokens: 800,
  minimumSavingsRatio: 0.35
};
var COMPRESSOR_INSTRUCTIONS = 'Return only JSON: {"thinking":"concise continuation memo"}. Preserve decisions, constraints, uncertainty, and facts. Do not answer the user, invoke tools, provide chain-of-thought, or include credentials.';
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function modelRef(value) {
  const item = object(value);
  return item && typeof item.provider === "string" && item.provider && typeof item.model === "string" && item.model ? { provider: item.provider, model: item.model } : void 0;
}
function parseConfig(value) {
  const root = object(value);
  if (!root || root.enabled !== true) return DISABLED_CONFIG;
  const sources = Array.isArray(root.sources) ? root.sources.map(modelRef) : [];
  if (sources.length === 0 || sources.some((source) => !source)) throw new Error("sources must be a non-empty provider/model allowlist");
  const compressorBase = modelRef(root.compressor);
  const compressorRaw = object(root.compressor);
  if (!compressorBase || !compressorRaw) throw new Error("compressor provider/model is required");
  const maxOutputTokens = compressorRaw.maxOutputTokens;
  const timeoutMs = compressorRaw.timeoutMs;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error("compressor.maxOutputTokens must be positive");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("compressor.timeoutMs must be positive");
  const routes = sources;
  const keys = new Set(routes.map((route) => `${route.provider}\0${route.model}`));
  if (keys.size !== routes.length) throw new Error("sources contains duplicate routes");
  if (keys.has(`${compressorBase.provider}\0${compressorBase.model}`)) throw new Error("compressor must differ from every source");
  const minimumThinkingTokens = root.minimumThinkingTokens ?? 800;
  const minimumSavingsRatio = root.minimumSavingsRatio ?? 0.35;
  if (!Number.isInteger(minimumThinkingTokens) || minimumThinkingTokens < 1) throw new Error("minimumThinkingTokens must be positive");
  if (typeof minimumSavingsRatio !== "number" || minimumSavingsRatio < 0 || minimumSavingsRatio >= 1) throw new Error("minimumSavingsRatio must be between 0 and 1");
  return { enabled: true, sources: routes, compressor: { ...compressorBase, maxOutputTokens, timeoutMs }, minimumThinkingTokens, minimumSavingsRatio };
}

// extensions/thinking-compression/src/config.ts
function loadConfig(ctx) {
  if (!ctx.isProjectTrusted()) return { config: DISABLED_CONFIG };
  const path = join(ctx.cwd, CONFIG_DIR_NAME, "thinking-compression.json");
  if (!existsSync(path)) return { config: DISABLED_CONFIG };
  try {
    return { config: parseConfig(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (error) {
    return { config: DISABLED_CONFIG, error: error instanceof Error ? error.message : String(error) };
  }
}

// extensions/thinking-compression/src/compressor.ts
var INSTRUCTIONS = COMPRESSOR_INSTRUCTIONS;
function visibleText(message) {
  if (!Array.isArray(message?.content)) return void 0;
  const text = message.content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
  return text || void 0;
}
async function compress(ctx, config, message, thinking, signal) {
  const target = config.compressor && ctx.modelRegistry.find(config.compressor.provider, config.compressor.model);
  if (!target || !config.compressor || !ctx.modelRegistry.hasConfiguredAuth(target)) return void 0;
  const runtime = ctx.modelRegistry.runtime;
  if (!runtime?.streamSimple) return void 0;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, config.compressor.timeoutMs);
  const started = Date.now();
  try {
    const context = {
      messages: [
        { role: "system", content: INSTRUCTIONS },
        { role: "user", content: JSON.stringify({ thinking, visibleAssistantText: visibleText(message) }) }
      ]
    };
    const stream = runtime.streamSimple(target, context, {
      sessionId: `thinking-compression-${crypto.randomUUID()}`,
      signal: controller.signal,
      tools: [],
      reasoning: void 0,
      maxTokens: config.compressor.maxOutputTokens
    });
    let result;
    for await (const event of stream) if (event.type === "done") result = event.message;
    const content = visibleText(result);
    if (!content) return void 0;
    const parsed = JSON.parse(content);
    const replacement = parsed && typeof parsed === "object" ? parsed.thinking : void 0;
    if (typeof replacement !== "string" || !replacement.trim() || /\b(tool_calls?|function_call)\b/i.test(replacement)) return void 0;
    if (replacement.length >= thinking.length || 1 - replacement.length / thinking.length < config.minimumSavingsRatio) return void 0;
    return { thinking: replacement.trim(), model: `${target.provider}/${target.id}`, durationMs: Date.now() - started };
  } catch {
    return void 0;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

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

// extensions/thinking-compression/index.ts
var STATUS_KEY = "thinking-compression";
function thinkingCompressionExtension(pi) {
  let config = { enabled: false, sources: [], minimumThinkingTokens: 800, minimumSavingsRatio: 0.35 };
  let configError;
  function refresh(ctx) {
    const loaded = loadConfig(ctx);
    config = loaded.config;
    configError = loaded.error;
    if (ctx.mode === "tui") {
      ctx.ui.setStatus(STATUS_KEY, config.enabled ? `Thinking compression: ${config.compressor?.provider}/${config.compressor?.model}` : void 0);
      if (configError) ctx.ui.notify(`Thinking compression disabled: ${configError}`, "warning");
    }
  }
  pi.on("session_start", (_event, ctx) => refresh(ctx));
  pi.on("model_select", (_event, ctx) => refresh(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, void 0);
  });
  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    if (message?.role !== "assistant" || !config.enabled) return void 0;
    const source = { provider: message.provider, id: message.responseModel ?? message.model };
    const candidate = candidateFromMessage(message, isConfiguredSource(config, source), config.minimumThinkingTokens);
    if (!candidate) return void 0;
    const replacement = await compress(ctx, config, message, candidate.thinking, ctx.signal);
    if (!replacement) return void 0;
    const content = [...message.content];
    content[candidate.index] = { ...content[candidate.index], thinking: replacement.thinking };
    return {
      message: {
        ...message,
        content,
        diagnostics: [...message.diagnostics ?? [], {
          type: "thinking_compression",
          timestamp: Date.now(),
          details: { source: `${source.provider}/${source.id}`, compressor: replacement.model, sourceCharacters: candidate.thinking.length, compressedCharacters: replacement.thinking.length, durationMs: replacement.durationMs }
        }]
      }
    };
  });
}
export {
  thinkingCompressionExtension as default
};
