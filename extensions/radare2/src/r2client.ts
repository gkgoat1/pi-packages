/**
 * Minimal r2pipe session (verified against radare2 6.2.0 on macOS arm64).
 *
 * Wire protocol, as observed on this host:
 * - Spawn `r2 -q0 -N -e scr.color=0 -e scr.prompt=0 -e bin.relocs.apply=true
 *   <file>`; feed commands as newline-terminated lines on stdin.
 * - Each command's reply is terminated by `\n\x00` (empty replies are a bare
 *   `\x00`); r2 may prepend up to three stray NUL bytes to its first output
 *   and re-emit `\x1b[?1000;1002;1006;1015l` mode escapes — strip NULs and
 *   ANSI escapes defensively.
 * - `aaj`/`aaaj` hang in some builds: never send them; run analysis as plain
 *   `aa`/`aaa`/`aaaa` commands.
 * - `-n` (do not load bin info) makes `iij` return empty — do not use it.
 * - `WARN:`/`INFO:` progress lines go to stderr, never interleaved into stdout.
 *
 * The session does NOT spawn r2 itself: the sandbox layer decides how the
 * process is launched (sandbox-exec / bwrap / Gondolin execGuest) and hands
 * the already-spawned process to `attachProcess`. This makes it impossible to
 * accidentally run an unsandboxed r2.
 */

