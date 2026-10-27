/**
 * Server side of the env relay: expose one `ExecutionEnv` (NodeExecutionEnv,
 * pi-env's LocalExecutionEnv, GondolinExecutionEnv, …) over a RelayTransport.
 * The dev box typically dials OUT to a Cloudflare Worker's WebSocket endpoint,
 * so no inbound connectivity is needed.
 *
 * Security: optional bearer token, optional root jail (paths must resolve
 * under `root`), optional read-only mode (no writes, no exec).
 */

import { BACKGROUND_CONTEXT, withCancel, type Context } from "@earendil-works/chord/context";
import {
	err,
	ok,
	FileError,
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	type Result,
	type ShellExecOptions,
	type TextLineReader,
} from "@earendil-works/pi-durable/env";
import { RELAY_PROTOCOL_VERSION, type ClientFrame, type RelayRequest, type ServerFrame } from "./protocol.ts";
import { encodeResult, serializeError } from "./serialize.ts";
import type { RelayTransport } from "./transport.ts";

export interface ServeEnvRelayOptions {
	/** When set, the client hello must carry this token. */
	token?: string;
	/** Jail: every path an op touches must resolve to `root` or below it. */
	root?: string;
	/** Reject write/exec ops. Default false. */
	readOnly?: boolean;
}

type Reader = BinaryReader | TextLineReader | DirReader;

const WRITE_OPS = new Set(["writeFile", "appendFile", "truncateFile", "renameFile", "createDir", "remove", "createTempDir", "createTempFile"]);
/** Ops whose first argument is a path (checked against the jail). */
const PATH_OPS = new Set([
	"absolutePath", "canonicalPath", "readTextFile", "readTextLines", "readBinaryFile", "writeFile", "appendFile",
	"truncateFile", "flushFile", "renameFile", "fileInfo", "listDir", "listFiles", "exists", "createDir", "remove",
	"openBinaryReader", "openTextLineReader", "openDirReader",
]);

