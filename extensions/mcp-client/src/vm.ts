/**
 * Gondolin VM support for the MCP client.
 *
 * When the Gondolin sandbox extension is enabled, MCP servers can run inside
 * the sandbox VM instead of on the host: their process, filesystem view, and
 * network egress are all confined to the VM (with credential stubs inflated
 * by the sandbox HTTP proxy). Servers opt out individually or globally via
 * `"inVm": false`.
 *
 * Like File Guard, this module must not import from the Gondolin extension
 * (separately bundled extensions stay dependency-free). It mirrors the minimal
 * structural handle contract from `extensions/gondolin/src/shared.ts` and
 * resolves the value through the shared registered symbol at runtime.
 */

import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** Registered symbol under which Gondolin publishes its shared handle. */
export const GONDOLIN_SHARED_KEY = Symbol.for("pi-packages.gondolin.shared");

/** Guest process with piped stdio (contract copy, structural over ExecProcess). */
export interface GuestProcess {
	write(data: string | Buffer): void;
	end(): void;
	readonly stdout: import("node:stream").Readable | null;
	readonly stderr: import("node:stream").Readable | null;
	readonly result: Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/** Structural subset of Gondolin's shared handle that the MCP client uses. */
export interface GondolinHandle {
	readonly version: 1;
	readonly guestWorkspace: string;
	readonly hostCwd: string;
	isEnabled(): boolean;
	/** Re-resolve the Gondolin config with this session's trust decision. */
	refreshTrust(isProjectTrusted: boolean): boolean;
	ensureVm(): Promise<unknown>;
	toGuestPath(hostPath: string): string | undefined;
	execGuest(spec: {
		command: string;
		args?: string[];
		env?: Record<string, string>;
		cwd?: string;
		signal?: AbortSignal;
	}): GuestProcess;
}

/**
 * Read the published Gondolin handle. Returns undefined when the Gondolin
 * extension is not loaded (or speaks a different contract version).
 */
export function getGondolinHandle(): GondolinHandle | undefined {
	const value = (globalThis as Record<symbol, unknown>)[GONDOLIN_SHARED_KEY];
	if (typeof value !== "object" || value === null) return undefined;
	const handle = value as GondolinHandle;
	return handle.version === 1 ? handle : undefined;
}

/**
 * Whether a server should run inside the VM: only when the Gondolin extension
 * is enabled, and unless the server (or the global config) opts out. In-VM is
 * the default whenever Gondolin is active.
 */
export function resolveRunInVm(
	shared: GondolinHandle | undefined,
	configInVm: boolean | undefined,
	serverInVm: boolean | undefined,
): boolean {
	if (!shared?.isEnabled()) return false;
	return serverInVm ?? configInVm ?? true;
}

/** Grace period after stdin EOF before the guest process is killed on close. */
const CLOSE_GRACE_MS = 1500;

/** Stderr tail kept for exit diagnostics. */
const STDERR_TAIL_CHARS = 4000;

/**
 * MCP transport over a guest process: newline-delimited JSON-RPC on the
 * process's stdin/stdout, mirroring the SDK's StdioClientTransport framing.
 */
export class VmMcpTransport implements Transport {
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: JSONRPCMessage) => void;

	private readBuffer = new ReadBuffer();
	private proc: GuestProcess | undefined;
	private abort: AbortController | undefined;
	private stderrTail = "";
	private closed = false;

	constructor(
		private readonly shared: GondolinHandle,
		private readonly params: {
			command: string;
			args?: string[];
			env?: Record<string, string>;
			/** Guest working directory. */
			cwd?: string;
		},
	) {}

	async start(): Promise<void> {
		if (this.proc) {
			throw new Error("VmMcpTransport already started; Client.connect() calls start() automatically.");
		}
		this.abort = new AbortController();
		await this.shared.ensureVm();
		const proc = this.shared.execGuest({
			command: this.params.command,
			args: this.params.args,
			env: this.params.env,
			cwd: this.params.cwd,
			signal: this.abort.signal,
		});
		this.proc = proc;

		proc.stdout?.on("data", (chunk: Buffer) => {
			this.readBuffer.append(chunk);
			this.drain();
		});
		proc.stdout?.on("error", (error: Error) => this.onerror?.(error));
		proc.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
		});

		void proc.result
			.then((result) => {
				if (result.exitCode !== 0 && !this.closed) {
					const detail = this.stderrTail.trim() || "(no stderr output)";
					this.onerror?.(
						new Error(
							`MCP server exited inside the Gondolin VM with code ${result.exitCode}: ${detail}`,
						),
					);
				}
				this.finish();
			})
			.catch((error: unknown) => {
				this.onerror?.(error instanceof Error ? error : new Error(String(error)));
				this.finish();
			});
	}

	async send(message: JSONRPCMessage): Promise<void> {
		if (!this.proc) throw new Error("VmMcpTransport not started");
		this.proc.write(serializeMessage(message));
	}

	async close(): Promise<void> {
		const proc = this.proc;
		if (!proc) {
			this.finish();
			return;
		}
		// Graceful shutdown: stdin EOF lets the server exit cleanly; abort kills
		// it after the grace period.
		proc.end();
		const killTimer = setTimeout(() => this.abort?.abort(), CLOSE_GRACE_MS);
		try {
			await proc.result;
		} catch {
			// Killed or already exited.
		} finally {
			clearTimeout(killTimer);
		}
		this.finish();
	}

	private drain(): void {
		while (true) {
			try {
				const message = this.readBuffer.readMessage();
				if (message === null) break;
				this.onmessage?.(message);
			} catch (error) {
				this.onerror?.(error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	private finish(): void {
		if (this.closed) return;
		this.closed = true;
		this.onclose?.();
	}
}
