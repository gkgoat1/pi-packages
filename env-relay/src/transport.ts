/**
 * Transport abstraction for the env relay: an ordered, bidirectional channel
 * of JSON frames. Implemented over WebSocket (production) or an in-memory
 * linked pair (tests).
 */

export interface RelayTransport {
	/** Send one frame; rejects when the channel is closed. */
	send(frame: unknown): void;
	/** Called once per incoming frame, in order. */
	onMessage: ((frame: unknown) => void) | undefined;
	/** Called once when the channel ends, cleanly or not. */
	onClose: ((reason: string) => void) | undefined;
	close(): void;
}

/** A connected pair of in-memory transports, for tests and in-process relays. */
export function createLinkedTransports(): [RelayTransport, RelayTransport] {
	type End = {
		onMessage: ((frame: unknown) => void) | undefined;
		onClose: ((reason: string) => void) | undefined;
		closed: boolean;
	};
	const ends: [End, End] = [
		{ onMessage: undefined, onClose: undefined, closed: false },
		{ onMessage: undefined, onClose: undefined, closed: false },
	];
	const make = (self: 0 | 1, peer: 0 | 1): RelayTransport => {
		const mine = ends[self];
		const theirs = ends[peer];
		// onMessage/onClose live on the shared end record, so assignment through
		// either transport wrapper is visible to the peer's delivery.
		return {
			get onMessage() {
				return mine.onMessage;
			},
			set onMessage(listener) {
				mine.onMessage = listener;
			},
			get onClose() {
				return mine.onClose;
			},
			set onClose(listener) {
				mine.onClose = listener;
			},
			send(frame: unknown) {
				if (mine.closed || theirs.closed) throw new RelayConnectionError("transport is closed");
				// Deep-copy through JSON so both sides observe the wire semantics.
				const copy = JSON.parse(JSON.stringify(frame)) as unknown;
				queueMicrotask(() => theirs.onMessage?.(copy));
			},
			close() {
				if (mine.closed) return;
				mine.closed = true;
				queueMicrotask(() => theirs.onClose?.("peer closed"));
			},
		};
	};
	return [make(0, 1), make(1, 0)];
}

/** Transport-level failure; FallbackExecutionEnv keys its circuit breaker on this class. */
export class RelayConnectionError extends Error {
	/** False for handshake rejections (auth, protocol, env-id mismatch): reconnecting will not help. */
	readonly retryable: boolean;

	constructor(message: string, options?: { cause?: unknown; retryable?: boolean }) {
		super(message, options);
		this.name = "RelayConnectionError";
		this.retryable = options?.retryable ?? true;
	}
}
