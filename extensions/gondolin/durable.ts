/**
 * Gondolin Sandbox — pi-durable entrypoint.
 *
 * The durable host runs tools against an `ExecutionEnv`; this module provides
 * `GondolinExecutionEnv`, which implements that interface against a running
 * Gondolin micro-VM (`vm.fs` + `vm.exec`). Wire it per conversation through
 * `HarnessOptions.env` (see the durable README's per-conversation environment
 * example), and install `createGondolinDurableExtension()` for the sandbox
 * prompt section.
 *
 * VM/QEMU lifecycle is the host's concern: pass an already-created `VM`.
 * The pi-coding-agent extension (index.ts) remains the interactive entrypoint.
 */

import { posix } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";
import {
	err,
	ExecutionError,
	FileError,
	LineScanner,
	ok,
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	type FileInfo,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextLineReader,
	type TextLine,
	type WatchTarget,
	type FileWatcher,
	type WatchChange,
} from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord";
import type { VM } from "@earendil-works/gondolin";
import { buildSandboxPromptAddendum } from "./src/ops.ts";
import type { GondolinConfig } from "./src/config.ts";

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Map a guest failure to the closest FileError code. */
function toFileError(error: unknown, path?: string): FileError {
	const errno = (error as { code?: unknown; errno?: unknown } | null)?.code ?? (error as { errno?: unknown } | null)?.errno;
	const message = messageOf(error);
	const text = `${errno ?? ""} ${message}`;
	let code: FileError["code"] = "unknown";
	if (/ENOENT|not found|no such file/i.test(text)) code = "not_found";
	else if (/EACCES|EPERM|EROFS|permission|read-only/i.test(text)) code = "permission_denied";
	else if (/ENOTDIR/i.test(text)) code = "not_directory";
	else if (/EISDIR/i.test(text)) code = "is_directory";
	else if (/ENOTSUP|ENOSYS|not supported/i.test(text)) code = "not_supported";
	else if (/EINVAL/i.test(text)) code = "invalid";
	else if (/aborted|AbortError/i.test(text)) code = "aborted";
	return new FileError(code, message, path);
}

async function attempt<T>(fn: () => Promise<T>, path?: string): Promise<Result<T, FileError>> {
	try {
		return ok(await fn());
	} catch (error) {
		return err(toFileError(error, path));
	}
}

function abortedError(): FileError {
	return new FileError("aborted", "operation aborted");
}

export interface GondolinExecutionEnvOptions {
	/** Environment id; defaults to `gondolin:<vm.id>`. Equal ids must see the same files. */
	id?: string;
}

export class GondolinExecutionEnv implements ExecutionEnv {
	readonly id: string;

	constructor(
		private readonly vm: VM,
		public cwd: string,
		options: GondolinExecutionEnvOptions = {},
	) {
		this.id = options.id ?? `gondolin:${vm.id}`;
	}

	private resolve(path: string): string {
		return posix.isAbsolute(path) ? posix.normalize(path) : posix.normalize(posix.join(this.cwd, path));
	}