export function serveEnvRelay(env: ExecutionEnv, transport: RelayTransport, options: ServeEnvRelayOptions = {}): void {
	let handshaken = false;
	const readers = new Map<number, Reader>();
	let nextHandle = 1;
	const inFlight = new Map<number, { cancel: (reason?: unknown) => void }>();

	const send = (frame: ServerFrame) => transport.send(frame);
	const respond = (id: number, result: Result<unknown, FileError>) => {
		const encoded = encodeResult(result);
		send({ type: "res", id, ok: encoded.ok, value: encoded.value, error: encoded.error });
	};
	const fail = (id: number, error: unknown) => {
		send({ type: "res", id, ok: false, error: serializeError(error) });
	};

	const jailCheck = async (path: unknown, context: Context): Promise<FileError | undefined> => {
		if (options.root === undefined || typeof path !== "string") return undefined;
		const resolved = await env.absolutePath(path, context);
		if (!resolved.ok) return resolved.error;
		const root = options.root.replace(/\/+$/, "");
		if (resolved.value !== root && !resolved.value.startsWith(`${root}/`)) {
			return new FileError("permission_denied", `path escapes the relay root ${root}`, path);
		}
		return undefined;
	};

	const callContext = (request: RelayRequest): Context => {
		const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
		inFlight.set(request.id, { cancel });
		return context;
	};

	const dispatch = async (request: RelayRequest): Promise<void> => {
		const { id, op, args } = request;
		try {
			if (options.readOnly && (WRITE_OPS.has(op) || op === "exec")) {
				fail(id, new FileError("permission_denied", `relay is read-only: ${op}`));
				return;
			}
			if (PATH_OPS.has(op)) {
				const violation = await jailCheck(args[0], BACKGROUND_CONTEXT);
				if (violation) {
					respond(id, err(violation));
					return;
				}
			}
			const context = callContext(request);
			try {
				await run(request, context);
			} finally {
				inFlight.delete(id);
			}
		} catch (error) {
			fail(id, error);
		}
	};

	const run = async (request: RelayRequest, context: Context): Promise<void> => {
		const { id, op, args } = request;
		switch (op) {
			case "exec": {
				const [command, execOptions] = args as [string | string[], (Omit<ShellExecOptions, "onOutput"> & { onOutput?: undefined }) | undefined];
				const result = await env.exec(command, {
					...execOptions,
					onOutput: (text, _ctx, info) => {
						send({ type: "exec-output", id, stream: info.stream, text });
					},
				}, context);
				respond(id, result as Result<unknown, FileError>);
				return;
			}
			case "openBinaryReader":
			case "openTextLineReader":
			case "openDirReader": {
				const opened = (await (env[op] as (...a: unknown[]) => Promise<Result<Reader, FileError>>)(...(args as [string, ...unknown[]]), context)) as Result<Reader, FileError>;
				if (!opened.ok) {
					respond(id, opened);
					return;
				}
				const handle = nextHandle++;
				readers.set(handle, opened.value);
				respond(id, { ok: true, value: { handle } } as Result<unknown, FileError>);
				return;
			}
			case "cleanup": {
				for (const reader of readers.values()) await reader.close(context).catch(() => {});
				readers.clear();
				respond(id, { ok: true, value: undefined } as Result<unknown, FileError>);
				return;
			}
			default:
				break;
		}
		// Reader method ops: "binaryReader.read" etc., args[0] is the handle.
		const readerMatch = /^(binaryReader|textLineReader|dirReader)\.(\w+)$/.exec(op);
		if (readerMatch) {
			const reader = readers.get(args[0] as number);
			if (!reader) {
				fail(id, new FileError("invalid", `unknown reader handle ${String(args[0])}`));
				return;
			}
			if (readerMatch[2] === "close") {
				readers.delete(args[0] as number);
				await reader.close(context);
				respond(id, ok(undefined));
				return;
			}
			// Reader method tables; each method takes the wire args then the context.
			let result: Result<unknown, FileError>;
			if (readerMatch[1] === "binaryReader" && "read" in reader) {
				const binary = reader;
				if (readerMatch[2] === "info") result = await binary.info(context);
				else if (readerMatch[2] === "read") result = await binary.read(args[1] as number, args[2] as number, context);
				else result = await binary.scanLines(args[1] as { startLine: number; endLine?: number }, context);
			} else if (readerMatch[1] === "textLineReader" && "readLine" in reader) {
				result = await reader.readLine(context);
			} else if (readerMatch[1] === "dirReader" && "next" in reader) {
				result = await reader.next(args[1] as number, context);
			} else {
				fail(id, new Error(`unknown reader op: ${op}`));
				return;
			}
			respond(id, result);
			return;
		}
		// Plain pass-through ops on the env, with the context appended.
		const method = OPS[op];
		if (method === undefined) {
			fail(id, new Error(`unknown relay op: ${op}`));
			return;
		}
		respond(id, await method(env, args, context));
	};

type OpFn = (env: ExecutionEnv, args: unknown[], context: Context) => Promise<Result<unknown, FileError>>;

/** Explicit op table: every relayable ExecutionEnv method except exec and the handle openers. */
const OPS: Record<string, OpFn> = {
	absolutePath: (e, [p], c) => e.absolutePath(p as string, c),
		joinPath: (e, [parts], c) => e.joinPath(parts as string[], c),
		canonicalPath: (e, [p], c) => e.canonicalPath(p as string, c),
		readTextFile: (e, [p], c) => e.readTextFile(p as string, c),
		readTextLines: (e, [p, o], c) => e.readTextLines(p as string, o as { maxLines?: number } | undefined, c),
		readBinaryFile: (e, [p], c) => e.readBinaryFile(p as string, c),
		writeFile: (e, [p, content], c) => e.writeFile(p as string, content as string | Uint8Array, c),
		appendFile: (e, [p, content], c) => e.appendFile(p as string, content as string | Uint8Array, c),
		truncateFile: (e, [p, size], c) => e.truncateFile(p as string, size as number, c),
		flushFile: (e, [p], c) => e.flushFile(p as string, c),
		renameFile: (e, [from, to], c) => e.renameFile(from as string, to as string, c),
		fileInfo: (e, [p], c) => e.fileInfo(p as string, c),
		listDir: (e, [p], c) => e.listDir(p as string, c),
		exists: (e, [p], c) => e.exists(p as string, c),
		createDir: (e, [p, o], c) => e.createDir(p as string, o as { recursive?: boolean } | undefined, c),
		remove: (e, [p, o], c) => e.remove(p as string, o as { recursive?: boolean; force?: boolean } | undefined, c),
		createTempDir: (e, [prefix], c) => e.createTempDir(prefix as string | undefined, c),
		createTempFile: (e, [o], c) => e.createTempFile(o as { prefix?: string; suffix?: string } | undefined, c),
		listFiles: async (e, [p, o], c) => {
			if (typeof e.listFiles !== "function") return err(new FileError("not_supported", "the server environment does not implement listFiles"));
			return e.listFiles(p as string, o as never, c);
		},
	};

	transport.onMessage = (raw) => {
		const frame = raw as ClientFrame;
		if (frame.type === "hello") {
			if (frame.protocol !== RELAY_PROTOCOL_VERSION) {
				send({ type: "hello", protocol: RELAY_PROTOCOL_VERSION, error: `unsupported protocol ${String(frame.protocol)}` });
				return;
			}
			if (options.token !== undefined && frame.token !== options.token) {
				send({ type: "hello", protocol: RELAY_PROTOCOL_VERSION, error: "unauthorized" });
				return;
			}
			handshaken = true;
			send({
				type: "hello",
				protocol: RELAY_PROTOCOL_VERSION,
				envId: env.id,
				features: { listFiles: typeof env.listFiles === "function", watch: false },
			});
			return;
		}
		if (!handshaken) return;
		if (frame.type === "cancel") {
			inFlight.get(frame.id)?.cancel(new FileError("aborted", "cancelled by the relay client"));
			return;
		}
		if (frame.type === "req") void dispatch(frame);
	};

	transport.onClose = () => {
		handshaken = false;
		for (const pending of inFlight.values()) pending.cancel(new FileError("aborted", "relay connection closed"));
		inFlight.clear();
		readers.clear();
	};
}
