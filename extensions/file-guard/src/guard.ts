/**
 * Core guard logic: path extraction, guarded tool handling, and tool wrapping.
 */

import { Text } from "@earendil-works/pi-tui";
import { ContextEnricher, formatEnrichedSummary } from "./enrich.ts";
import { extractToolContext } from "./context.ts";
import { getBashPaths, looksLikePath } from "./bash.ts";
import { normalizePath } from "./paths.ts";
import { PromptQueue } from "./prompts.ts";
import { resultToText, buildBlockedResult, buildErrorResult, buildPendingResult, sendDeferredResult } from "./results.ts";
import { registerViewRenderer, ViewLogger } from "./view.ts";
import type { AllowedSet } from "./includes.ts";
import type { ExtensionAPI, ExtensionContext, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AnyTool, FileGuardConfig, ToolResult } from "./types.ts";

export { registerViewRenderer };
export type { ViewLogger };

export function extractToolPaths(
	toolName: string,
	params: unknown,
	cwd: string,
): { paths: string[]; reason: string } | undefined {
	const input = (params ?? {}) as Record<string, unknown>;

	if (toolName === "read" || toolName === "write" || toolName === "edit" || toolName === "grep" || toolName === "find" || toolName === "ls") {
		const rawPath = input.path;
		const paths = typeof rawPath === "string" ? [rawPath] : Array.isArray(rawPath) ? rawPath : [];
		if (paths.length > 0) return { paths, reason: `${toolName} tool` };
	}

	if (toolName === "bash") {
		const command = String(input.command ?? "");
		const analysis = getBashPaths(command);
		if (!analysis.shouldPrompt && analysis.paths.length === 0) return undefined;
		return { paths: analysis.paths, reason: analysis.reason };
	}

	// Generic path scrape for unknown tools.
	const paths: string[] = [];
	function collect(value: unknown) {
		if (typeof value === "string") {
			if (looksLikePath(value)) paths.push(value);
		} else if (Array.isArray(value)) {
			value.forEach(collect);
		} else if (value && typeof value === "object") {
			Object.values(value).forEach(collect);
		}
	}
	collect(input);
	if (paths.length > 0) return { paths: [...new Set(paths)], reason: `${toolName} tool references paths` };
	return undefined;
}

