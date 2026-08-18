/**
 * The cross-extension Gondolin shared handle.
 *
 * Extensions in this package are bundled separately and must not depend on
 * each other. To let File Guard and the MCP client reuse the sandbox VM
 * without a dependency, the Gondolin extension publishes a handle on
 * `globalThis` under a registered symbol (`Symbol.for`), so every bundle in
 * the same Pi process resolves the same value. Consumers mirror the minimal
 * structural contract below (see `extensions/file-guard/src/gondolin.ts` and
 * `extensions/mcp-client/src/vm.ts`); TypeScript structural typing keeps the
 * copies compatible without imports.
 *
 * The handle exposes:
 * - the VM itself (`ensureVm`/`getVm`) plus the host↔guest workspace mapping,
 * - VM-filesystem guards: before/after hooks on every operation against the
 *   mounted host workspace (this is File Guard's interception mode),
 * - `execGuest`: long-running guest processes with piped stdio (MCP servers).
 */

import path from "node:path";
import type { Readable } from "node:stream";
import { RealFSProvider, SandboxVfsProvider, type VM } from "@earendil-works/gondolin";
import type { VirtualProvider, VfsHookContext } from "@earendil-works/gondolin";
import { buildStubEnv, type DiscoveredSecret } from "./secrets.ts";
import { GUEST_BASE_ENV, shQuote } from "./ops.ts";

/** Registered symbol under which the handle is published on globalThis. */
export const GONDOLIN_SHARED_KEY = Symbol.for("pi-packages.gondolin.shared");

/** Contract version; consumers reject handles with a different version. */
export const GONDOLIN_SHARED_VERSION = 1 as const;

/** A single filesystem operation reaching the mounted host workspace. */
export interface FsGuardRequest {
	/** Provider operation name, e.g. "open", "stat", "readdir", "rename". */
	op: string;
	/** Path as seen by the provider (workspace-root relative, leading "/"). */
	guestPath: string;
	/** Corresponding path on the host. */
	hostPath: string;
	/** Whether the operation creates or modifies state. */
	write: boolean;
}

/** Returned by a guard's `before` to deny the operation. */
export interface FsGuardDecision {
	/** Human-readable denial reason; reaches the guest as the errno message. */
	reason: string;
}

export interface GondolinFsGuard {
	/** Consulted before each filesystem operation; deny by returning a decision. */
	before?(request: FsGuardRequest): Promise<FsGuardDecision | undefined>;
	/** Notified after each filesystem operation (view logging; never blocks). */
	after?(request: FsGuardRequest): Promise<void>;
}

