/**
 * FallbackExecutionEnv: run against a primary environment (usually a
 * RelayedExecutionEnv) and fail over to a secondary one when the primary is
 * unreachable, with a circuit breaker and half-open probing back.
 *
 * Namespace honesty: `id` and `cwd` are those of the ACTIVE backend, and they
 * change at failover — equal ids always see the same files, which the durable
 * edit/write serialization relies on. Hosts should surface `onSwitch` (a
 * relayed dev box and a local fallback do not share filesystem state).
 *
 * Retry policy: pure reads that fail with a RelayConnectionError are retried
 * once on the fallback. Mutating ops and exec are never replayed on the other
 * backend (they may have run remotely already); they fail over the circuit
 * for subsequent ops but return their own error.
 */

import {
	FileError,
	ExecutionError,
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	type FileInfo,
	type FileListing,
	type FileWatcher,
	type ListFilesOptions,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextLineReader,
	type WatchChange,
	type WatchTarget,
} from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord";
import { RelayConnectionError } from "./transport.ts";

export interface FallbackExecutionEnvOptions {
	primary: ExecutionEnv;
	fallback: ExecutionEnv;
	/** Consecutive connection failures before the circuit opens. Default 1. */
	failureThreshold?: number;
	/** Milliseconds before a failed primary is probed again. Default 30_000. */
	probeIntervalMs?: number;
	/** Called whenever the active backend changes. */
	onSwitch?: (active: "primary" | "fallback", reason: unknown) => void;
}

function isConnectionFailure(error: unknown): boolean {
	return error instanceof RelayConnectionError;
}

export class FallbackExecutionEnv implements ExecutionEnv {
	private readonly options: FallbackExecutionEnvOptions;
	private backend: "primary" | "fallback" = "primary";
	private failures = 0;
	private openedAt = 0;

	constructor(options: FallbackExecutionEnvOptions) {
		this.options = options;
	}

	get id(): string {
		return this.active().id;
	}

	get cwd(): string {
		return this.active().cwd;
	}

	/** Which backend currently serves operations. */
	get activeBackend(): "primary" | "fallback" {
		return this.backend;
	}

	private active(): ExecutionEnv {
		return this.backend === "primary" ? this.options.primary : this.options.fallback;
	}

	private noteFailure(error: unknown): void {
		if (!isConnectionFailure(error)) return;
		this.failures += 1;
		const threshold = this.options.failureThreshold ?? 1;
		if (this.backend === "primary" && this.failures >= threshold) {
			this.backend = "fallback";
			this.openedAt = Date.now();
			this.options.onSwitch?.("fallback", error);
		}
	}

	private noteSuccess(): void {
		this.failures = 0;
		if (this.backend === "fallback") {
			// A successful probe on the primary closes the circuit.
			this.backend = "primary";
			this.options.onSwitch?.("primary", undefined);
		}
	}

	/** Half-open: after the probe interval, try the primary for one operation. */
	private pick(): ExecutionEnv {
		if (this.backend === "fallback" && Date.now() - this.openedAt >= (this.options.probeIntervalMs ?? 30_000)) {
			return this.options.primary;
		}
		return this.active();
	}

	/** Run a pure read, retrying once on the fallback after a connection failure. */
	private async read<T>(op: (env: ExecutionEnv) => Promise<Result<T, FileError>>): Promise<Result<T, FileError>> {
		const first = this.pick();
		let result: Result<T, FileError>;
		try {
			result = await op(first);
		} catch (error) {
			this.noteFailure(error);
			if (!isConnectionFailure(error) || first !== this.options.primary) throw error;
			const second = await op(this.options.fallback);
			return second;
		}
		if (first === this.options.primary && result.ok) this.noteSuccess();
		if (!result.ok && first === this.options.primary && result.error.message.includes("relay")) {
			// Defensive: a relay surfaced a connection failure as a FileError.
			return op(this.options.fallback);
		}
		return result;
	}

	/** Run a mutating op or exec: fail over the circuit, never replay. */
	private async write<T, E extends FileError | ExecutionError>(op: (env: ExecutionEnv) => Promise<Result<T, E>>): Promise<Result<T, E>> {
		const target = this.pick();
		try {
			const result = await op(target);
			if (target === this.options.primary && result.ok) this.noteSuccess();
			return result;
		} catch (error) {
			this.noteFailure(error);
			throw error;
		}
	}

	// ── FileSystem ───────────────────────────────────────────────────────────

	absolutePath(path: string, context: Context) {
		return this.read((env) => env.absolutePath(path, context));
	}
	joinPath(parts: string[], context: Context) {
		return this.read((env) => env.joinPath(parts, context));
	}
	canonicalPath(path: string, context: Context) {
		return this.read((env) => env.canonicalPath(path, context));
	}
	readTextFile(path: string, context: Context) {
		return this.read((env) => env.readTextFile(path, context));
	}
	readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context) {
		return this.read((env) => env.readTextLines(path, options, context));
	}
	readBinaryFile(path: string, context: Context) {
		return this.read((env) => env.readBinaryFile(path, context));
	}
	fileInfo(path: string, context: Context) {
		return this.read((env) => env.fileInfo(path, context));
	}
	listDir(path: string, context: Context) {
		return this.read((env) => env.listDir(path, context));
	}
	listFiles(path: string, options: ListFilesOptions | undefined, context: Context): Promise<Result<FileListing, FileError>> {
		return this.read((env) => {
			if (typeof env.listFiles !== "function") {
				return Promise.resolve({ ok: false as const, error: new FileError("not_supported", "environment does not implement listFiles") });
			}
			return env.listFiles(path, options, context);
		});
	}
	exists(path: string, context: Context) {
		return this.read((env) => env.exists(path, context));
	}
	openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
		return this.read((env) => env.openBinaryReader(path, options, context));
	}
	openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		return this.read((env) => env.openTextLineReader(path, context));
	}
	openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		return this.read((env) => env.openDirReader(path, context));
	}
	watch(targets: readonly WatchTarget[], onChange: (change: WatchChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
		return this.read((env) => env.watch(targets, onChange, context));
	}

	writeFile(path: string, content: string | Uint8Array, context: Context) {
		return this.write((env) => env.writeFile(path, content, context));
	}
	appendFile(path: string, content: string | Uint8Array, context: Context) {
		return this.write((env) => env.appendFile(path, content, context));
	}
	truncateFile(path: string, size: number, context: Context) {
		return this.write((env) => env.truncateFile(path, size, context));
	}
	flushFile(path: string, context: Context) {
		return this.write((env) => env.flushFile(path, context));
	}
	renameFile(sourcePath: string, destinationPath: string, context: Context) {
		return this.write((env) => env.renameFile(sourcePath, destinationPath, context));
	}
	createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
		return this.write((env) => env.createDir(path, options, context));
	}
	remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) {
		return this.write((env) => env.remove(path, options, context));
	}
	createTempDir(prefix: string | undefined, context: Context) {
		return this.write((env) => env.createTempDir(prefix, context));
	}
	createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context) {
		return this.write((env) => env.createTempFile(options, context));
	}

	exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		return this.write((env) => env.exec(command, options, context));
	}

	async cleanup(context: Context): Promise<void> {
		await this.options.primary.cleanup(context).catch(() => {});
		await this.options.fallback.cleanup(context).catch(() => {});
	}
}
