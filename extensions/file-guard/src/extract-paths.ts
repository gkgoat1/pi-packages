/**
 * Pure tool-call path extraction for File Guard — no Node or Pi imports, so
 * both the pi-coding-agent extension and the pi-durable entrypoint share it.
 */

import { getBashPaths, looksLikePath } from "./bash.ts";

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