/** A guest process with piped stdio (structural over gondolin's ExecProcess). */
export interface GuestProcess {
	write(data: string | Buffer): void;
	end(): void;
	readonly stdout: Readable | null;
	readonly stderr: Readable | null;
	readonly result: Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface GuestExecSpec {
	/** Command to run; resolved through the guest $PATH. */
	command: string;
	/** Arguments passed to the command. */
	args?: string[];
	/** Extra guest env (values matching discovered secrets are stubbed). */
	env?: Record<string, string>;
	/** Guest working directory (default: the workspace mount). */
	cwd?: string;
	/** Abort signal; kills the guest process. */
	signal?: AbortSignal;
}

export interface GondolinShared {
	readonly version: typeof GONDOLIN_SHARED_VERSION;
	/** Host directory mounted read-write into the guest. */
	readonly hostCwd: string;
	/** Guest mount point for `hostCwd`. */
	readonly guestWorkspace: string;
	/** Whether the Gondolin extension resolved enabled for this session. */
	isEnabled(): boolean;
	/**
	 * Re-resolve the Gondolin config with the given project-trust decision
	 * (Pi resolves trust at session start; this lets earlier-loaded extensions
	 * see the trust-correct state). Returns the refreshed `enabled` value.
	 */
	refreshTrust(isProjectTrusted: boolean): boolean;
	/** Boot (or return the running) sandbox VM. */
	ensureVm(): Promise<unknown>;
	/** The running VM, or null while stopped. */
	getVm(): unknown;
	/** Map a host path under the workspace to its guest path, else undefined. */
	toGuestPath(hostPath: string): string | undefined;
	/**
	 * Register a VM-filesystem guard for the workspace mount. The returned
	 * function unregisters it. Guards are consulted dynamically, so they may
	 * be registered before or after the VM boots.
	 */
	registerFsGuard(guard: GondolinFsGuard): () => void;
	/**
	 * Start a long-running process inside the VM with piped stdio. The guest
	 * env is the minimal base plus credential stubs; `spec.env` values that
	 * match discovered secrets are replaced with stubs so real keys stay
	 * host-side (the HTTP proxy inflates them back on egress). Throws if the
	 * VM is not running — call `ensureVm()` first.
	 */
	execGuest(spec: GuestExecSpec): GuestProcess;
}

/**
 * Provider operations that are skipped entirely: post-open handle I/O
 * (already gated by "open"), stream/watch plumbing, and mount metadata.
 * Every other path-bearing operation reaches the guards.
 */
const SKIP_FS_OPS = new Set([
	"read",
	"readSync",
	"write",
	"writeSync",
	"release",
	"releaseSync",
	"close",
	"closeSync",
	"fsync",
	"fsyncSync",
	"flush",
	"statfs",
	"statfsSync",
	"watch",
	"watchAsync",
	"watchFile",
	"unwatchFile",
	"readlink",
	"readlinkSync",
	"realpath",
	"realpathSync",
]);

/** Operations that create or modify state regardless of open flags. */
const WRITE_FS_OPS = new Set([
	"create",
	"mknod",
	"mkdir",
	"mkdirSync",
	"rmdir",
	"rmdirSync",
	"unlink",
	"unlinkSync",
	"rename",
	"renameSync",
	"link",
	"linkSync",
	"symlink",
	"symlinkSync",
	"truncate",
	"truncateSync",
	"writeFile",
	"writeFileSync",
	"setattr",
	"utimens",
	"chmod",
	"chown",
]);

/** O_ACCMODE mask (O_WRONLY=1, O_RDWR=2) for numeric open flags. */
const O_ACCMODE = 0x3;

export function isWriteFsOp(op: string, flags: string | number | undefined): boolean {
	if (WRITE_FS_OPS.has(op)) return true;
	if (op !== "open" && op !== "openSync") return false;
	if (typeof flags === "number") return (flags & O_ACCMODE) !== 0;
	return typeof flags === "string" ? /[wa+]/.test(flags) : false;
}

/**
 * Map a provider/workspace path to the host path. Provider paths are
 * workspace-root relative with a leading "/" ("/src/a.ts"); guest-absolute
 * workspace paths (via the vfs shortcut route) carry the mount prefix and are
 * normalized as well.
 */
export function toHostPath(hostCwd: string, guestWorkspace: string, vfsPath: string): string {
	let p = vfsPath;
	if (guestWorkspace && (p === guestWorkspace || p.startsWith(`${guestWorkspace}/`))) {
		p = p.slice(guestWorkspace.length);
	}
	p = p.replace(/^\/+/, "");
	if (p === "" || p === ".") return hostCwd;
	return path.resolve(hostCwd, p);
}

/** Map a host path under the workspace to its guest path; undefined if outside. */
export function hostPathToGuestPath(hostCwd: string, guestWorkspace: string, hostPath: string): string | undefined {
	const rel = path.relative(hostCwd, hostPath);
	if (rel === "") return guestWorkspace;
	if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
	return path.posix.join(guestWorkspace, rel.split(path.sep).join("/"));
}

/** Build the EACCES error the vfs layer converts into a guest-visible errno. */
export function createEaccesError(syscall: string, vfsPath: string, reason: string): Error {
	const error = new Error(`File Guard: ${reason}`) as Error & {
		errno: number;
		code: string;
		syscall: string;
		path: string;
	};
	error.errno = 13; // EACCES
	error.code = "EACCES";
	error.syscall = syscall;
	error.path = vfsPath;
	return error;
}

/**
 * Wrap the workspace backend so every mounted-host filesystem operation is
 * offered to the registered guards first. Guards are read live from `guards`
 * at operation time, so registration order relative to VM boot is irrelevant.
 */
export function createGuardedWorkspaceProvider(
	backend: VirtualProvider,
	guards: Set<GondolinFsGuard>,
	hostCwd: string,
	guestWorkspace: string,
): SandboxVfsProvider {
	const requestFor = (op: string, vfsPath: string, write: boolean): FsGuardRequest => ({
		op,
		guestPath: vfsPath,
		hostPath: toHostPath(hostCwd, guestWorkspace, vfsPath),
		write,
	});

	return new SandboxVfsProvider(backend, {
		before: async (hook: VfsHookContext) => {
			if (SKIP_FS_OPS.has(hook.op)) return;
			const write = isWriteFsOp(hook.op, hook.flags);
			const paths = [hook.path, hook.oldPath, hook.newPath].filter(
				(p): p is string => typeof p === "string" && p.length > 0,
			);
			const unique = [...new Set(paths)];
			for (const p of unique) {
				const request = requestFor(hook.op, p, write);
				for (const guard of guards) {
					const decision = await guard.before?.(request);
					if (decision) throw createEaccesError(hook.op, p, decision.reason);
				}
			}
		},
		after: async (hook: VfsHookContext) => {
			if (SKIP_FS_OPS.has(hook.op)) return;
			const paths = [hook.path, hook.oldPath, hook.newPath].filter(
				(p): p is string => typeof p === "string" && p.length > 0,
			);
			const write = isWriteFsOp(hook.op, hook.flags);
			for (const p of new Set(paths)) {
				const request = requestFor(hook.op, p, write);
				for (const guard of guards) {
					void guard.after?.(request).catch(() => {
						// View logging must never break filesystem operations.
					});
				}
			}
		},
	});
}

/**
 * Replace env values that are (or belong to) discovered credentials with
 * their guest stubs, so config-provided real keys never reach the guest.
 */
export function stubifyEnv(
	env: Record<string, string>,
	secrets: DiscoveredSecret[],
): Record<string, string> {
	if (secrets.length === 0) return env;
	const byValue = new Map(secrets.map((secret) => [secret.value, secret.placeholder]));
	const byName = new Map(secrets.map((secret) => [secret.name, secret.placeholder]));
	const stubbed: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		stubbed[key] = byValue.get(value) ?? byName.get(key) ?? value;
	}
	return stubbed;
}

