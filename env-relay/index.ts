/**
 * @gkgo/pi-packages env relay — runtime-agnostic entrypoint (safe for
 * Cloudflare Workers and browsers; no Node imports).
 */

export { RELAY_PROTOCOL_VERSION } from "./src/protocol.ts";
export type {
	ClientFrame,
	ClientHello,
	RelayCancel,
	RelayExecOutput,
	RelayFrame,
	RelayRequest,
	RelayResponse,
	ServerFrame,
	ServerHello,
} from "./src/protocol.ts";
export { RelayedExecutionEnv, type RelayedExecutionEnvOptions } from "./src/relay-env.ts";
export { FallbackExecutionEnv, type FallbackExecutionEnvOptions } from "./src/fallback.ts";
export { RelayConnectionError, createLinkedTransports, type RelayTransport } from "./src/transport.ts";
export { connectWebSocketRelay, webSocketTransport, type WebSocketLike } from "./src/websocket.ts";
