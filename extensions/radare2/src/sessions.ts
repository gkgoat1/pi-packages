/**
 * Open-binary session registry for the radare2 extension.
 *
 * Handles are short opaque ids ("r2-1", "r2-2", …) the agent passes to
 * subsequent r2_* tools. State lives in module-level closures owned by the
 * extension factory; teardown is idempotent.
 */

import { R2Session } from "./r2client.ts";

export interface OpenOptions {
	location: string;
	projectDir: string;
	tmpDir: string;
	signal?: AbortSignal;
}

export interface OpenedSession {
	handle: string;
	location: string;
	sandbox: string;
	session: R2Session;
}

export type OpenImpl = (
	options: OpenOptions,
) => Promise<{ session: R2Session; sandboxName: string }>;

export class SessionRegistry {
	private counter = 0;
	private readonly sessions = new Map<string, OpenedSession>();

	/** Injected open implementation: sandbox.spawn → process attach → handshake. */
	openImpl: OpenImpl = async () => {
		throw new Error("openImpl not configured");
	};

	get size(): number {
		return this.sessions.size;
	}

	list(): Array<{ handle: string; location: string; sandbox: string }> {
		return [...this.sessions.values()].map(({ handle, location, sandbox }) => ({ handle, location, sandbox }));
	}

	get(handle: string): OpenedSession | undefined {
		return this.sessions.get(handle);
	}

	/**
	 * Open a location (the injected openImpl resolves the sandbox plan, spawns
	 * r2, and proves the protocol loop alive) and register the session.
	 * Throws (fail closed) when the sandbox or r2 fails.
	 */
	async open(options: OpenOptions, maxOpenSessions: number): Promise<OpenedSession> {
		if (this.sessions.size >= maxOpenSessions) {
			throw new Error(
				`Too many open r2 sessions (max ${maxOpenSessions}). Close one with r2_close first.`,
			);
		}
		const opened = await this.openImpl(options);
		const handle = `r2-${++this.counter}`;
		const record: OpenedSession = {
			handle,
			location: options.location,
			sandbox: opened.sandboxName,
			session: opened.session,
		};
		this.sessions.set(handle, record);
		return record;
	}

	async close(handle: string): Promise<boolean> {
		const record = this.sessions.get(handle);
		if (!record) return false;
		this.sessions.delete(handle);
		await record.session.quit();
		return true;
	}

	async closeAll(): Promise<void> {
		const records = [...this.sessions.values()];
		this.sessions.clear();
		await Promise.all(records.map((record) => record.session.quit().catch(() => {})));
	}
}