/** ANSI escape + control junk stripped from replies. */
const ESCAPE_RE = /\x1b\[[?0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;

export function cleanReply(raw: string): string {
	return raw
		.replace(ESCAPE_RE, "")
		.replaceAll("\x00", "")
		.replace(/^\r?\n/, "")
		.replace(/\r?\n$/, "");
}

/** Build the argv the sandbox layer should launch (wrapped as it sees fit). */
export function r2Argv(location: string, evals: string[] = []): string[] {
	return [
		"-q0",
		"-N",
		"-e", "scr.color=0",
		"-e", "scr.prompt=0",
		"-e", "bin.relocs.apply=true",
		...evals.flatMap((item) => ["-e", item]),
		location,
	];
}

/** Standard r2 env for the spawned process (TTY ergonomics off). */
export function r2Env(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") result[key] = value;
	}
	return result;
}

/** Minimal writable stdin surface (child.stdin or Gondolin's GuestProcess). */
export interface R2Stdin {
	write(data: string | Buffer): void;
	end(): void;
}

/** Handle on an already-spawned r2 process, however the sandbox launched it. */
export interface AttachedProcess {
	stdin: R2Stdin;
	stdout: AsyncIterable<Buffer> | null;
	/**
	 * Invoke `handler` when the process exits (code/signal not needed).
	 * Returns an unsubscribe function — per-command subscriptions must be
	 * removed after the command settles to avoid listener buildup.
	 */
	onExit(handler: () => void): () => void;
	/** Hard-kill the process (SIGKILL / guest kill). */
	kill(): void;
	/** stderr stream for diagnostics, when available. */
	stderr?: AsyncIterable<Buffer> | null;
}

export interface R2SessionOptions {
	timeoutMs: number;
	signal?: AbortSignal;
}

export class R2Session {
	private process: AttachedProcess | undefined;
	private exited = false;
	/** Serializes command/response round trips on the single stdin pipe. */
	private queue: Promise<unknown> = Promise.resolve();
	private stderrTail = "";
	/** r2 emits one bare NUL at startup, before the first command's reply. */
	private startupNulSeen = false;
	/** Reply sink for the currently in-flight command (single reader design). */
	private pending: { onData(chunk: Buffer): void } | undefined;

	constructor(private readonly options: R2SessionOptions) {}

	/** Hand over a process the sandbox already spawned. */
	attachProcess(process: AttachedProcess): void {
		if (this.process) throw new Error("R2Session already has an attached process");
		this.process = process;
		if (process.stderr) {
			void (async () => {
				try {
					for await (const chunk of process.stderr as AsyncIterable<Buffer>) {
						this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2000);
					}
				} catch {
					// stderr closed or unreadable; diagnostics only
				}
			})();
		}
		// Single persistent stdout reader: the only stream subscription for the
		// session's whole lifetime. Chunks fan out to the pending command.
		if (process.stdout) {
			void (async () => {
				try {
					for await (const chunk of process.stdout as AsyncIterable<Buffer>) {
						this.pending?.onData(chunk);
					}
				} catch {
					// stdout closed or unreadable
				}
			})();
		}
		process.onExit(() => {
			this.exited = true;
		});
		this.options.signal?.addEventListener("abort", () => void this.kill(), { once: true });
	}

	/**
	 * Prove the protocol loop is alive before registering the session.
	 * Uses a \0-terminated JSON command — bare help commands (`?`) do not
	 * emit a reply terminator and the startup banner NUL would otherwise
	 * resolve the round trip immediately.
	 */
	async handshake(): Promise<void> {
		await this.cmd("iVj");
	}

	get alive(): boolean {
		return !this.exited && this.process !== undefined;
	}

	get stderrText(): string {
		return this.stderrTail;
	}

	/** Send one command and resolve its cleaned reply. */
	async cmd(command: string): Promise<string> {
		if (/[\r\n]/.test(command)) {
			throw new Error("r2 command must not contain newlines");
		}
		if (!this.alive) {
			throw new Error(this.describeExit("r2 session is not running"));
		}
		const run = this.queue.then(
			() => this.execOnce(command),
			() => this.execOnce(command),
		);
		this.queue = run.catch(() => {});
		return run;
	}

	/**
	 * One serialized command/response round trip.
	 *
	 * A single persistent reader loop (started in `attachProcess`) owns the
	 * stdout stream and feeds `onStdoutData`; this method only registers the
	 * currently-pending reply sink, so no per-command stream listeners build
	 * up across the session's lifetime.
	 */
	private execOnce(command: string): Promise<string> {
		const proc = this.process;
		if (!proc || this.exited) {
			return Promise.reject(new Error(this.describeExit("r2 session is not running")));
		}
		const { timeoutMs, signal } = this.options;
		return new Promise<string>((resolve, reject) => {
			let buffer = "";
			let settled = false;
			const onAbort = (): void => {
				finish(new Error("r2 command aborted"));
			};
			const timer = setTimeout(() => {
				finish(new Error(`r2 command timed out after ${timeoutMs}ms: ${command}`));
			}, timeoutMs);
			const unsubscribeExit = proc.onExit(() => {
				if (!settled) finish(new Error(this.describeExit(`r2 exited while running: ${command}`)));
			});
			const cleanup = (): void => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				unsubscribeExit();
				this.pending = undefined;
			};
			const finish = (error: Error): void => {
				if (settled) return;
				settled = true;
				cleanup();
				void this.kill();
				reject(error);
			};
			const onData = (chunk: Buffer): void => {
				buffer += chunk.toString("utf8");
				// r2 emits a bare NUL at startup before any command's reply; a
				// later bare NUL is a legitimate (empty) reply, e.g. `aaa`. Only
				// ignore the NUL chunk that arrives before the first command.
				if (!this.startupNulSeen && buffer === "\x00") {
					this.startupNulSeen = true;
					buffer = "";
					return;
				}
				// Replies are terminated by "\n\0" (empty ones by a bare "\0").
				const terminator = buffer.lastIndexOf("\x00");
				if (terminator === -1) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				unsubscribeExit();
				this.pending = undefined;
				resolve(cleanReply(buffer.slice(0, terminator + 1)));
			};
			this.pending = { onData };
			signal?.addEventListener("abort", onAbort, { once: true });
			proc.stdin.write(`${command}\n`);
		});
	}

	/** Send a JSON-producing command and parse the reply. */
	async cmdj<T = unknown>(command: string): Promise<T> {
		const reply = await this.cmd(`${command}j`);
		const trimmed = reply.trim();
		if (trimmed === "" || trimmed === "[]") return [] as T;
		try {
			return JSON.parse(trimmed) as T;
		} catch {
			throw new Error(`r2 returned invalid JSON for ${command}j: ${trimmed.slice(0, 200)}`);
		}
	}

	/** Quit r2 (force, no session save) and wait for exit. */
	async quit(): Promise<void> {
		const proc = this.process;
		if (!proc || this.exited) return;
		await new Promise<void>((resolve) => {
			const done = (): void => resolve();
			proc.onExit(done);
			try {
				proc.stdin.write("q!\n");
			} catch {
				// stdin gone — rely on the exit event or the fallback kill.
			}
			setTimeout(() => {
				try {
					proc.kill();
				} catch {
					// already dead
				}
				resolve();
			}, 1000);
		});
		this.exited = true;
	}

	async kill(): Promise<void> {
		const proc = this.process;
		if (!proc || this.exited) return;
		this.exited = true;
		try {
			proc.kill();
		} catch {
			// already dead
		}
	}

	private describeExit(prefix: string): string {
		const stderr = this.stderrTail.trim();
		return stderr ? `${prefix}\nr2 stderr: ${stderr.slice(-500)}` : prefix;
	}
}
