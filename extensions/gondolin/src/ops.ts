/**
 * Read/write/edit/bash tool operations backed by a live Gondolin VM.
 *
 * Adapted from pi-gondolin: the host working directory is mounted read-write at
 * the guest workspace, and every file or command operation is translated into a
 * guest path / guest exec. Environment handling differs from upstream: the
 * guest never inherits the host environment. It gets a minimal guest base env
 * plus credential *stubs*, and only explicitly configured passthrough names
 * (scrubbed of real credential values).
 */

import path from "node:path";
import {
	type BashOperations,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { VM } from "@earendil-works/gondolin";
import type { DiscoveredSecret } from "./secrets.ts";
import { sanitizeGuestEnv } from "./secrets.ts";

export const GUEST_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export function shQuote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function toGuestPath(localCwd: string, localPath: string, guestWorkspace: string): string {
	const rel = path.relative(localCwd, localPath);
	if (rel === "") return guestWorkspace;
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`path escapes workspace: ${localPath}`);
	}
	const posixRel = rel.split(path.sep).join(path.posix.sep);
	return path.posix.join(guestWorkspace, posixRel);
}

export interface GuestEnvOptions {
	/** Env passed by pi's bash tool (defaults to the full host env). */
	hostEnv?: NodeJS.ProcessEnv;
	/** Discovered credentials (used to scrub passthrough values). */
	secrets: DiscoveredSecret[];
	/** Host env var names allowed into the guest. */
	passthrough: string[];
}

/** Minimal guest base env; no host values leak in here. */
export const GUEST_BASE_ENV: Record<string, string> = {
	PATH: GUEST_PATH,
	HOME: "/root",
	TERM: "xterm",
	LANG: "C.UTF-8",
};

/** Build the env passed to a guest exec. */
export function buildGuestEnv(options: GuestEnvOptions): Record<string, string> {
	return sanitizeGuestEnv(options.hostEnv, options.secrets, options.passthrough);
}

function createReadOps(vm: VM, localCwd: string, guestWorkspace: string): ReadOperations {
	return {
		readFile: async (p) => {
			const guestPath = toGuestPath(localCwd, p, guestWorkspace);
			const r = await vm.exec(["/bin/cat", guestPath]);
			if (!r.ok) {
				throw new Error(`cat failed (${r.exitCode}): ${r.stderr}`);
			}
			return r.stdoutBuffer;
		},

		access: async (p) => {
			const guestPath = toGuestPath(localCwd, p, guestWorkspace);
			const r = await vm.exec(["/bin/sh", "-lc", `test -r ${shQuote(guestPath)}`]);
			if (!r.ok) {
				throw new Error(`not readable: ${p}`);
			}
		},

		detectImageMimeType: async (p) => {
			const guestPath = toGuestPath(localCwd, p, guestWorkspace);
			try {
				const r = await vm.exec(["/bin/sh", "-lc", `file --mime-type -b ${shQuote(guestPath)}`]);
				if (!r.ok) return null;
				const m = r.stdout.trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
}

function createWriteOps(vm: VM, localCwd: string, guestWorkspace: string): WriteOperations {
	return {
		writeFile: async (p, content) => {
			const guestPath = toGuestPath(localCwd, p, guestWorkspace);
			const dir = path.posix.dirname(guestPath);
			// Base64 roundtrip to avoid shell quoting issues with arbitrary content
			const b64 = Buffer.from(content).toString("base64");
			const script = [
				`set -eu`,
				`mkdir -p ${shQuote(dir)}`,
				`echo ${shQuote(b64)} | base64 -d > ${shQuote(guestPath)}`,
			].join("\n");
			const r = await vm.exec(["/bin/sh", "-lc", script]);
			if (!r.ok) {
				throw new Error(`write failed (${r.exitCode}): ${r.stderr}`);
			}
		},

		mkdir: async (dir) => {
			const guestDir = toGuestPath(localCwd, dir, guestWorkspace);
			const r = await vm.exec(["/bin/mkdir", "-p", guestDir]);
			if (!r.ok) {
				throw new Error(`mkdir failed (${r.exitCode}): ${r.stderr}`);
			}
		},
	};
}

function createEditOps(vm: VM, localCwd: string, guestWorkspace: string): EditOperations {
	const r = createReadOps(vm, localCwd, guestWorkspace);
	const w = createWriteOps(vm, localCwd, guestWorkspace);
	return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

export function createGondolinReadOps(vm: VM, localCwd: string, guestWorkspace: string): ReadOperations {
	return createReadOps(vm, localCwd, guestWorkspace);
}

export function createGondolinWriteOps(vm: VM, localCwd: string, guestWorkspace: string): WriteOperations {
	return createWriteOps(vm, localCwd, guestWorkspace);
}

export function createGondolinEditOps(vm: VM, localCwd: string, guestWorkspace: string): EditOperations {
	return createEditOps(vm, localCwd, guestWorkspace);
}

export function createGondolinBashOps(
	vm: VM,
	localCwd: string,
	guestWorkspace: string,
	envOptions: Omit<GuestEnvOptions, "hostEnv">,
): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const guestCwd = toGuestPath(localCwd, cwd, guestWorkspace);

			// Mirror the abort/timeout plumbing from pi's ssh-style operations
			const ac = new AbortController();
			const onAbort = () => ac.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			let timedOut = false;
			const timer =
				timeout && timeout > 0
					? setTimeout(() => {
							timedOut = true;
							ac.abort();
						}, timeout * 1000)
					: undefined;

			try {
				const proc = vm.exec(["/bin/bash", "-lc", command], {
					cwd: guestCwd,
					signal: ac.signal,
					env: buildGuestEnv({ ...envOptions, hostEnv: env }),
					stdout: "pipe",
					stderr: "pipe",
				});

				for await (const chunk of proc.output()) {
					onData(chunk.data);
				}

				const r = await proc;
				return { exitCode: r.exitCode };
			} catch (err) {
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				throw err;
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}
