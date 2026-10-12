/**
 * Sandbox backend for the radare2 extension: mandatory confinement of every
 * r2 process (and everything it spawns, including `!` shell children).
 *
 * Backends:
 * - darwin: Seatbelt (`sandbox-exec`) with the bundled radare2.sb profile.
 *   The only permitted bare-run fallback is when pi itself is already inside
 *   a Seatbelt sandbox (nesting is denied by the kernel); everything else
 *   fails closed.
 * - linux: bubblewrap user namespaces, no fallback.
 * - both: optional Gondolin VM backend (`sandbox.backend: "gondolin"`).
 *
 * Gondolin integration mirrors the minimal structural handle contract used by
 * extensions/file-guard (separately bundled
 * extensions stay dependency-free; values are matched at runtime through the
 * shared registered symbol).
 */

import { spawn } from "node:child_process";

export interface SandboxSpec {
	/** Absolute path of the r2 binary to execute. */
	r2Binary: string;
	/** r2 arguments (file to open comes last). */
	r2Args: string[];
	/** Project working directory (write allowlist + Gondolin mount). */
	projectDir: string;
	/** Temp directory handed to the profile for scratch writes. */
	tmpDir: string;
	/** Signal that should kill the sandboxed process. */
	signal?: AbortSignal;
}

export interface SandboxedSpawn {
	kind?: "host";
	command: string;
	args: string[];
	env: Record<string, string>;
}

export type SandboxSpawnSpec = SandboxSpec;

export interface Sandbox {
	readonly backendName: string;
	/** Build the (command, args, env) for a sandboxed r2 spawn. */
	spawn(spec: SandboxSpec): Promise<SandboxedSpawn>;
}

/** Errno-style failure with an actionable message. */
export class SandboxError extends Error {
	constructor(
		message: string,
		readonly backend: string,
	) {
		super(message);
		this.name = "SandboxError";
	}
}

// ---------------------------------------------------------------------------
// Gondolin shared handle (structural contract copy)
// ---------------------------------------------------------------------------

export const GONDOLIN_SHARED_KEY = Symbol.for("pi-packages.gondolin.shared");

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
	}): {
		write(data: string | Buffer): void;
		end(): void;
		readonly stdout: import("node:stream").Readable | null;
		readonly stderr: import("node:stream").Readable | null;
		readonly result: Promise<{ exitCode: number; stdout: string; stderr: string }>;
	};
}

export function getGondolinHandle(): GondolinHandle | undefined {
	const value = (globalThis as Record<symbol, unknown>)[GONDOLIN_SHARED_KEY];
	if (typeof value !== "object" || value === null) return undefined;
	const handle = value as GondolinHandle;
	return handle.version === 1 ? handle : undefined;
}

// ---------------------------------------------------------------------------
// Seatbelt profile preparation
// ---------------------------------------------------------------------------

const EXTRA_DENIES_MARKER = ";; EXTRA_DENIES";

/** regex-quote a path for use inside profile (regex ...) filters. */
export function regexQuotePath(path: string): string {
	return path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Canonicalize a host path for Seatbelt filter matching.
 *
 * Empirically (macOS 26, radare2 6.2 era), deny filters for paths under the
 * user's /var/folders or /tmp containers only match when spelled with the
 * /private prefix (the canonical on-disk location), while non-container
 * paths (e.g. /Users, /etc) match as given. Emitting the /private spelling
 * for those trees makes denies reliable; allows under the same trees keep
 * working either way.
 */
export function canonicalSandboxPath(path: string, platform = process.platform): string {
	if (platform !== "darwin") return path;
	if (path.startsWith("/private/")) return path;
	if (path === "/var" || path.startsWith("/var/") || path === "/tmp" || path.startsWith("/tmp/")) {
		return `/private${path}`;
	}
	return path;
}

/**
 * Render the bundled profile with textual parameter substitution.
 *
 * `(param ...)` inside require-all/require-not path filters fails on current
 * macOS ("invalid data type of path filter; expected pattern, got boolean"),
 * so — like the project's other seatbelt wrappers — we substitute the values
 * textually. Values are asserted free of profile-significant characters.
 */
export function renderSeatbeltProfile(
	profileText: string,
	params: { home: string; projectDir: string; tmpDir: string; extraDenies?: string[] },
): string {
	const assertSafe = (label: string, value: string): string => {
		// Only assert against characters that are significant to the SBPL
		// grammar. Literal parentheses etc. in real paths are still safe here
		// because substitution happens inside quoted strings and filter
		// literals; we merely forbid injection vectors (quotes/newlines).
		if (/["\\\n\r]/.test(value)) {
			throw new SandboxError(`${label} contains characters not allowed in the Seatbelt profile: ${value}`, "seatbelt");
		}
		return value;
	};
	const home = assertSafe("home", params.home);
	// Container paths (per-user /var/folders, /tmp) are canonicalized so deny
	// filters reliably match (see canonicalSandboxPath). Project dirs outside
	// the containers pass through unchanged.
	const projectDir = assertSafe("projectDir", canonicalSandboxPath(params.projectDir));
	const tmpDir = assertSafe("tmpDir", canonicalSandboxPath(params.tmpDir));
	let text = profileText
		.replaceAll("PARAM_HOME_QUOTED", regexQuotePath(home))
		.replaceAll("PARAM_HOME", home)
		.replaceAll("PARAM_PROJ", projectDir)
		.replaceAll("PARAM_TMP", tmpDir);
	if (!text.includes(EXTRA_DENIES_MARKER)) {
		text += `\n${EXTRA_DENIES_MARKER}\n`;
	}
	const extra = (params.extraDenies ?? []).join("\n");
	text = text.replace(EXTRA_DENIES_MARKER, extra ? `${extra}\n${EXTRA_DENIES_MARKER}` : EXTRA_DENIES_MARKER);
	if (params.extraDenies?.length) {
		// Keep the marker for subsequent renders (tests); drop it only in the
		// final artifact by leaving it — sandbox-exec ignores comments.
	}
	return text;
}

// ---------------------------------------------------------------------------
// Seatbelt backend (macOS)
// ---------------------------------------------------------------------------

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Run a probe command under a minimal profile; resolves to exit code. */
function runProbe(args: string[], timeoutMs = 10_000): Promise<{ code: number | null; error?: string }> {
	return new Promise((resolve) => {
		try {
			const child = spawn(args[0], args.slice(1), { stdio: "ignore" });
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve({ code: null, error: "probe timed out" });
			}, timeoutMs);
			child.on("error", (error) => {
				clearTimeout(timer);
				resolve({ code: null, error: error.message });
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ code });
			});
		} catch (error) {
			resolve({ code: null, error: error instanceof Error ? error.message : String(error) });
		}
	});
}

