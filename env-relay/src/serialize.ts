/**
 * JSON codec for relay frames: Uint8Array as base64, FileError/ExecutionError
 * as tagged objects. Runtime-agnostic (atob/btoa are available in Node 22,
 * Workers, and browsers).
 */

import { err, ok, ExecutionError, FileError, type Result } from "@earendil-works/pi-durable/env";
import type { FileErrorCode, ExecutionErrorCode } from "@earendil-works/pi-durable/env";

const BINARY_TAG = "$relay.binary";

/** JSON-shaped wire value; Uint8Array crosses as `{ $relay.binary: base64 }`. */
export type WireValue = string | number | boolean | null | WireValue[] | { [key: string]: WireValue };

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Encode a value for a frame. Only plain JSON values and Uint8Array are supported. */
export function encodeValue(value: unknown): WireValue {
	if (value instanceof Uint8Array) return { [BINARY_TAG]: toBase64(value) };
	if (Array.isArray(value)) return value.map(encodeValue);
	if (value !== null && typeof value === "object") {
		const out: Record<string, WireValue> = {};
		for (const [key, item] of Object.entries(value)) out[key] = encodeValue(item);
		return out;
	}
	return value as WireValue;
}

/** A decoded wire value: JSON plus Uint8Array where the encoder tagged binary data. */
export type DecodedValue = string | number | boolean | null | Uint8Array | DecodedValue[] | { [key: string]: DecodedValue };

/** Decode a wire value; the caller knows the shape it expects. */
export function decodeValue<T>(value: unknown): T {
	return decodeUnknown(value) as T;
}

function decodeUnknown(value: unknown): DecodedValue {
	if (Array.isArray(value)) return value.map(decodeUnknown);
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record[BINARY_TAG] === "string" && Object.keys(record).length === 1) return fromBase64(record[BINARY_TAG]);
		const out: Record<string, DecodedValue> = {};
		for (const [key, item] of Object.entries(record)) out[key] = decodeUnknown(item);
		return out;
	}
	return value as DecodedValue;
}

export interface SerializedRelayError {
	code: string;
	message: string;
	path?: string;
	spillPath?: string;
	kind: "file" | "exec" | "other";
}

export function serializeError(error: unknown): SerializedRelayError {
	if (error instanceof FileError) {
		return { kind: "file", code: error.code, message: error.message, ...(error.path === undefined ? {} : { path: error.path }) };
	}
	if (error instanceof ExecutionError) {
		return {
			kind: "exec",
			code: error.code,
			message: error.message,
			...(error.spillPath === undefined ? {} : { spillPath: error.spillPath }),
		};
	}
	return { kind: "other", code: "unknown", message: error instanceof Error ? error.message : String(error) };
}

export function deserializeError(serialized: SerializedRelayError): Error {
	if (serialized.kind === "file") return new FileError(serialized.code as FileErrorCode, serialized.message, serialized.path);
	if (serialized.kind === "exec") {
		const error = new ExecutionError(serialized.code as ExecutionErrorCode, serialized.message);
		if (serialized.spillPath !== undefined) error.spillPath = serialized.spillPath;
		return error;
	}
	return new Error(serialized.message);
}

/** Wrap a server's Result return into a frame-safe value. */
export function encodeResult<T>(result: Result<T, FileError | ExecutionError>): { ok: boolean; value?: unknown; error?: SerializedRelayError } {
	if (result.ok) return { ok: true, value: encodeValue(result.value) };
	return { ok: false, error: serializeError(result.error) };
}

/** Decode a frame response back into a Result. */
export function decodeResult<T>(response: { ok: boolean; value?: unknown; error?: SerializedRelayError }): Result<T, FileError | ExecutionError> {
	if (response.ok) return ok(decodeValue(response.value) as T);
	return err(deserializeError(response.error ?? { kind: "other", code: "unknown", message: "missing error" }) as FileError | ExecutionError);
}
