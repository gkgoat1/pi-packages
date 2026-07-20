/**
 * Shared types for the File Guard extension.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = any;

export type Mode = "guard" | "view";

export type ModelRef = { provider: string; id: string };

export type ModelIncludeMap = Record<string, string[]>;

export interface LoadedSources {
	global: string[];
	project: string[];
	modelKey?: string;
	globalOverride: boolean;
	projectOverride: boolean;
}

export interface FileGuardConfig {
	/**
	 * Master guard toggle. Retained for backwards compatibility; equivalent to
	 * `guardEnabled` when `guardEnabled` is not explicitly set.
	 */
	enabled: boolean;
	/** Guard mode: prompt/allow/deny access outside `.piinclude`. */
	guardEnabled: boolean;
	/** View mode: log critical tool moments in the timeline. */
	viewMode: boolean;
	/** Global include files (default: ~/.piinclude). */
	globalIncludeFiles: string[];
	/** Model-specific global include files keyed by provider/modelId. */
	globalModelIncludeFiles: ModelIncludeMap;
	/** Project include files relative to cwd (default: .piinclude). */
	projectIncludeFiles: string[];
	/** Model-specific project include files keyed by provider/modelId. */
	projectModelIncludeFiles: ModelIncludeMap;
	/**
	 * What to do when there is no UI available and no previous decision.
	 * - "prompt" resolves to "deny" in non-interactive mode.
	 * - "allow" skips the guard entirely.
	 * - "deny" blocks everything.
	 */
	defaultPolicy: "prompt" | "allow" | "deny";
	/**
	 * When true, monkey-patch `pi.registerTool()` so every tool (including tools
	 * registered by other extensions after File Guard loads) is wrapped with the
	 * async permission gate and/or view logger. This avoids synchronous blocking
	 * for static, non-built-in tools that reference files.
	 */
	wrapAllTools: boolean;
	/** Optional deterministic + LLM enrichment for view mode and guard prompts. */
	viewEnrichment?: ViewEnrichmentConfig;
}

export interface ViewEnrichmentConfig {
	/** When true, gather extra context for each guarded/viewed operation. */
	enabled: boolean;
	/** When true, also query a lightweight model for an intent/risk summary. */
	useModel: boolean;
	/** Optional explicit model to use for enrichment (defaults to the active session model). */
	model?: Partial<ModelRef>;
	/** Maximum number of content characters to feed the enrichment model. */
	maxContextLength: number;
	/** Hard timeout for the model enrichment call. */
	timeoutMs: number;
	/**
	 * Path patterns considered high-risk (e.g. secrets, auth, deployment configs).
	 * Supports simple glob fragments matched against the basename and absolute path.
	 */
	riskPatterns?: string[];
}

export interface GuardRequest {
	id: string;
	toolName: string;
	description: string;
	contextSummary?: string;
	paths: string[];
	resolve: (allowed: boolean) => void;
}

export interface PersistedState {
	allowedPaths: string[];
	deniedPaths: string[];
}

export type ToolResult = {
	content: Array<{ type: "text"; text: string } | Record<string, unknown>>;
	details?: unknown;
	isError?: boolean;
};

export type RiskLevel = "safe" | "read" | "write" | "mutate" | "unknown";

export interface EnrichedContext {
	/** One-word risk classification for the operation. */
	risk: RiskLevel;
	/** Human-readable reason(s) for the risk classification. */
	notes: string[];
	/** A short, one-line description of what the operation does. */
	intent?: string;
	/** A content snippet or result preview. */
	snippet?: string;
	/** A brief diff / before-after preview for edits and overwrites. */
	diff?: string;
	/** Files or directories the operation touches. */
	affectedFiles: string[];
	/** True when the values came from a model call. */
	modelEnriched: boolean;
}

export interface ToolContext {
	toolName: string;
	paths: string[];
	summary: string;
	detail: string;
}

export interface ViewEntry {
	timestamp: number;
	toolName: string;
	toolCallId?: string;
	phase: "start" | "blocked" | "allowed" | "complete" | "error" | "pending" | "context" | "user-denied";
	summary: string;
	detail?: string;
	paths?: string[];
	durationMs?: number;
	guardStatus?: "pending" | "blocked" | "allowed" | "auto-allowed" | "user-denied";
	isError?: boolean;
	note?: string;
	risk?: RiskLevel;
	intent?: string;
	snippet?: string;
	modelEnriched?: boolean;
}