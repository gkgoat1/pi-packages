/**
 * Wire protocol for the env relay: framed JSON messages between a
 * `RelayedExecutionEnv` (client, e.g. in a Cloudflare Worker) and
 * `serveEnvRelay` (server, e.g. a development box wrapping a local
 * ExecutionEnv). One frame per message; transport-agnostic.
 */

/** Client → server greeting. */
export interface ClientHello {
	type: "hello";
	protocol: 1;
	/** Bearer token checked by the server when it requires one. */
	token?: string;
}

/** Server → client hello reply; `error` rejects the handshake. */
export interface ServerHello {
	type: "hello";
	protocol: 1;
	envId?: string;
	features?: { listFiles?: boolean; watch?: boolean };
	error?: string;
}

/** Client → server operation request. `args` are codec-encoded (see serialize.ts). */
export interface RelayRequest {
	type: "req";
	id: number;
	op: string;
	args: unknown[];
}

/** Client → server cancellation of one in-flight request. */
export interface RelayCancel {
	type: "cancel";
	id: number;
}

/** Server → client final answer to a request. */
export interface RelayResponse {
	type: "res";
	id: number;
	ok: boolean;
	value?: unknown;
	error?: { code: string; message: string; path?: string; spillPath?: string; kind: "file" | "exec" | "other" };
}

/** Server → client streamed exec output for one request. */
export interface RelayExecOutput {
	type: "exec-output";
	id: number;
	stream: "stdout" | "stderr";
	text: string;
}

export type ClientFrame = ClientHello | RelayRequest | RelayCancel;
export type ServerFrame = ServerHello | RelayResponse | RelayExecOutput;
export type RelayFrame = ClientFrame | ServerFrame;

export const RELAY_PROTOCOL_VERSION = 1;
