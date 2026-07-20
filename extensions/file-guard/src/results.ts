/**
 * Tool result building helpers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolResult } from "./types.ts";

export function resultToText(result: ToolResult): string {
	return result.content
		.map((block) => {
			if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
				return block.text;
			}
			return "";
		})
		.join("\n");
}

export function buildPendingResult(toolName: string, toolCallId: string, paths: string[]): ToolResult {
	return {
		content: [
			{
				type: "text",
				text: `[File Guard pending] ${toolName} on ${paths.join(", ")} is awaiting approval (tool call ${toolCallId}).`,
			},
		],
		details: { fileGuard: "pending", toolCallId, paths },
	};
}

export function buildBlockedResult(toolName: string, toolCallId: string, paths: string[], reason: string): ToolResult {
	return {
		content: [
			{
				type: "text",
				text: `[File Guard blocked] ${toolName} on ${paths.join(", ")}: ${reason} (tool call ${toolCallId}).`,
			},
		],
		details: { fileGuard: "blocked", toolCallId, paths, reason },
		isError: true,
	};
}

export function buildErrorResult(toolName: string, toolCallId: string, error: unknown): ToolResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: [{ type: "text", text: `[File Guard error] ${toolName}: ${message} (tool call ${toolCallId}).` }],
		details: { fileGuard: "error", toolCallId, error: message },
		isError: true,
	};
}

export function sendDeferredResult(
	pi: ExtensionAPI,
	toolCallId: string,
	toolName: string,
	result: ToolResult,
	blocked: boolean,
): void {
	const text = resultToText(result);
	const header = blocked
		? `[File Guard blocked tool call ${toolCallId} (${toolName})]`
		: `[File Guard result for tool call ${toolCallId} (${toolName})]`;
	const message = `${header}\n${text}`;
	try {
		pi.sendUserMessage(message, { deliverAs: "steer" });
	} catch {
		// Fallback if steer is not valid in current state.
		pi.sendUserMessage(message);
	}
}