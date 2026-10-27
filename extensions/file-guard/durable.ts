/**
 * File Guard — pi-durable entrypoint.
 *
 * Exposes the guard's core policy (path extraction + allowed-set matching) as
 * a durable extension: a `ToolTask` hook guards every tool call (model-issued
 * and nested), and a prompt section lists the allowed paths. Unlike the
 * pi-coding-agent extension, durable hooks cannot open interactive dialogs,
 * so guard decisions fail closed unless the host supplies an `approve` hook
 * (a UI, a policy service, a message queue). Approvals are remembered per
 * conversation for the process lifetime; a restart re-asks. This module is
 * runtime-agnostic (no Node imports), so it also works in Worker-hosted
 * harnesses.
 */

import { AgentDoc, defineExtension, hook, section, ToolTask, type ConversationId, type HookApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { extractToolPaths } from "./src/extract-paths.ts";
import { globMatch } from "./src/paths-pure.ts";

/** Result of a host approval: allow once, allow and remember for the conversation ("session"), or deny. */
export type GuardApproval = boolean | "session";

export interface GuardApprovalRequest {
	tool: string;
	/** Why the guard looked at this call (e.g. "bash tool", "read tool"). */
	reason: string;
	/** Paths outside the allowed set, as the tool call named them. */
	paths: string[];
	arguments: Record<string, unknown>;
	/** True when another tool made this call through `executeTool()`. */
	nested: boolean;
}

export type GuardApprover = (
	request: GuardApprovalRequest,
	api: HookApi,
	context: Context,
) => GuardApproval | Promise<GuardApproval>;

export interface FileGuardViewEntry {
	phase: "decision" | "result";
	tool: string;
	timestamp: number;
	paths: string[];
	/** Decision entries only. */
	decision?: "allowed" | "approved" | "blocked" | "denied";
	/** Result entries only. */
	isError?: boolean;
	nested: boolean;
}

export interface FileGuardDurableOptions {
	/** Master switch; the extension no-ops until true. Default false. */
	enabled?: boolean;
	/** Guard mode: calls touching paths outside the allowed set need approval or block. Default true. */
	guardEnabled?: boolean;
	/** View mode: report guard decisions and tool results to `onView`. Default false. */
	viewMode?: boolean;
	/**
	 * Allowed globs and directories, `.piinclude`-style. Relative entries resolve
	 * against the conversation's agent `cwd`. `~` is not expanded (a durable host
	 * has no meaningful home directory). A pattern without glob magic also covers
	 * everything below it as a directory.
	 */
	allowedPaths?: readonly string[];
	/**
	 * Host approval hook, called once per blocked call. Return `true` to allow
	 * this call, `"session"` to allow and remember every listed path for this
	 * conversation, `false`/`undefined` to block (remembered as denied for the
	 * conversation). Without it the guard fails closed.
	 */
	approve?: GuardApprover;
	/** View-mode sink; the host persists or renders entries. */
	onView?: (entry: FileGuardViewEntry, conversationId: ConversationId, context: Context) => void;
}

const HAS_MAGIC = /[*?[\]{}]/;

function normalizeSlashes(p: string): string {
	return p.replace(/\\/g, "/");
}

function isAbsolutePath(p: string): boolean {
	return p.startsWith("/") || /^[A-Za-z]:\//.test(p);
}

/** Resolve `input` against `cwd` with POSIX semantics, folding `.`/`..`; no symlink resolution. */
export function resolveGuardPath(input: string, cwd: string): string {
	const slashed = normalizeSlashes(input);
	const joined = isAbsolutePath(slashed) ? slashed : `${normalizeSlashes(cwd).replace(/\/+$/, "")}/${slashed}`;
	const drive = joined.match(/^[A-Za-z]:/)?.[0] ?? "";
	const rest = drive ? joined.slice(drive.length) : joined;
	const absolute = rest.startsWith("/");
	const out: string[] = [];
	for (const part of rest.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (out.length > 0) out.pop();
			continue;
		}
		out.push(part);
	}
	return `${drive}${absolute ? "/" : ""}${out.join("/")}`;
}

function relativeTo(cwd: string, absPath: string): string | undefined {
	const root = resolveGuardPath(cwd, "/");
	return absPath === root ? "." : absPath.startsWith(`${root}/`) ? absPath.slice(root.length + 1) : undefined;
}

function patternAllows(pattern: string, absPath: string, rawInput: string, cwd: string): boolean {
	const p = normalizeSlashes(pattern);
	if (!HAS_MAGIC.test(p)) {
		const target = resolveGuardPath(p, cwd);
		return absPath === target || absPath.startsWith(`${target}/`);
	}
	if (globMatch(p, absPath) || globMatch(p, normalizeSlashes(rawInput))) return true;
	const rel = relativeTo(cwd, absPath);
	if (rel !== undefined && globMatch(p, rel)) return true;
	const base = absPath.split("/").pop();
	return base !== undefined && globMatch(p, base);
}

interface SessionDecisions {
	allowed: Set<string>;
	denied: Set<string>;
}

