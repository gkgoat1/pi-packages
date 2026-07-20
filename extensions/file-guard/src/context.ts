/**
 * Tool context extraction for view mode and richer guard prompts.
 */

import * as fs from "node:fs";
import { getBashPaths } from "./bash.ts";
import { normalizePath, shortenPath } from "./paths.ts";
import type { ToolContext, ToolResult } from "./types.ts";

export function extractToolContext(toolName: string, params: unknown, cwd: string): ToolContext | undefined {
	const input = (params ?? {}) as Record<string, unknown>;
	const rawPath = input.path;
	const paths =
		typeof rawPath === "string"
			? [rawPath]
			: Array.isArray(rawPath)
				? rawPath.filter((p): p is string => typeof p === "string")
				: [];

	switch (toolName) {
		case "read": {
			const filePath = String(input.path ?? "");
			const offset = input.offset as number | undefined;
			const limit = input.limit as number | undefined;
			const range =
				offset !== undefined || limit !== undefined
					? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}`
					: "";
			const short = filePath ? shortenPath(normalizePath(filePath, cwd), cwd) : "...";
			return {
				toolName,
				paths: filePath ? [filePath] : [],
				summary: `read ${short}${range}`,
				detail: filePath ? `Reading ${filePath}${range || ""}` : "Reading file",
			};
		}
		case "write": {
			const filePath = String(input.path ?? "");
			const content = String(input.content ?? "");
			const lines = content.split("\n").length;
			const short = filePath ? shortenPath(normalizePath(filePath, cwd), cwd) : "...";
			const changed = filePath
				? (() => {
						try {
							const before = fs.statSync(normalizePath(filePath, cwd));
							return before.isFile() ? " (overwrite)" : "";
						} catch {
							return " (new file)";
						}
				  })()
				: "";
			return {
				toolName,
				paths: filePath ? [filePath] : [],
				summary: `write ${short} (${lines} lines${changed ? `, ${changed.trim()}` : ""})`,
				detail: filePath
					? `Writing ${lines} lines to ${filePath}${changed ? ` ${changed.trim()}` : ""}`
					: "Writing file",
			};
		}
		case "edit": {
			const filePath = String(input.path ?? "");
			const edits = Array.isArray(input.edits) ? input.edits : [];
			const short = filePath ? shortenPath(normalizePath(filePath, cwd), cwd) : "...";
			return {
				toolName,
				paths: filePath ? [filePath] : [],
				summary: `edit ${short} (${edits.length} change${edits.length === 1 ? "" : "s"})`,
				detail: filePath
					? `Editing ${filePath} with ${edits.length} change${edits.length === 1 ? "" : "s"}`
					: "Editing file",
			};
		}
		case "ls": {
			const filePath = String(input.path ?? ".");
			const short = shortenPath(normalizePath(filePath, cwd), cwd);
			return {
				toolName,
				paths: [filePath],
				summary: `ls ${short}`,
				detail: `Listing ${filePath}`,
			};
		}
		case "find": {
			const pattern = String(input.pattern ?? "*");
			const filePath = String(input.path ?? ".");
			return {
				toolName,
				paths: [filePath],
				summary: `find ${pattern} in ${shortenPath(normalizePath(filePath, cwd), cwd)}`,
				detail: `Find "${pattern}" in ${filePath}`,
			};
		}
		case "grep": {
			const pattern = String(input.pattern ?? "");
			const filePath = String(input.path ?? ".");
			const short = shortenPath(normalizePath(filePath, cwd), cwd);
			return {
				toolName,
				paths: [filePath],
				summary: `grep /${pattern}/ in ${short}`,
				detail: `Grep "${pattern}" in ${filePath}`,
			};
		}
		case "bash": {
			const command = String(input.command ?? "");
			const analysis = getBashPaths(command);
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return {
				toolName,
				paths: analysis.paths,
				summary: `bash ${preview}`,
				detail: `$ ${command}`,
			};
		}
		default: {
			if (paths.length > 0) {
				const short = shortenPath(normalizePath(paths[0], cwd), cwd);
				return {
					toolName,
					paths,
					summary: `${toolName} ${short}`,
					detail: `${toolName} referencing ${paths.join(", ")}`,
				};
			}
			return undefined;
		}
	}
}

export function resultSnippet(result: ToolResult, maxLen = 120): string {
	if (!result) return "";
	let text = "";
	for (const block of result.content) {
		if (
			block &&
			typeof block === "object" &&
			"type" in block &&
			block.type === "text" &&
			typeof block.text === "string"
		) {
			text += block.text;
			if (text.length >= maxLen) break;
		}
	}
	text = text.replace(/\s+/g, " ").trim();
	if (text.length > maxLen) return `${text.slice(0, maxLen)}…`;
	return text;
}