export async function handleGuardedTool(
	pi: ExtensionAPI,
	allowedSet: AllowedSet,
	promptQueue: PromptQueue,
	viewLogger: ViewLogger | undefined,
	enricher: ContextEnricher | undefined,
	config: FileGuardConfig,
	toolName: string,
	params: unknown,
	toolCallId: string,
	executeAllowed: () => Promise<ToolResult>,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	const guardInfo = extractToolPaths(toolName, params, ctx.cwd);
	const context = extractToolContext(toolName, params, ctx.cwd);

	if (!guardInfo) {
		// Not a guarded tool, but view mode still wants completion logging.
		try {
			const start = Date.now();
			const result = await executeAllowed();
			if (config.viewMode && viewLogger) {
				viewLogger.logComplete(toolName, toolCallId, params, ctx, result, Date.now() - start);
			}
			return result;
		} catch (err) {
			if (config.viewMode && viewLogger) {
				viewLogger.logGuard(toolName, toolCallId, "blocked", params, ctx, String(err));
			}
			return buildErrorResult(toolName, toolCallId, err);
		}
	}

	const nonAllowedPaths = guardInfo.paths.filter((p) => !allowedSet.isAllowed(p));
	if (nonAllowedPaths.length === 0) {
		try {
			const start = Date.now();
			const result = await executeAllowed();
			if (config.viewMode && viewLogger) {
				viewLogger.logComplete(toolName, toolCallId, params, ctx, result, Date.now() - start);
			}
			return result;
		} catch (err) {
			if (config.viewMode && viewLogger) {
				viewLogger.logGuard(toolName, toolCallId, "blocked", params, ctx, String(err));
			}
			return buildErrorResult(toolName, toolCallId, err);
		}
	}

	if (nonAllowedPaths.every((p) => allowedSet.isDenied(p))) {
		if (config.viewMode && viewLogger) {
			viewLogger.logGuard(toolName, toolCallId, "blocked", params, ctx, "previously denied");
		}
		return buildBlockedResult(toolName, toolCallId, nonAllowedPaths, "previously denied");
	}

	if (!ctx.hasUI) {
		if (config.defaultPolicy === "allow") {
			try {
				const start = Date.now();
				const result = await executeAllowed();
				if (config.viewMode && viewLogger) {
					viewLogger.logComplete(toolName, toolCallId, params, ctx, result, Date.now() - start);
				}
				return result;
			} catch (err) {
				if (config.viewMode && viewLogger) {
					viewLogger.logGuard(toolName, toolCallId, "blocked", params, ctx, String(err));
				}
				return buildErrorResult(toolName, toolCallId, err);
			}
		}
		if (config.viewMode && viewLogger) {
			viewLogger.logGuard(toolName, toolCallId, "blocked", params, ctx, "non-interactive mode");
		}
		return buildBlockedResult(toolName, toolCallId, nonAllowedPaths, "non-interactive mode");
	}

	// Enrich the guard prompt with deeper context when the user must decide.
	let contextSummary = context?.summary;
	if (enricher) {
		try {
			const enriched = await enricher.enrich(toolCallId, toolName, params);
			contextSummary = formatEnrichedSummary(enriched, contextSummary);
		} catch {
			// If enrichment fails, fall back to the simple summary.
		}
	}

	// Defer execution and result until the user resolves the permission prompt.
	promptQueue.requestCallback(
		toolName,
		`${guardInfo.reason}: ${nonAllowedPaths.join(", ")}`,
		nonAllowedPaths,
		async (approved) => {
			if (approved) {
				if (config.viewMode && viewLogger) {
					viewLogger.logGuard(toolName, toolCallId, "allowed", params, ctx);
				}
				try {
					const start = Date.now();
					const result = await executeAllowed();
					if (config.viewMode && viewLogger) {
						viewLogger.logComplete(toolName, toolCallId, params, ctx, result, Date.now() - start);
					}
					sendDeferredResult(pi, toolCallId, toolName, result, false);
				} catch (err) {
					if (config.viewMode && viewLogger) {
						viewLogger.logGuard(toolName, toolCallId, "blocked", params, ctx, String(err));
					}
					sendDeferredResult(pi, toolCallId, toolName, buildErrorResult(toolName, toolCallId, err), true);
				}
			} else {
				if (config.viewMode && viewLogger) {
					viewLogger.logGuard(toolName, toolCallId, "user-denied", params, ctx);
				}
				sendDeferredResult(
					pi,
					toolCallId,
					toolName,
					buildBlockedResult(toolName, toolCallId, nonAllowedPaths, "user denied"),
					true,
				);
			}
		},
		contextSummary,
	);

	if (config.viewMode && viewLogger) {
		viewLogger.logGuard(toolName, toolCallId, "pending", params, ctx);
	}

	return buildPendingResult(toolName, toolCallId, nonAllowedPaths);
}

export function wrapTool(
	pi: ExtensionAPI,
	allowedSet: AllowedSet | undefined,
	promptQueue: PromptQueue | undefined,
	viewLogger: ViewLogger | undefined,
	enricher: ContextEnricher | undefined,
	config: FileGuardConfig,
	localTool: AnyTool,
): AnyTool {
	const originalExecute = localTool.execute.bind(localTool);

	return {
		...localTool,
		async execute(
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: ((result: unknown) => void) | undefined,
			ctx: ExtensionContext,
		) {
			if (config.viewMode && viewLogger) {
				viewLogger.logStart(localTool.name, toolCallId, params, ctx);
			}

			if (!config.guardEnabled || !allowedSet || !promptQueue) {
				try {
					const start = Date.now();
					const result = await originalExecute(toolCallId, params, signal, onUpdate, ctx);
					if (config.viewMode && viewLogger) {
						viewLogger.logComplete(localTool.name, toolCallId, params, ctx, result, Date.now() - start);
					}
					return result;
				} catch (err) {
					if (config.viewMode && viewLogger) {
						viewLogger.logGuard(localTool.name, toolCallId, "blocked", params, ctx, String(err));
					}
					return buildErrorResult(localTool.name, toolCallId, err);
				}
			}

			return handleGuardedTool(
				pi,
				allowedSet,
				promptQueue,
				viewLogger,
				enricher,
				config,
				localTool.name,
				params,
				toolCallId,
				() => originalExecute(toolCallId, params, signal, onUpdate, ctx),
				ctx,
			);
		},
		renderResult: (
			result: ToolResult,
			options: ToolRenderResultOptions,
			theme: Theme,
			context: unknown,
		) => {
			const details = (result as ToolResult).details as { fileGuard?: string } | undefined;
			if (details?.fileGuard) {
				const text = resultToText(result as ToolResult);
				const color = details.fileGuard === "pending" ? "warning" : "error";
				return new Text(theme.fg(color, text), 0, 0);
			}
			if (localTool.renderResult) {
				return localTool.renderResult(result, options, theme, context);
			}
			return new Text(theme.fg("muted", resultToText(result as ToolResult)), 0, 0);
		},
	};
}