	private signalOf(context: Context): AbortSignal | undefined {
		return context.abortSignal;
	}

	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return ok(this.resolve(path));
	}

	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		return ok(posix.join(...parts));
	}

	async canonicalPath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return ok(this.resolve(path));
	}

	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		return attempt(() => this.vm.fs.readFile(this.resolve(path), { encoding: "utf8", signal: this.signalOf(context) }), path);
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const result = await attempt(() => this.vm.fs.readFile(this.resolve(path), { encoding: null, signal: this.signalOf(context) }), path);
		if (!result.ok) return result;
		return ok(new Uint8Array(result.value.buffer, result.value.byteOffset, result.value.byteLength));
	}

	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		const result = await this.readTextFile(path, context);
		if (!result.ok) return result;
		const lines = result.value.split("\n");
		if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const result = await this.readTextFile(path, context);
		if (!result.ok) return result;
		const rawLines = result.value.split(/(?<=\n)/);
		let index = 0;
		return ok({
			readLine: async (): Promise<Result<TextLine | undefined, FileError>> => {
				if (index >= rawLines.length) return ok(undefined);
				const raw = rawLines[index++];
				const terminated = raw.endsWith("\n");
				return ok({ text: terminated ? raw.slice(0, -1) : raw, terminated });
			},
			close: async () => {},
		});
	}

	async openBinaryReader(
		path: string,
		_options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>> {
		const resolved = this.resolve(path);
		const statResult = await attempt(() => this.vm.fs.stat(resolved, { signal: this.signalOf(context) }), path);
		if (!statResult.ok) return statResult;
		if (statResult.value.isDirectory()) return err(new FileError("is_directory", `${path} is a directory`, path));
		if (!statResult.value.isFile()) return err(new FileError("invalid", `${path} is not a regular file`, path));
		const bytes = await this.readBinaryFile(path, context);
		if (!bytes.ok) return bytes;
		const info: FileInfo = {
			name: posix.basename(resolved),
			path: resolved,
			kind: "file",
			size: statResult.value.size,
			mtimeMs: statResult.value.mtimeMs,
		};
		const data = bytes.value;
		return ok({
			info: async () => ok(info),
			read: async (offset: number, length: number, readContext: Context) => {
				if (readContext.abortSignal?.aborted) return err(abortedError());
				return ok(data.subarray(offset, offset + length));
			},
			scanLines: async (scanOptions: { startLine: number; endLine?: number }, scanContext: Context) => {
				if (scanContext.abortSignal?.aborted) return err(abortedError());
				const scanner = new LineScanner(scanOptions.startLine, scanOptions.endLine);
				scanner.push(data);
				return ok(scanner.finish());
			},
			close: async () => {},
		});
	}

	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return attempt(
			() => this.vm.fs.writeFile(this.resolve(path), typeof content === "string" ? content : Buffer.from(content), { signal: this.signalOf(context) }),
			path,
		);
	}

	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const existing = await this.readBinaryFile(path, context);
		let prior: Uint8Array;
		if (existing.ok) {
			prior = existing.value;
		} else if (existing.error.code === "not_found") {
			prior = new Uint8Array(0);
		} else {
			return existing;
		}
		const addition = typeof content === "string" ? new TextEncoder().encode(content) : content;
		const combined = new Uint8Array(prior.length + addition.length);
		combined.set(prior, 0);
		combined.set(addition, prior.length);
		return this.writeFile(path, combined, context);
	}

	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		const existing = await this.readBinaryFile(path, context);
		if (!existing.ok) return existing;
		const resized = new Uint8Array(size);
		resized.set(existing.value.subarray(0, size));
		return this.writeFile(path, resized, context);
	}

	async flushFile(_path: string, _context: Context): Promise<Result<void, FileError>> {
		// Guest writes are synchronous through the sandbox server.
		return ok(undefined);
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		return attempt(() => this.vm.fs.rename(this.resolve(sourcePath), this.resolve(destinationPath), { signal: this.signalOf(context) }), sourcePath);
	}

	private fileInfoOf(resolved: string, stat: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number }): FileInfo {
		let kind: FileInfo["kind"] = "file";
		if (stat.isDirectory()) kind = "directory";
		else if (stat.isSymbolicLink()) kind = "symlink";
		else if (!stat.isFile()) kind = "file";
		return {
			name: posix.basename(resolved),
			path: resolved,
			kind,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
		};
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const resolved = this.resolve(path);
		const result = await attempt(() => this.vm.fs.stat(resolved, { signal: this.signalOf(context) }), path);
		if (!result.ok) return result;
		return ok(this.fileInfoOf(resolved, result.value));
	}

	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const resolved = this.resolve(path);
		const names = await attempt(() => this.vm.fs.listDir(resolved, { signal: this.signalOf(context) }), path);
		if (!names.ok) return names;
		const entries: FileInfo[] = [];
		for (const name of names.value) {
			const childPath = posix.join(resolved, name);
			const stat = await attempt(() => this.vm.fs.stat(childPath, { signal: this.signalOf(context) }), childPath);
			// Entries that disappear before their metadata is read are skipped.
			if (!stat.ok) continue;
			entries.push(this.fileInfoOf(childPath, stat.value));
		}
		return ok(entries);
	}

	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const listing = await this.listDir(path, context);
		if (!listing.ok) return listing;
		const entries = listing.value;
		let offset = 0;
		return ok({
			next: async (maxEntries: number, nextContext: Context) => {
				if (nextContext.abortSignal?.aborted) return err(abortedError());
				const page = entries.slice(offset, offset + maxEntries);
				offset += page.length;
				return ok({ entries: page, done: offset >= entries.length });
			},
			close: async () => {},
		});
	}

	async watch(
		_targets: readonly WatchTarget[],
		_onChange: (change: WatchChange) => void,
		_context: Context,
	): Promise<Result<FileWatcher, FileError>> {
		return err(new FileError("not_supported", "GondolinExecutionEnv does not watch files; watch the host mounts instead"));
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		try {
			await this.vm.fs.access(this.resolve(path), { signal: this.signalOf(context) });
			return ok(true);
		} catch (error) {
			const fileError = toFileError(error, path);
			if (fileError.code === "not_found" || fileError.code === "permission_denied") return ok(false);
			return err(fileError);
		}
	}

	async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		return attempt(() => this.vm.fs.mkdir(this.resolve(path), { recursive: options?.recursive ?? false, signal: this.signalOf(context) }), path);
	}

	async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		return attempt(
			() => this.vm.fs.deleteFile(this.resolve(path), { recursive: options?.recursive ?? false, force: options?.force ?? false, signal: this.signalOf(context) }),
			path,
		);
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		const path = posix.join("/tmp", `${prefix ?? "pi-gondolin-"}${crypto.randomUUID()}`);
		const result = await this.createDir(path, { recursive: true }, context);
		return result.ok ? ok(path) : result;
	}

	async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
		const path = posix.join("/tmp", `${options?.prefix ?? "pi-gondolin-"}${crypto.randomUUID()}${options?.suffix ?? ""}`);
		const result = await this.writeFile(path, new Uint8Array(0), context);
		return result.ok ? ok(path) : result;
	}

	async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const timeout = options?.timeout;
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		context.abortSignal?.addEventListener("abort", onAbort, { once: true });
		const timer = timeout === undefined ? undefined : setTimeout(() => controller.abort(), timeout);
		// Spill bookkeeping: the full combined output is buffered only until the
		// thresholds are crossed, then streamed to a guest temp file at the end.
		const spill = options?.spill;
		let buffered = "";
		let bufferedBytes = 0;
		let bufferedLines = 0;
		try {
			const proc = this.vm.exec(command as string | string[], {
				cwd: options?.cwd ?? this.cwd,
				env: options?.env,
				stdout: "pipe",
				stderr: "pipe",
				signal: controller.signal,
			});
			const reader = (async () => {
				for await (const chunk of proc.output()) {
					options?.onOutput?.(chunk.text, context, { stream: chunk.stream });
					if (spill) {
						buffered += chunk.text;
						bufferedBytes += chunk.text.length;
						bufferedLines += (chunk.text.match(/\n/g) ?? []).length;
					}
				}
			})();
			const [result] = await Promise.all([proc.result, reader]);
			let spillPath: string | undefined;
			if (spill && (bufferedBytes > spill.afterBytes || bufferedLines > spill.afterLines)) {
				const temp = await this.createTempFile({ prefix: "pi-gondolin-spill-" }, context);
				if (temp.ok) {
					const written = await this.writeFile(temp.value, buffered, context);
					if (written.ok) spillPath = temp.value;
				}
			}
			return ok({ exitCode: result.exitCode, ...(spillPath === undefined ? {} : { spillPath }) });
		} catch (error) {
			let code: "aborted" | "timeout" | "unknown" = "unknown";
			if (controller.signal.aborted) {
				code = timer !== undefined && !context.abortSignal?.aborted ? "timeout" : "aborted";
			}
			return err(new ExecutionError(code, messageOf(error), error instanceof Error ? error : undefined));
		} finally {
			if (timer) clearTimeout(timer);
			context.abortSignal?.removeEventListener("abort", onAbort);
		}
	}

	async cleanup(_context: Context): Promise<void> {
		// The host owns the VM lifecycle.
	}
}

/** The durable extension: prompt section only. The host wires `GondolinExecutionEnv` through `HarnessOptions.env`. */
export function createGondolinDurableExtension(config: GondolinConfig, localCwd: string) {
	return defineExtension({
		name: "gondolin",
		sections: [
			section("gondolin", () => {
				if (!config.enabled) return undefined;
				return buildSandboxPromptAddendum(config, localCwd).trim();
			}),
		],
	});
}

export default createGondolinDurableExtension;
