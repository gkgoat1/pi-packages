/**
 * WebSocket transport adapters for the env relay. WHATWG WebSocket works in
 * Node 22+, browsers, and Cloudflare Workers (both the client side and, via
 * the Durable Object `WebSocketPair` accept side, the server side).
 */

import { RelayConnectionError, type RelayTransport } from "./transport.ts";

/** The subset of the WHATWG WebSocket used here (Cloudflare's accept side included). */
export interface WebSocketLike {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "message" | "close" | "error", listener: (event: { data?: unknown; reason?: string }) => void): void;
	readyState: number;
}

/** Wrap an already-open WebSocket (or Cloudflare's accepted server socket) as a RelayTransport. */
export function webSocketTransport(socket: WebSocketLike): RelayTransport {
	const transport: RelayTransport = {
		onMessage: undefined,
		onClose: undefined,
		send(frame: unknown) {
			if (socket.readyState !== 1) throw new RelayConnectionError("websocket is not open");
			socket.send(JSON.stringify(frame));
		},
		close() {
			socket.close(1000, "env relay done");
		},
	};
	socket.addEventListener("message", (event) => {
		if (typeof event.data !== "string") return;
		transport.onMessage?.(JSON.parse(event.data));
	});
	socket.addEventListener("close", (event) => {
		transport.onClose?.(event.reason ?? "websocket closed");
	});
	socket.addEventListener("error", () => {
		transport.onClose?.("websocket error");
	});
	return transport;
}

/** Dial out to a relay endpoint (the dev box calling the Worker, or a Node client). */
export function connectWebSocketRelay(url: string, options: { timeoutMs?: number } = {}): Promise<RelayTransport> {
	return new Promise((resolve, reject) => {
		// `WebSocket` is a global in Node 22+, browsers, and Workers.
		const socket = new WebSocket(url);
		const timer = setTimeout(() => {
			socket.close();
			reject(new RelayConnectionError(`websocket connect to ${url} timed out`));
		}, options.timeoutMs ?? 10_000);
		socket.addEventListener("open", () => {
			clearTimeout(timer);
			// SAFETY: the global WebSocket implements the full WHATWG interface, of
			// which WebSocketLike is a structural subset; the DOM lib type is not
			// visible under this tsconfig's Node-oriented libs.
			resolve(webSocketTransport(socket as unknown as WebSocketLike));
		});
		socket.addEventListener("error", () => {
			clearTimeout(timer);
			reject(new RelayConnectionError(`websocket connect to ${url} failed`));
		});
	});
}
