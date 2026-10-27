/**
 * Thinking Compression — pi-durable entrypoint.
 *
 * Durable entries are immutable, so instead of rewriting stored messages at
 * message_end (the pi-coding-agent extension's approach), this extension
 * rewrites the *request*: a GenerationTask `beforeRequest` hook replaces
 * compressible thinking blocks in the outgoing messages only. Compressions
 * are cached by content hash for the process lifetime, so each unique block
 * is compressed at most once per process; a restart simply recompresses.
 *
 * The compressor model is reached through the harness's own `Models`
 * (`api.models`), so provider auth, identity, and retry policy match the
 * host's generation path.
 */

import { createHash } from "node:crypto";
import { defineExtension, GenerationTask, hook, type HookApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { COMPRESSOR_INSTRUCTIONS, type ThinkingCompressionConfig } from "./src/config-core.ts";
import { candidateFromMessage, isConfiguredSource } from "./src/eligibility.ts";
import { visibleText } from "./src/compressor.ts";

function hashOf(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Compress one thinking block; undefined when compression is unavailable or not worthwhile. */
async function compressThinking(
	api: HookApi,
	config: ThinkingCompressionConfig & { compressor: NonNullable<ThinkingCompressionConfig["compressor"]> },
	message: Message,
	thinking: string,
	context: Context,
): Promise<string | undefined> {
	const target = api.models.getModel(config.compressor.provider, config.compressor.model);
	if (!target) return undefined;
	const controller = new AbortController();
	const abort = () => controller.abort();
	const timer = setTimeout(abort, config.compressor.timeoutMs);
	context.abortSignal?.addEventListener("abort", abort, { once: true });
	try {
		const result: AssistantMessage = await api.models.completeSimple(target as Model<never>, {
			systemPrompt: COMPRESSOR_INSTRUCTIONS,
			messages: [{ role: "user", content: JSON.stringify({ thinking, visibleAssistantText: visibleText(message) }), timestamp: Date.now() }],
		}, {
			maxTokens: config.compressor.maxOutputTokens,
			signal: controller.signal,
		});
		const content = visibleText(result);
		if (!content) return undefined;
		const parsed: unknown = JSON.parse(content);
		const replacement = parsed && typeof parsed === "object" ? (parsed as { thinking?: unknown }).thinking : undefined;
		if (typeof replacement !== "string" || !replacement.trim() || /\b(tool_calls?|function_call)\b/i.test(replacement)) return undefined;
		if (replacement.length >= thinking.length || 1 - replacement.length / thinking.length < config.minimumSavingsRatio) return undefined;
		return replacement.trim();
	} catch {
		// Compression is an optimization; never fail a request for it.
		return undefined;
	} finally {
		clearTimeout(timer);
		context.abortSignal?.removeEventListener("abort", abort);
	}
}

export function createThinkingCompressionDurableExtension(config: ThinkingCompressionConfig) {
	/** Process-lifetime cache: sha256 of the original thinking → compressed memo. */
	const cache = new Map<string, string>();

	return defineExtension({
		name: "thinking-compression",
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async (request, api, context) => {
					if (!config.enabled || !config.compressor) return undefined;
					const compressor = config.compressor;
					let changed = false;
					const messages = await Promise.all(request.messages.map(async (message): Promise<Message> => {
						if (message.role !== "assistant") return message;
						const source = { provider: message.provider, id: message.responseModel ?? message.model };
						if (!isConfiguredSource(config, source)) return message;
						const candidate = candidateFromMessage(message, true, config.minimumThinkingTokens);
						if (!candidate) return message;
						const block = message.content[candidate.index];
						if (!block || block.type !== "thinking") return message;
						const key = hashOf(candidate.thinking);
						let replacement = cache.get(key);
						if (replacement === undefined) {
							const compressed = await compressThinking(api, { ...config, compressor }, message, candidate.thinking, context);
							if (compressed === undefined) return message;
							replacement = compressed;
							cache.set(key, replacement);
						}
						const content = [...message.content];
						content[candidate.index] = { ...block, thinking: replacement };
						changed = true;
						return { ...message, content };
					}));
					return changed ? { messages } : undefined;
				},
			}),
		],
	});
}

export default createThinkingCompressionDurableExtension;