/**
 * Launch a guest process for `execGuest`. Bare command names need the guest
 * $PATH, and gondolin's array-form exec does not search $PATH, so route
 * through `sh -c 'exec …'` (which also folds args into a single process).
 */
export function launchGuestProcess(
	vm: VM,
	spec: GuestExecSpec,
	secrets: DiscoveredSecret[],
	guestWorkspace: string,
): GuestProcess {
	const quoted = [spec.command, ...(spec.args ?? [])].map(shQuote).join(" ");
	const env: Record<string, string> = {
		...GUEST_BASE_ENV,
		...buildStubEnv(secrets),
		...stubifyEnv(spec.env ?? {}, secrets),
	};
	return vm.exec(["/bin/sh", "-c", `exec ${quoted}`], {
		cwd: spec.cwd ?? guestWorkspace,
		env,
		stdin: true,
		stdout: "pipe",
		stderr: "pipe",
		...(spec.signal ? { signal: spec.signal } : {}),
	});
}

/** Publish the handle on globalThis (called by the Gondolin extension). */
export function installGondolinShared(handle: GondolinShared): void {
	(globalThis as Record<symbol, unknown>)[GONDOLIN_SHARED_KEY] = handle;
}

/** Read the published handle; undefined when the Gondolin extension is absent. */
export function getGondolinShared(): GondolinShared | undefined {
	const value = (globalThis as Record<symbol, unknown>)[GONDOLIN_SHARED_KEY];
	if (typeof value !== "object" || value === null) return undefined;
	const handle = value as GondolinShared;
	return handle.version === GONDOLIN_SHARED_VERSION ? handle : undefined;
}

/** Test helper: clear the published handle. */
export function clearGondolinSharedForTest(): void {
	delete (globalThis as Record<symbol, unknown>)[GONDOLIN_SHARED_KEY];
}

// Re-export so the extension entry can mount the guarded workspace provider
// without importing RealFSProvider twice.
export { RealFSProvider };
