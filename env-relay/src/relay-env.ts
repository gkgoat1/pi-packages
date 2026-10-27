/**
 * RelayedExecutionEnv: an ExecutionEnv whose operations are RPCs over a
 * RelayTransport to a dev box running `serveEnvRelay`. Runtime-agnostic (no
 * Node imports), so it runs in Cloudflare Workers and browsers as well as
 * Node.
 *
 * Semantics:
 * - Pure reads that fail because the connection dropped before any answer are
 *   retried once over a fresh connection. Exec and mutating operations are
 *   never retried (they may have started server-side); they reject with a
 *   RelayConnectionError, which the durable harness turns into the call's
 *   error result and FallbackExecutionEnv uses for its circuit breaker.
 * - Context cancellation sends a `cancel` frame; the local call resolves
 *   `aborted` regardless of the server's reply.
 * - File watching is not relayed (v1): `watch()` reports `not_supported`.
 */

import type { Context } from "@earendil-works/chord";
import {
	err,
	ExecutionError,
	FileError,
	ok,
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
	type TextLine,
	type TextLineReader,
	type WatchChange,
	type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { RELAY_PROTOCOL_VERSION, type ClientFrame, type RelayResponse, type ServerFrame } from "./protocol.ts";
import { decodeResult, decodeValue, encodeValue, type SerializedRelayError } from "./serialize.ts";
import { RelayConnectionError, type RelayTransport } from "./transport.ts";

export interface RelayedExecutionEnvOptions {
	/** Establish a fresh transport. Called for the first operation and every reconnect. */
	connect: () => Promise<RelayTransport>;
	/**
	 * Environment id; must equal the id the server reports in its hello, so a
	 * misdialed relay fails loudly instead of silently serving another filesystem.
	 */
	id: string;
	/** Working directory as the remote environment sees it. */
	cwd: string;
	/** Bearer token for the server's hello check. */
	token?: string;
}

interface PendingCall {
	resolve: (response: RelayResponse) => void;
	reject: (error: Error) => void;
	onExecOutput?: (stream: "stdout" | "stderr", text: string) => void;
	/** Set once any exec output arrived: the request reached the server. */
	touched: boolean;
}

interface Connection {
	transport: RelayTransport;
	nextRequestId: number;
	pending: Map<number, PendingCall>;
	/** Server-side handles held by this connection: BinaryReader/TextLineReader/DirReader ids. */
	handles: Map<number, unknown>;
	nextHandleId: number;
}

const NOT_WATCHING: Result<FileWatcher, FileError> = err(
	new FileError("not_supported", "env relay v1 does not carry file watching; watch through the server's environment directly"),
);

export class RelayedExecutionEnv implements ExecutionEnv {
	readonly id: string;
	readonly cwd: string;
	private readonly options: RelayedExecutionEnvOptions;
	private connection: Connection | undefined;
	private connecting: Promise<Connection> | undefined;

	constructor(options: RelayedExecutionEnvOptions) {
		this.options = options;
		this.id = options.id;
		this.cwd = options.cwd;
	}

	// ── Connection management ────────────────────────────────────────────────

	private async ensureConnected(): Promise<Connection> {
		if (this.connection) return this.connection;
		this.connecting ??= this.handshake().finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}

	private async handshake(): Promise<Connection> {
		const transport = await this.options.connect();
		const connection: Connection = { transport, nextRequestId: 1, pending: new Map(), handles: new Map(), nextHandleId: 1 };
		const hello = await new Promise<ServerFrame>((resolve, reject) => {
			transport.onMessage = (frame) => resolve(frame as ServerFrame);
			transport.onClose = (reason) => reject(new RelayConnectionError(`relay closed during handshake: ${reason}`));
			transport.send({
				type: "hello",
				protocol: RELAY_PROTOCOL_VERSION,
				...(this.options.token === undefined ? {} : { token: this.options.token }),
			} satisfies ClientFrame);
		});
		if (hello.type !== "hello" || hello.protocol !== RELAY_PROTOCOL_VERSION) {
			transport.close();
			throw new RelayConnectionError("relay handshake failed: unexpected reply", { retryable: false });
		}
		if (hello.error !== undefined) {
			transport.close();
			throw new RelayConnectionError(`relay handshake rejected: ${hello.error}`, { retryable: false });
		}
		if (hello.envId !== undefined && hello.envId !== this.id) {
			transport.close();
			throw new RelayConnectionError(`relay env id mismatch: expected ${this.id}, server reported ${hello.envId}`, { retryable: false });
		}
		transport.onMessage = (frame) => this.dispatch(connection, frame as ServerFrame);
		transport.onClose = (reason) => this.drop(connection, new RelayConnectionError(`relay connection closed: ${reason}`));
		this.connection = connection;
		return connection;
	}

	private dispatch(connection: Connection, frame: ServerFrame): void {
		if (frame.type === "res") {
			const pending = connection.pending.get(frame.id);
			if (!pending) return;
			connection.pending.delete(frame.id);
			pending.resolve(frame);
		} else if (frame.type === "exec-output") {
			const pending = connection.pending.get(frame.id);
			if (!pending) return;
			pending.touched = true;
			pending.onExecOutput?.(frame.stream, frame.text);
		}
	}

	private drop(connection: Connection, error: RelayConnectionError): void {
		if (this.connection === connection) this.connection = undefined;
		for (const pending of connection.pending.values()) pending.reject(error);
		connection.pending.clear();
	}

	/** One RPC. `pure` calls are retried once over a fresh connection after a pre-answer drop. */
	private async call<T, E extends FileError | ExecutionError = FileError>(
		op: string,
		args: unknown[],
		context: Context,
		options: { pure: boolean; errorKind?: "file" | "exec"; onExecOutput?: (stream: "stdout" | "stderr", text: string) => void },
	): Promise<Result<T, E>> {
		let retried = false;
		for (;;) {
			let connection: Connection;
			try {
				connection = await this.ensureConnected();
			} catch (error) {
				if (options.pure && !retried && error instanceof RelayConnectionError && error.retryable) {
					retried = true;
					continue;
				}
				throw error;
			}
			const id = connection.nextRequestId++;
			const response = await new Promise<RelayResponse>((resolve, reject) => {
				const pending: PendingCall = { resolve, reject, touched: false, ...(options.onExecOutput ? { onExecOutput: options.onExecOutput } : {}) };
				connection.pending.set(id, pending);
				const onAbort = () => {
					connection.pending.delete(id);
					try {
						connection.transport.send({ type: "cancel", id } satisfies ClientFrame);
					} catch {
						// The cancel is best-effort; the local call is already done.
					}
					// Aborts resolve an `aborted` Result on the op's error channel, per the ExecutionEnv contract.
					const errorKind = options.errorKind ?? "file";
					resolve({
						type: "res",
						id,
						ok: false,
						error: { kind: errorKind, code: "aborted", message: "operation aborted" },
					});
				};
				if (context.abortSignal?.aborted) {
					onAbort();
					return;
				}
				context.abortSignal?.addEventListener("abort", onAbort, { once: true });
				try {
					connection.transport.send({ type: "req", id, op, args: args.map(encodeValue) } satisfies ClientFrame);
				} catch (error) {
					connection.pending.delete(id);
					reject(error instanceof Error ? error : new RelayConnectionError(String(error)));
				}
				const cleanup = () => context.abortSignal?.removeEventListener("abort", onAbort);
				const wrappedResolve = pending.resolve;
				pending.resolve = (value) => {
					cleanup();
					wrappedResolve(value);
				};
				const wrappedReject = pending.reject;
				pending.reject = (error) => {
					cleanup();
					wrappedReject(error);
				};
			}).catch((error: unknown): RelayResponse | undefined => {
				if (options.pure && !retried && error instanceof RelayConnectionError) return undefined;
				throw error;
			});
			if (response === undefined) {
				retried = true;
				continue;
			}
			// SAFETY: the server tags errors by kind and each op only produces its
			// declared channel (FileError for fs ops, ExecutionError for exec).
			return decodeResult<T>(response) as Result<T, E>;
		}
	}

	// ── FileSystem ───────────────────────────────────────────────────────────

	absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.call("absolutePath", [path], context, { pure: true });
	}

	joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
		return this.call("joinPath", [parts], context, { pure: true });
	}

	canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.call("canonicalPath", [path], context, { pure: true });
	}

	readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.call("readTextFile", [path], context, { pure: true });
	}

	readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		return this.call("readTextLines", [path, options], context, { pure: true });
	}

	readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		return this.call("readBinaryFile", [path], context, { pure: true });
	}

	writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.call("writeFile", [path, content], context, { pure: false });
	}

	appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.call("appendFile", [path, content], context, { pure: false });
	}

	truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		return this.call("truncateFile", [path, size], context, { pure: false });
	}

	flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		return this.call("flushFile", [path], context, { pure: false });
	}

	renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		return this.call("renameFile", [sourcePath, destinationPath], context, { pure: false });
	}

	fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		return this.call("fileInfo", [path], context, { pure: true });
	}

	listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		return this.call("listDir", [path], context, { pure: true });
	}

	async listFiles(
		path: string,
		options: ListFilesOptions | undefined,
		context: Context,
	): Promise<Result<FileListing, FileError>> {
		return this.call("listFiles", [path, options], context, { pure: true });
	}

	exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		return this.call("exists", [path], context, { pure: true });
	}

	createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		return this.call("createDir", [path, options], context, { pure: false });
	}

	remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		return this.call("remove", [path, options], context, { pure: false });
	}

	createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		return this.call("createTempDir", [prefix], context, { pure: false });
	}

	createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
		return this.call("createTempFile", [options], context, { pure: false });
	}

	watch(_targets: readonly WatchTarget[], _onChange: (change: WatchChange) => void, _context: Context): Promise<Result<FileWatcher, FileError>> {
		return Promise.resolve(NOT_WATCHING);
	}

	// ── Handle-based readers ─────────────────────────────────────────────────

	private async openHandle(op: string, args: unknown[], context: Context): Promise<Result<{ handle: number }, FileError>> {
		return this.call(op, args, context, { pure: false });
	}

	private remoteReader<TApi extends object>(
		handleResult: Result<{ handle: number }, FileError>,
		methods: (handle: number) => TApi,
		closeOp: string,
		context: Context,
	): Result<TApi & { close(context: Context): Promise<void> }, FileError> {
		if (!handleResult.ok) return handleResult;
		const handle = handleResult.value.handle;
		const api = methods(handle);
		return ok({
			...api,
			close: async (closeContext: Context) => {
				await this.call(closeOp, [handle], closeContext ?? context, { pure: true });
			},
		});
	}

	async openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>> {
		const handle = await this.openHandle("openBinaryReader", [path, options], context);
		return this.remoteReader(
			handle,
			(h) => ({
				info: (ctx: Context) => this.call<FileInfo, FileError>("binaryReader.info", [h], ctx, { pure: true }),
				read: (offset: number, length: number, ctx: Context) =>
					this.call<Uint8Array, FileError>("binaryReader.read", [h, offset, length], ctx, { pure: true }),
				scanLines: (scanOptions: { startLine: number; endLine?: number }, ctx: Context) =>
					this.call("binaryReader.scanLines", [h, scanOptions], ctx, { pure: true }),
			}),
			"binaryReader.close",
			context,
		);
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const handle = await this.openHandle("openTextLineReader", [path], context);
		return this.remoteReader(
			handle,
			(h) => ({
				readLine: (ctx: Context) => this.call<TextLine | undefined, FileError>("textLineReader.readLine", [h], ctx, { pure: true }),
			}),
			"textLineReader.close",
			context,
		);
	}

	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const handle = await this.openHandle("openDirReader", [path], context);
		return this.remoteReader(
			handle,
			(h) => ({
				next: (maxEntries: number, ctx: Context) =>
					this.call<{ entries: FileInfo[]; done: boolean }, FileError>("dirReader.next", [h, maxEntries], ctx, { pure: true }),
			}),
			"dirReader.close",
			context,
		);
	}

	// ── Shell ────────────────────────────────────────────────────────────────

	async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const wireOptions = options === undefined ? undefined : { ...options, onOutput: undefined };
		const result = await this.call<ShellExecResult, ExecutionError>(
			"exec",
			[typeof command === "string" ? command : [...command], wireOptions],
			context,
			{
				pure: false,
				errorKind: "exec",
				...(options?.onOutput
					? {
							onExecOutput: (stream: "stdout" | "stderr", text: string) => {
								options.onOutput?.(text, context, { stream });
							},
						}
					: {}),
			},
		);
		return result;
	}

	async cleanup(context: Context): Promise<void> {
		const connection = this.connection;
		if (!connection) return;
		this.connection = undefined;
		try {
			await this.call("cleanup", [], context, { pure: false });
		} catch {
			// Closing anyway.
		}
		connection.transport.close();
	}
}

export { RelayConnectionError, type SerializedRelayError, decodeValue };
