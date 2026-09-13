import { createWriteStream } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Limit } from "./config.ts";

export interface OutputLimits {
	maxBytes: Limit;
	maxLines: Limit;
	hardMaxBytes: Limit;
}

export interface Truncation {
	truncated: boolean;
	truncatedBy: "bytes" | "lines" | null;
	totalBytes: number;
	totalLines: number;
	outputBytes: number;
	outputLines: number;
	maxBytes: Limit;
	maxLines: Limit;
}

export interface OutputSnapshot {
	content: string;
	truncation: Truncation;
	fullOutputPath?: string;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function effectiveByteLimit(limits: OutputLimits): Limit {
	if (limits.maxBytes === null) return limits.hardMaxBytes;
	if (limits.hardMaxBytes === null) return limits.maxBytes;
	return Math.min(limits.maxBytes, limits.hardMaxBytes);
}

function takeTail(text: string, maxBytes: number): string {
	const data = Buffer.from(text, "utf8");
	if (data.length <= maxBytes) return text;
	let start = data.length - maxBytes;
	while (start < data.length && (data[start] & 0xc0) === 0x80) start++;
	return data.subarray(start).toString("utf8");
}

/** Streams raw bytes to a private file while retaining only a bounded decoded tail. */
export class StreamingOutput {
	private readonly decoder = new TextDecoder();
	private readonly stream: ReturnType<typeof createWriteStream>;
	private tail = "";
	private totalBytes = 0;
	private totalLines = 0;
	private hasOpenLine = false;
	private closed = false;

	private constructor(private readonly directory: string, private readonly limits: OutputLimits) {
		this.stream = createWriteStream(join(directory, "output.log"), { mode: 0o600 });
	}

	static async create(limits: OutputLimits, parent?: string | null): Promise<StreamingOutput> {
		const directory = await mkdtemp(join(parent ?? tmpdir(), "pi-tool-output-"));
		await chmod(directory, 0o700);
		return new StreamingOutput(directory, limits);
	}

	get fullOutputPath(): string {
		return join(this.directory, "output.log");
	}

	append(chunk: Buffer | string): void {
		if (this.closed) throw new Error("Cannot append after output is closed");
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		this.stream.write(bytes);
		const text = this.decoder.decode(bytes, { stream: true });
		this.consume(text);
	}

	private consume(text: string): void {
		if (!text) return;
		this.totalBytes += byteLength(text);
		let start = 0;
		for (;;) {
			const newline = text.indexOf("\n", start);
			if (newline === -1) break;
			this.totalLines++;
			this.hasOpenLine = false;
			start = newline + 1;
		}
		if (start < text.length) this.hasOpenLine = true;
		this.tail += text;
		const byteLimit = effectiveByteLimit(this.limits) ?? 64 * 1024 * 1024;
		// Retain a little extra so a byte cap can end on a UTF-8 boundary.
		this.tail = takeTail(this.tail, Math.max(byteLimit * 2, 1024));
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.consume(this.decoder.decode());
		await new Promise<void>((resolve, reject) => {
			this.stream.once("error", reject);
			this.stream.once("finish", resolve);
			this.stream.end();
		});
	}

	snapshot(): OutputSnapshot {
		const maxBytes = effectiveByteLimit(this.limits);
		const maxLines = this.limits.maxLines;
		const lines = this.tail.endsWith("\n") ? this.tail.slice(0, -1).split("\n") : this.tail.split("\n");
		let selected: string[] = [];
		let bytes = 0;
		let truncatedBy: Truncation["truncatedBy"] = null;
		for (let index = lines.length - 1; index >= 0; index--) {
			if (maxLines !== null && selected.length >= maxLines) {
				truncatedBy ??= "lines";
				break;
			}
			const candidate = lines[index];
			const candidateBytes = byteLength(candidate) + (selected.length ? 1 : 0);
			if (maxBytes !== null && bytes + candidateBytes > maxBytes) {
				truncatedBy ??= "bytes";
				if (selected.length === 0) selected = [takeTail(candidate, maxBytes)];
				break;
			}
			selected.unshift(candidate);
			bytes += candidateBytes;
		}
		const content = selected.join("\n");
		const totalLines = this.totalLines + (this.hasOpenLine ? 1 : 0);
		const truncated = (maxBytes !== null && this.totalBytes > maxBytes) || (maxLines !== null && totalLines > maxLines);
		if (truncated && truncatedBy === null) truncatedBy = maxBytes !== null && this.totalBytes > maxBytes ? "bytes" : "lines";
		return {
			content,
			truncation: {
				truncated,
				truncatedBy,
				totalBytes: this.totalBytes,
				totalLines,
				outputBytes: byteLength(content),
				outputLines: content === "" ? 0 : content.split("\n").length,
				maxBytes,
				maxLines,
			},
			fullOutputPath: this.fullOutputPath,
		};
	}

	async remove(): Promise<void> {
		await rm(this.directory, { recursive: true, force: true });
	}
}
