/**
 * Pure configuration core for thinking compression — no Node or Pi imports,
 * shared by the pi-coding-agent extension (src/config.ts adds file loading)
 * and the pi-durable entrypoint (durable.ts).
 */

export interface ModelRef { provider: string; model: string }
export interface ThinkingCompressionConfig {
	enabled: boolean;
	sources: ModelRef[];
	compressor?: ModelRef & { maxOutputTokens: number; timeoutMs: number };
	minimumThinkingTokens: number;
	minimumSavingsRatio: number;
}

export const DISABLED_CONFIG: ThinkingCompressionConfig = {
	enabled: false, sources: [], minimumThinkingTokens: 800, minimumSavingsRatio: 0.35,
};

/** Prompt for the compressor model; used by both entrypoints. Keep the JSON shape in sync with the parsers. */
export const COMPRESSOR_INSTRUCTIONS = "Return only JSON: {\"thinking\":\"concise continuation memo\"}. Preserve decisions, constraints, uncertainty, and facts. Do not answer the user, invoke tools, provide chain-of-thought, or include credentials.";

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function modelRef(value: unknown): ModelRef | undefined {
	const item = object(value);
	return item && typeof item.provider === "string" && item.provider && typeof item.model === "string" && item.model
		? { provider: item.provider, model: item.model } : undefined;
}

export function parseConfig(value: unknown): ThinkingCompressionConfig {
	const root = object(value);
	if (!root || root.enabled !== true) return DISABLED_CONFIG;
	const sources = Array.isArray(root.sources) ? root.sources.map(modelRef) : [];
	if (sources.length === 0 || sources.some((source) => !source)) throw new Error("sources must be a non-empty provider/model allowlist");
	const compressorBase = modelRef(root.compressor);
	const compressorRaw = object(root.compressor);
	if (!compressorBase || !compressorRaw) throw new Error("compressor provider/model is required");
	const maxOutputTokens = compressorRaw.maxOutputTokens;
	const timeoutMs = compressorRaw.timeoutMs;
	if (!Number.isInteger(maxOutputTokens) || (maxOutputTokens as number) < 1) throw new Error("compressor.maxOutputTokens must be positive");
	if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1) throw new Error("compressor.timeoutMs must be positive");
	const routes = sources as ModelRef[];
	const keys = new Set(routes.map((route) => `${route.provider}\0${route.model}`));
	if (keys.size !== routes.length) throw new Error("sources contains duplicate routes");
	if (keys.has(`${compressorBase.provider}\0${compressorBase.model}`)) throw new Error("compressor must differ from every source");
	const minimumThinkingTokens = root.minimumThinkingTokens ?? 800;
	const minimumSavingsRatio = root.minimumSavingsRatio ?? 0.35;
	if (!Number.isInteger(minimumThinkingTokens) || (minimumThinkingTokens as number) < 1) throw new Error("minimumThinkingTokens must be positive");
	if (typeof minimumSavingsRatio !== "number" || minimumSavingsRatio < 0 || minimumSavingsRatio >= 1) throw new Error("minimumSavingsRatio must be between 0 and 1");
	return { enabled: true, sources: routes, compressor: { ...compressorBase, maxOutputTokens: maxOutputTokens as number, timeoutMs: timeoutMs as number }, minimumThinkingTokens: minimumThinkingTokens as number, minimumSavingsRatio };
}
