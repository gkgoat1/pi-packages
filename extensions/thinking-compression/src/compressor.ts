import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { COMPRESSOR_INSTRUCTIONS } from "./config-core.ts";
import type { ThinkingCompressionConfig } from "./config-core.ts";

const INSTRUCTIONS = COMPRESSOR_INSTRUCTIONS;

export function visibleText(message: any): string | undefined {
	if (!Array.isArray(message?.content)) return undefined;
	const text = message.content.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("");
	return text || undefined;
}

export async function compress(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	config: ThinkingCompressionConfig,
	message: any,
	thinking: string,
	signal?: AbortSignal,
): Promise<{ thinking: string; model: string; durationMs: number } | undefined> {
	const target = config.compressor && ctx.modelRegistry.find(config.compressor.provider, config.compressor.model);
	if (!target || !config.compressor || !ctx.modelRegistry.hasConfiguredAuth(target)) return undefined;
	const runtime = (ctx.modelRegistry as any).runtime;
	if (!runtime?.streamSimple) return undefined;
	const controller = new AbortController();
	const abort = () => controller.abort();
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) controller.abort();
	const timeout = setTimeout(abort, config.compressor.timeoutMs);
	const started = Date.now();
	try {
		const context: Context = {
			messages: [
				{ role: "system", content: INSTRUCTIONS },
				{ role: "user", content: JSON.stringify({ thinking, visibleAssistantText: visibleText(message) }) },
			],
		} as Context;
		const stream = runtime.streamSimple(target as Model<any>, context, {
			sessionId: `thinking-compression-${crypto.randomUUID()}`,
			signal: controller.signal,
			tools: [],
			reasoning: undefined,
			maxTokens: config.compressor.maxOutputTokens,
		} as SimpleStreamOptions);
		let result: any;
		for await (const event of stream) if (event.type === "done") result = event.message;
		const content = visibleText(result);
		if (!content) return undefined;
		const parsed: unknown = JSON.parse(content);
		const replacement = parsed && typeof parsed === "object" ? (parsed as { thinking?: unknown }).thinking : undefined;
		if (typeof replacement !== "string" || !replacement.trim() || /\b(tool_calls?|function_call)\b/i.test(replacement)) return undefined;
		if (replacement.length >= thinking.length || 1 - replacement.length / thinking.length < config.minimumSavingsRatio) return undefined;
		return { thinking: replacement.trim(), model: `${target.provider}/${target.id}`, durationMs: Date.now() - started };
	} catch { return undefined; }
	finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}