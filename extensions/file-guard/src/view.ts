/**
 * View-mode timeline logger for File Guard.
 */

import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { ContextEnricher } from "./enrich.ts";
import { extractToolContext, resultSnippet } from "./context.ts";
import type { ToolResult, ViewEntry } from "./types.ts";

export class ViewLogger {
	constructor(
		private pi: ExtensionAPI,
		private cwd: string,
		private enricher?: ContextEnricher,
	) {}

	private append(entry: ViewEntry): void {
		try {
			this.pi.appendEntry<ViewEntry>("file-guard-view", entry);
		} catch {
			// Never break tool execution because of a view log failure.
		}
	}

	private logContext(toolName: string, toolCallId: string | undefined, params: unknown, ctx: ExtensionContext): void {
		if (!this.enricher) return;
		void this.enricher
			.enrich(toolCallId, toolName, params)
			.then((enriched) => {
				this.append({
					timestamp: Date.now(),
					toolName,
					toolCallId,
					phase: "context",
					summary: enriched.intent ?? `risk: ${enriched.risk}`,
					paths: enriched.affectedFiles,
					risk: enriched.risk,
					intent: enriched.intent,
					snippet: enriched.snippet ?? enriched.diff,
					modelEnriched: enriched.modelEnriched,
					note: enriched.notes.length > 0 ? enriched.notes.join("; ") : undefined,
				});
			})
			.catch(() => {
				// Deterministic enrichment should never throw, but ignore model errors silently.
			});
	}

	logStart(toolName: string, toolCallId: string | undefined, params: unknown, ctx: ExtensionContext): void {
		const context = extractToolContext(toolName, params, ctx.cwd);
		if (!context) return;
		this.append({
			timestamp: Date.now(),
			toolName,
			toolCallId,
			phase: "start",
			summary: context.summary,
			detail: context.detail,
			paths: context.paths,
		});
		this.logContext(toolName, toolCallId, params, ctx);
	}

	logGuard(
		toolName: string,
		toolCallId: string | undefined,
		status: "pending" | "blocked" | "allowed" | "auto-allowed" | "user-denied",
		params: unknown,
		ctx: ExtensionContext,
		note?: string,
	): void {
		const context = extractToolContext(toolName, params, ctx.cwd);
		this.append({
			timestamp: Date.now(),
			toolName,
			toolCallId,
			phase: status === "allowed" || status === "auto-allowed" ? "allowed" : status,
			summary: context?.summary ?? `${toolName} ${status}`,
			detail: context?.detail,
			paths: context?.paths,
			guardStatus: status,
			note,
		});
	}

	logComplete(
		toolName: string,
		toolCallId: string | undefined,
		params: unknown,
		ctx: ExtensionContext,
		result: ToolResult,
		durationMs?: number,
	): void {
		const context = extractToolContext(toolName, params, ctx.cwd);
		if (!context && !result) return;
		const snippet = resultSnippet(result);
		this.append({
			timestamp: Date.now(),
			toolName,
			toolCallId,
			phase: result.isError ? "error" : "complete",
			summary: context?.summary ?? `${toolName} complete`,
			detail: snippet ? `${context?.detail ?? ""}\n${snippet}`.trim() : context?.detail,
			paths: context?.paths,
			durationMs,
			isError: result.isError,
		});
	}
}

export function registerViewRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<ViewEntry>("file-guard-view", (entry, { expanded }, theme) => {
		const data = (entry as CustomEntry<ViewEntry>).data;
		if (!data) return undefined;

		const icon =
			data.phase === "start"
				? theme.fg("warning", "⏳")
				: data.phase === "blocked" || data.phase === "error"
					? theme.fg("error", "✗")
					: data.phase === "pending"
						? theme.fg("warning", "🛡")
						: theme.fg("success", "✓");

		const guardBadge = data.guardStatus ? theme.fg("warning", ` [${data.guardStatus}]`) : "";
		const header = `${icon} ${theme.fg("toolTitle", theme.bold(data.toolName))}${guardBadge} ${theme.fg("accent", data.summary)}`;

		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(header, 0, 0));

		if (expanded) {
			if (data.risk) {
				const riskColor = data.risk === "mutate" || data.risk === "write" ? "error" : data.risk === "read" ? "warning" : "dim";
				box.addChild(new Text(theme.fg(riskColor, `risk: ${data.risk}${data.modelEnriched ? " (model)" : ""}`), 0, 0));
			}
			if (data.intent) {
				box.addChild(new Text(theme.fg("accent", `intent: ${data.intent}`), 0, 0));
			}
			if (data.snippet) {
				box.addChild(new Text(theme.fg("dim", data.snippet), 0, 0));
			}
			if (data.detail) {
				box.addChild(new Text(theme.fg("dim", data.detail), 0, 0));
			}
			if (data.durationMs !== undefined) {
				box.addChild(new Text(theme.fg("dim", `took ${data.durationMs}ms`), 0, 0));
			}
			if (data.note) {
				box.addChild(new Text(theme.fg("warning", data.note), 0, 0));
			}
		}

		return box;
	});
}