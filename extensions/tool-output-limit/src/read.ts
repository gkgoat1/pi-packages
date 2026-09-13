import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolOutputLimitConfig } from "./config.ts";
import { limitsFor } from "./config.ts";

const schema = Type.Object({ path: Type.String({ description: "Path to the file to read (relative or absolute)" }), offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })), limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })) });

function isImage(buffer: Buffer): boolean {
	return (buffer[0] === 0x89 && buffer.subarray(1, 4).toString() === "PNG") || buffer.subarray(0, 3).toString() === "GIF" || (buffer[0] === 0xff && buffer[1] === 0xd8) || buffer.subarray(0, 4).toString() === "RIFF";
}

export function registerReadOverride(pi: ExtensionAPI, config: ToolOutputLimitConfig): void {
	const limits = limitsFor(config, "read");
	const native = createReadToolDefinition(process.cwd()) as any;
	pi.registerTool({
		name: "read", label: "read",
		description: "Read text files with configurable tool-output-limit byte and line caps; images retain Pi's native behavior.", parameters: schema,
		async execute(id, params, signal, update, ctx) {
			const path = params.path.startsWith("/") ? params.path : `${ctx.cwd}/${params.path}`;
			const buffer = await readFile(path);
			if (isImage(buffer)) return native.execute(id, params, signal, update, ctx);
			const lines = buffer.toString("utf8").split("\n");
			const start = Math.max(0, (params.offset ?? 1) - 1);
			const selected = lines.slice(start, params.limit === undefined ? undefined : start + params.limit);
			const maxBytes = limits.maxBytes === null ? limits.hardMaxBytes : limits.hardMaxBytes === null ? limits.maxBytes : Math.min(limits.maxBytes, limits.hardMaxBytes);
			const output: string[] = [];
			let bytes = 0;
			for (const line of selected) {
				if (limits.maxLines !== null && output.length >= limits.maxLines) break;
				const next = Buffer.byteLength(line) + (output.length ? 1 : 0);
				if (maxBytes !== null && bytes + next > maxBytes) break;
				output.push(line); bytes += next;
			}
			const truncated = output.length < selected.length;
			let text = output.join("\n");
			if (truncated) text += `\n\n[Showing lines ${start + 1}-${start + output.length} of ${lines.length}; use offset=${start + output.length + 1} to continue.]`;
			return { content: [{ type: "text" as const, text }], details: truncated ? { truncation: { truncated, totalLines: selected.length, totalBytes: Buffer.byteLength(selected.join("\n")), outputLines: output.length, outputBytes: bytes, maxLines: limits.maxLines, maxBytes } } : undefined };
		},
	});
}
