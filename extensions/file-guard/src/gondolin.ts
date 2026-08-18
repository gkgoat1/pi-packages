/**
 * Gondolin interception mode for File Guard.
 *
 * When both File Guard (guard or view mode) and the Gondolin sandbox
 * extension are enabled, File Guard stops restricting tools: the sandbox
 * already runs read/write/edit/bash inside the VM, so guarding the *tools*
 * again would only duplicate prompts (or worse, replace the VM-backed tools
 * with host-backed ones). Instead, File Guard registers a VM-filesystem
 * guard on the shared Gondolin handle:
 *
 * - guard mode: operations on paths outside the allowed set are denied at the
 *   filesystem layer (`EACCES` inside the guest). This covers every access
 *   path — tool operations, shell commands, anything the guest does to the
 *   mounted host workspace. The user is prompted exactly like in tool mode,
 *   and decisions persist for the session.
 * - view mode: mutating operations against the workspace are logged as
 *   timeline entries, same as tool mode.
 *
 * The host-side grep/find/ls tools do not run in the VM, so they keep the
 * regular tool-level guard.
 *
 * This module must not import from the Gondolin extension (separately bundled
 * extensions stay dependency-free). It mirrors the minimal structural
 * contract from `extensions/gondolin/src/shared.ts`; the values are matched
 * at runtime through the shared registered symbol, so both bundles agree
 * without sharing code.
 */

import { relative } from "node:path";

/** Registered symbol under which Gondolin publishes its shared handle. */
export const GONDOLIN_SHARED_KEY = Symbol.for("pi-packages.gondolin.shared");

/** Filesystem operation reaching the mounted host workspace (contract copy). */
export interface VmFsRequest {
	op: string;
	guestPath: string;
	hostPath: string;
	write: boolean;
}

export interface VmFsDecision {
	reason: string;
}

export interface VmFsGuard {
	before?(request: VmFsRequest): Promise<VmFsDecision | undefined>;
	after?(request: VmFsRequest): Promise<void>;
}

/** Structural subset of Gondolin's shared handle that File Guard relies on. */
export interface GondolinHandle {
	readonly version: 1;
	readonly hostCwd: string;
	readonly guestWorkspace: string;
	isEnabled(): boolean;
	refreshTrust(isProjectTrusted: boolean): boolean;
	registerFsGuard(guard: VmFsGuard): () => void;
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

/** Tools the Gondolin extension runs inside the VM (guarded by interception). */
export const VM_TOOLS = ["read", "write", "edit", "bash"] as const;

export function isVmTool(toolName: string): boolean {
	return (VM_TOOLS as readonly string[]).includes(toolName);
}

export interface VmGuardLogger {
	logGuard(
		toolName: string,
		toolCallId: undefined,
		status: "blocked" | "allowed" | "auto-allowed" | "user-denied",
		params: unknown,
		ctx: { cwd: string },
		note?: string,
	): void;
}

export interface VmGuardDeps {
	/** Host working directory (used for view-log context). */
	cwd: string;
	/** Allowed-set policy checks (AllowedSet). */
	isAllowed(path: string): boolean;
	isDenied(path: string): boolean;
	/** Prompt queue; records the user's decision into the allowed set. */
	prompt(toolName: string, description: string, paths: string[], contextSummary?: string): Promise<boolean>;
	/** Optional view-mode logger. */
	view?: VmGuardLogger;
	/** Optional UI notifier for denials. */
	notify?(message: string, level: "info" | "warning"): void;
	/** Whether a UI is available for prompts. */
	hasUI: boolean;
	/** Non-interactive default policy ("allow" passes, "prompt"/"deny" block). */
	defaultPolicy: "prompt" | "allow" | "deny";
}

/**
 * Build the filesystem guard registered on the Gondolin shared handle.
 * Pure logic over the injected dependencies, so it is unit-testable without
 * a VM.
 */
export function createVmFsGuard(deps: VmGuardDeps): VmFsGuard {
	const ctxLike = { cwd: deps.cwd };
	const paramsFor = (request: VmFsRequest) => ({
		op: request.op,
		path: request.guestPath,
		write: request.write,
	});

	return {
		async before(request) {
			// Include patterns are frequently workspace-relative ("src/**"), while
			// the VM guard only ever sees absolute host paths. Classic tool mode
			// matched both because tool params are often relative; check both forms
			// here so relative includes keep working under interception.
			const relPath = relative(deps.cwd, request.hostPath);
			const relInside = relPath !== "" && !relPath.startsWith("..") && !relPath.includes(":");
			// Reads of Gondolin's extra mounts (skills and other host folders
			// outside the workspace) are allowed by construction: they are mounted
			// read-only unless the user granted rw in *global* config, and writes
			// are still mediated below. Blocking reads would make skills unusable
			// inside the sandbox.
			if (!request.write && !relInside && request.hostPath !== deps.cwd) return undefined;
			const allowed =
				deps.isAllowed(request.hostPath) || (relInside && deps.isAllowed(relPath));
			if (allowed) return undefined;

			let reason: string | undefined;
			let status: "blocked" | "user-denied";

			if (deps.isDenied(request.hostPath) || (relInside && deps.isDenied(relPath))) {
				reason = `${request.hostPath} was previously denied`;
				status = "blocked";
			} else if (!deps.hasUI) {
				if (deps.defaultPolicy === "allow") return undefined;
				reason = `no UI available to confirm ${request.op} on ${request.hostPath}`;
				status = "blocked";
			} else {
				const description = `${request.op} ${request.guestPath}${request.write ? " (write)" : ""}`;
				const approved = await deps.prompt("vm-fs", description, [request.hostPath]);
				if (approved) {
					deps.view?.logGuard(
						`vm-fs:${request.op}`,
						undefined,
						"allowed",
						paramsFor(request),
						ctxLike,
						"user allowed via prompt",
					);
					return undefined;
				}
				reason = `user denied ${request.hostPath}`;
				status = "user-denied";
			}

			deps.view?.logGuard(`vm-fs:${request.op}`, undefined, status, paramsFor(request), ctxLike, reason);
			deps.notify?.(
				`File Guard blocked ${request.op} ${request.guestPath} in the sandbox VM: ${reason}`,
				"warning",
			);
			return { reason };
		},

		async after(request) {
			// View mode: log mutating operations; per-op read logging would be
			// noise at filesystem granularity (one tool call touches many paths).
			if (!deps.view || !request.write) return;
			deps.view.logGuard(
				`vm-fs:${request.op}`,
				undefined,
				"auto-allowed",
				paramsFor(request),
				ctxLike,
				"sandbox VM filesystem",
			);
		},
	};
}

/**
 * Whether File Guard should switch to VM interception: both this extension's
 * guard mode and the Gondolin sandbox must be enabled.
 */
export function isInterceptionActive(gondolinEnabled: boolean, guardEnabled: boolean): boolean {
	return gondolinEnabled && guardEnabled;
}
