import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, type ThinkingCompressionConfig } from "./src/config.ts";
import { compress } from "./src/compressor.ts";
import { candidateFromMessage, isConfiguredSource } from "./src/eligibility.ts";

const STATUS_KEY = "thinking-compression";

/**
 * Compresses only finalized, explicitly allowlisted unsigned Pi thinking blocks.
 * This generic lifecycle implementation reduces retained context; providers that
 * need pre-display buffering must provide their own stream wrapper.
 */
export default function thinkingCompressionExtension(pi: ExtensionAPI): void {
	let config: ThinkingCompressionConfig = { enabled: false, sources: [], minimumThinkingTokens: 800, minimumSavingsRatio: 0.35 };
	let configError: string | undefined;

	function refresh(ctx: any): void {
		const loaded = loadConfig(ctx);
		config = loaded.config;
		configError = loaded.error;
		if (ctx.mode === "tui") {
			ctx.ui.setStatus(STATUS_KEY, config.enabled ? `Thinking compression: ${config.compressor?.provider}/${config.compressor?.model}` : undefined);
			if (configError) ctx.ui.notify(`Thinking compression disabled: ${configError}`, "warning");
		}
	}

	pi.on("session_start", (_event, ctx) => refresh(ctx));
	pi.on("model_select", (_event, ctx) => refresh(ctx));
	pi.on("session_shutdown", (_event, ctx) => { if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined); });

	pi.on("message_end", async (event, ctx) => {
		const message: any = event.message;
		if (message?.role !== "assistant" || !config.enabled) return undefined;
		const source = { provider: message.provider, id: message.responseModel ?? message.model };
		const candidate = candidateFromMessage(message, isConfiguredSource(config, source), config.minimumThinkingTokens);
		if (!candidate) return undefined;
		const replacement = await compress(ctx, config, message, candidate.thinking, ctx.signal);
		if (!replacement) return undefined;
		const content = [...message.content];
		content[candidate.index] = { ...content[candidate.index], thinking: replacement.thinking };
		return {
			message: {
				...message,
				content,
				diagnostics: [...(message.diagnostics ?? []), {
					type: "thinking_compression", timestamp: Date.now(),
					details: { source: `${source.provider}/${source.id}`, compressor: replacement.model, sourceCharacters: candidate.thinking.length, compressedCharacters: replacement.thinking.length, durationMs: replacement.durationMs },
				}],
			},
		};
	});
}