export function createFileGuardDurableExtension(options: FileGuardDurableOptions = {}) {
	const enabled = options.enabled === true;
	const guardEnabled = options.guardEnabled !== false;
	const viewMode = options.viewMode === true;
	const allowedPaths = options.allowedPaths ?? [];
	/** Process-lifetime decisions, keyed by conversation id. */
	const sessions = new Map<ConversationId, SessionDecisions>();

	const decisionsFor = (conversationId: ConversationId): SessionDecisions => {
		let session = sessions.get(conversationId);
		if (!session) {
			session = { allowed: new Set(), denied: new Set() };
			sessions.set(conversationId, session);
		}
		return session;
	};

	const emitView = (entry: FileGuardViewEntry, api: HookApi, context: Context): void => {
		if (!viewMode) return;
		try {
			options.onView?.(entry, api.conversationId, context);
		} catch {
			// A view sink must never break tool execution.
		}
	};

	const cwdOf = async (api: HookApi, context: Context): Promise<string> => {
		const agent = await api.snapshot(AgentDoc, api.conversationId, context);
		return agent?.cwd ?? "/";
	};

	const extension = defineExtension({
		name: "file-guard",
		sections: [
			section("file-guard", () => {
				if (!enabled || !guardEnabled) return undefined;
				const lines = [
					"Filesystem access is guarded: tool calls may only touch paths matching the allowed patterns below; other paths are blocked or require host approval.",
					"Allowed path patterns:",
					...(allowedPaths.length > 0 ? allowedPaths.map((p) => `- ${p}`) : ["(none)"]),
					options.approve
						? "Access outside this set may be approved by the host per call or for the session."
						: "Paths outside this set are blocked; do not retry them with alternate tools.",
				];
				return lines.join("\n");
			}),
		],
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, context) => {
					if (!enabled) return undefined;
					const extracted = extractToolPaths(call.name, call.arguments, "");
					const paths = extracted?.paths ?? [];
					if (!guardEnabled || paths.length === 0) {
						emitView(
							{ phase: "decision", tool: call.name, timestamp: Date.now(), paths, decision: "allowed", nested: call.parent !== undefined },
							api,
							context,
						);
						return undefined;
					}
					const cwd = await cwdOf(api, context);
					const session = decisionsFor(api.conversationId);
					const deniedEarlier: string[] = [];
					const needsDecision: string[] = [];
					for (const raw of paths) {
						const abs = resolveGuardPath(raw, cwd);
						if (session.denied.has(abs)) {
							deniedEarlier.push(raw);
							continue;
						}
						if (session.allowed.has(abs)) continue;
						if (allowedPaths.some((p) => patternAllows(p, abs, raw, cwd))) continue;
						needsDecision.push(raw);
					}
					if (deniedEarlier.length > 0) {
						emitView(
							{ phase: "decision", tool: call.name, timestamp: Date.now(), paths: deniedEarlier, decision: "denied", nested: call.parent !== undefined },
							api,
							context,
						);
						return { block: `File Guard: denied earlier this session: ${deniedEarlier.join(", ")}` };
					}
					if (needsDecision.length === 0) {
						emitView(
							{ phase: "decision", tool: call.name, timestamp: Date.now(), paths, decision: "allowed", nested: call.parent !== undefined },
							api,
							context,
						);
						return undefined;
					}
					const approver = options.approve;
					if (!approver) {
						emitView(
							{ phase: "decision", tool: call.name, timestamp: Date.now(), paths: needsDecision, decision: "blocked", nested: call.parent !== undefined },
							api,
							context,
						);
						return {
							block: `File Guard: ${call.name} touches paths outside the allowed set: ${needsDecision.join(", ")}. No host approval hook is configured, so the call is blocked.`,
						};
					}
					const approval = await approver(
						{
							tool: call.name,
							reason: extracted?.reason ?? `${call.name} tool`,
							paths: needsDecision,
							arguments: call.arguments as Record<string, unknown>,
							nested: call.parent !== undefined,
						},
						api,
						context,
					);
					if (approval === true || approval === "session") {
						if (approval === "session") for (const raw of needsDecision) session.allowed.add(resolveGuardPath(raw, cwd));
						emitView(
							{ phase: "decision", tool: call.name, timestamp: Date.now(), paths: needsDecision, decision: "approved", nested: call.parent !== undefined },
							api,
							context,
						);
						return undefined;
					}
					for (const raw of needsDecision) session.denied.add(resolveGuardPath(raw, cwd));
					emitView(
						{ phase: "decision", tool: call.name, timestamp: Date.now(), paths: needsDecision, decision: "blocked", nested: call.parent !== undefined },
						api,
						context,
					);
					return { block: `File Guard: access denied by the host approval hook: ${needsDecision.join(", ")}` };
				},
				afterTool: (call, result, api, context) => {
					if (!enabled) return undefined;
					const paths = extractToolPaths(call.name, call.arguments, "")?.paths ?? [];
					emitView(
						{ phase: "result", tool: call.name, timestamp: Date.now(), paths, isError: result.isError === true, nested: call.parent !== undefined },
						api,
						context,
					);
					return undefined;
				},
			}),
		],
	});
	return extension;
}

export default createFileGuardDurableExtension;
