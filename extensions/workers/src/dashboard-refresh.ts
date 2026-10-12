/**
 * Bounded refresh driver for the workers dashboard. Ticks derive fresh data
 * and apply it to the component; a tick in flight coalesces further ticks,
 * stop() is idempotent, and an apply/derive failure is reported and retried
 * on the next tick instead of killing the loop.
 */

export interface RefreshDriverDeps<T> {
	derive: () => Promise<T>;
	apply: (data: T) => void;
	onError: (error: Error) => void;
	intervalMs: number;
}

export interface RefreshDriver {
	/** Run one derivation+application immediately; no-ops when stopped or busy. */
	tick(): Promise<void>;
	/** Stop the interval; future ticks are no-ops. */
	stop(): void;
}

export function createRefreshDriver<T>(deps: RefreshDriverDeps<T>): RefreshDriver {
	let stopped = false;
	let ticking = false;

	async function tick(): Promise<void> {
		if (stopped || ticking) return;
		ticking = true;
		try {
			deps.apply(await deps.derive());
		} catch (error) {
			deps.onError(error instanceof Error ? error : new Error(String(error)));
		} finally {
			ticking = false;
		}
	}

	const timer = setInterval(() => void tick(), deps.intervalMs);
	// A dashboard timer must never keep a process alive on its own.
	timer.unref?.();
	return {
		tick,
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
		},
	};
}
