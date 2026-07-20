import type { ModelRef, ThinkingCompressionConfig } from "./config.ts";

export type Candidate = { index: number; thinking: string; signed?: boolean; encrypted?: boolean; replayRequired?: boolean };

export function isConfiguredSource(config: ThinkingCompressionConfig, model: { provider: string; id: string } | undefined): boolean {
	return config.enabled === true && !!model && config.sources.some((source) => source.provider === model.provider && source.model === model.id);
}

/** Pi thinking blocks are mutable only if all protected provenance markers are absent. */
export function candidateFromMessage(message: any, sourceAllowed: boolean, minimumTokens: number): Candidate | undefined {
	if (!sourceAllowed || message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	for (let index = 0; index < message.content.length; index++) {
		const block = message.content[index];
		if (!block || block.type !== "thinking" || typeof block.thinking !== "string") continue;
		// Presence, not truthiness, protects empty signatures too.
		const signed = Object.prototype.hasOwnProperty.call(block, "thinkingSignature") || Object.prototype.hasOwnProperty.call(block, "signature");
		const encrypted = Object.prototype.hasOwnProperty.call(block, "encrypted") || Object.prototype.hasOwnProperty.call(block, "encryptedThinking");
		const replayRequired = Object.prototype.hasOwnProperty.call(block, "reasoningId") || Object.prototype.hasOwnProperty.call(block, "replayToken");
		if (signed || encrypted || replayRequired || block.thinking.length < minimumTokens * 4) continue;
		return { index, thinking: block.thinking, signed, encrypted, replayRequired };
	}
	return undefined;
}

export function routeKey(route: ModelRef): string { return `${route.provider}/${route.model}`; }