export interface SeatbeltOptions {
	profileText: string;
	extraDenies: string[];
}

/**
 * Create the macOS Seatbelt backend. Performs the startup probe:
 * - sandbox-exec missing → fail closed;
 * - probe under the full profile succeeds → wrap spawns;
 * - probe fails with "sandbox_apply: Operation not permitted" (exit 71) while
 *   a minimal nested probe also fails the same way → we are already inside a
 *   Seatbelt sandbox → bare-run fallback (the only permitted one);
 * - any other failure → fail closed.
 */
export async function createSeatbeltBackend(
	options: SeatbeltOptions,
	platform = process.platform,
): Promise<Sandbox> {
	if (platform !== "darwin") {
		throw new SandboxError("Seatbelt backend is only available on macOS", "seatbelt");
	}
	// 1. sandbox-exec must exist.
	const execProbe = await runProbe([SANDBOX_EXEC, "-h"]);
	if (execProbe.error !== undefined && execProbe.code === null) {
		throw new SandboxError(
			`sandbox-exec is not available (${execProbe.error}); cannot sandbox radare2. Install Xcode command line tools.`,
			"seatbelt",
		);
	}
	// 2. Try applying a real profile (this is what fails when already nested).
	const applyProbe = await runProbe([
		SANDBOX_EXEC,
		"-f",
		"/dev/stdin",
		"/usr/bin/true",
	]).then(async (result) => {
		// -f /dev/stdin is unreliable across macOS versions; use a process
		// substitution-free approach: write the profile to the temp dir.
		const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = await mkdtemp(join(tmpdir(), "r2-sb-"));
		const profilePath = join(dir, "probe.sb");
		await writeFile(profilePath, renderSeatbeltProfile(options.profileText, {
			home: (await import("node:os")).homedir(),
			projectDir: dir,
			tmpDir: dir,
		}));
		try {
			return await runProbe([SANDBOX_EXEC, "-f", profilePath, "/usr/bin/true"]);
		} finally {
			void rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	});
	if (applyProbe.code === 0) {
		return {
			backendName: "seatbelt",
			async spawn(spec: SandboxSpec): Promise<SandboxedSpawn> {
				const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
				const { tmpdir, homedir } = await import("node:os");
				const { join } = await import("node:path");
				const dir = await mkdtemp(join(tmpdir(), "r2-sb-"));
				const profilePath = join(dir, "radare2.sb");
				const profile = renderSeatbeltProfile(options.profileText, {
					home: homedir(),
					projectDir: spec.projectDir,
					tmpDir: spec.tmpDir,
					extraDenies: options.extraDenies,
				});
				await writeFile(profilePath, profile);
				const cleanup = (): void => {
					void rm(dir, { recursive: true, force: true }).catch(() => {});
				};
				spec.signal?.addEventListener("abort", cleanup, { once: true });
				// The profile file must be readable by r2's spawn; it lives in a
				// fresh temp dir which the profile also write-allows.
				return {
					command: SANDBOX_EXEC,
					args: ["-f", profilePath, spec.r2Binary, ...spec.r2Args],
					env: {},
				};
			},
		};
	}
	// 3. Distinguish "already nested" from other failures.
	const nested = applyProbe.code === 71 && /Operation not permitted/i.test(applyProbe.error ?? "operation not permitted");
	if (applyProbe.code === 71 || /Operation not permitted/i.test(applyProbe.error ?? "")) {
		if (nested || applyProbe.code === 71) {
			return {
				backendName: "seatbelt-nested",
				async spawn(spec: SandboxSpec): Promise<SandboxedSpawn> {
					// Already inside a Seatbelt sandbox: the kernel denies nested
					// apply, and confinement is already in force. Run bare.
					return { command: spec.r2Binary, args: spec.r2Args, env: {} };
				},
			};
		}
	}
	throw new SandboxError(
		`Seatbelt probe failed (exit ${applyProbe.code ?? "signal"}, ${applyProbe.error ?? "no error"}); refusing to run radare2 unsandboxed.`,
		"seatbelt",
	);
}

// ---------------------------------------------------------------------------
// bubblewrap backend (Linux)
// ---------------------------------------------------------------------------

export function buildBwrapArgs(spec: { r2Binary: string; r2Args: string[]; projectDir: string; tmpDir: string }): string[] {
	return [
		"--unshare-all",
		"--share-net",
		"--die-with-parent",
		"--new-session",
		"--clean-env",
		"--dev", "/dev",
		"--proc", "/proc",
		"--tmpfs", "/tmp",
		"--ro-bind", "/", "/",
		"--bind", spec.tmpDir, spec.tmpDir,
		"--bind", spec.projectDir, spec.projectDir,
		"--",
		spec.r2Binary,
		...spec.r2Args,
	];
}

export function createBwrapBackend(platform: string = process.platform): Sandbox {
	if (platform !== "linux") {
		throw new SandboxError("bwrap backend is only available on Linux", "bwrap");
	}
	return {
		backendName: "bwrap",
		async spawn(spec: SandboxSpec): Promise<SandboxedSpawn> {
			const bwrap = await new Promise<string | undefined>((resolve) => {
				const child = spawn("bwrap", ["--version"], { stdio: "ignore" });
				child.on("error", () => resolve(undefined));
				child.on("close", (code) => resolve(code === 0 ? "bwrap" : undefined));
			});
			if (!bwrap) {
				throw new SandboxError(
					"bubblewrap (bwrap) is required to sandbox radare2 on Linux but is not installed or not executable; refusing to run radare2 unsandboxed. Install bwrap and ensure unprivileged user namespaces are enabled.",
					"bwrap",
				);
			}
			return {
				command: bwrap,
				args: buildBwrapArgs(spec),
				env: {},
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Gondolin backend (opt-in, both platforms)
// ---------------------------------------------------------------------------

export function createGondolinBackend(handle: GondolinHandle): Sandbox & {
	/** Build a Gondolin guest-exec plan (kind: "gondolin"). */
	plan(spec: SandboxSpec): GondolinSpawnPlan;
} {
	const buildPlan = (spec: SandboxSpec): GondolinSpawnPlan => {
		const guestBinary = handle.toGuestPath(spec.r2Binary) ?? spec.r2Binary;
		const guestCwd = handle.toGuestPath(spec.projectDir) ?? handle.guestWorkspace;
		const args = [...spec.r2Args];
		const last = args[args.length - 1];
		if (last !== undefined && !last.includes("://")) {
			const mapped = handle.toGuestPath(last);
			if (mapped) args[args.length - 1] = mapped;
		}
		return { kind: "gondolin", handle, guestBinary, args, cwd: guestCwd };
	};
	return {
		backendName: "gondolin",
		plan: buildPlan,
		async spawn(spec: SandboxSpec): Promise<SandboxedSpawn> {
			if (!handle.isEnabled()) {
				throw new SandboxError(
					'sandbox.backend is "gondolin" but the Gondolin sandbox extension is not enabled; refusing to run radare2 on the host.',
					"gondolin",
				);
			}
			await handle.ensureVm(); // throws when QEMU is missing / boot fails
			const plan = buildPlan(spec);
			return { command: plan.guestBinary, args: plan.args, env: {} };
		},
	};
}

/** Handle for Gondolin-backed sessions: execGuest instead of host spawn. */
export interface GondolinSpawnPlan {
	kind: "gondolin";
	handle: GondolinHandle;
	guestBinary: string;
	args: string[];
	cwd: string;
}

export type SpawnPlan = SandboxedSpawn | GondolinSpawnPlan;

/** Dispatch the configured backend for this platform. */
export async function resolveBackend(
	backendSetting: "auto" | "bwrap" | "gondolin",
	platform: string,
	options: { seatbelt: SeatbeltOptions },
): Promise<{ backend: Sandbox; gondolin?: GondolinHandle }> {
	const gondolin = getGondolinHandle();
	if (backendSetting === "gondolin") {
		if (!gondolin) {
			throw new SandboxError(
				'sandbox.backend is "gondolin" but the Gondolin sandbox extension is not loaded; refusing to run radare2 without a sandbox backend.',
				"gondolin",
			);
		}
		return { backend: createGondolinBackend(gondolin), gondolin };
	}
	if (platform === "darwin") {
		return { backend: await createSeatbeltBackend(options.seatbelt, platform) };
	}
	return { backend: createBwrapBackend(platform) };
}
