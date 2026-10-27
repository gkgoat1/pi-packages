/**
 * radare2 — pi-durable entrypoint.
 *
 * Unlike the pi-coding-agent extension (long-lived r2pipe sessions over a
 * sandboxed process), the durable tools are *one-shot*: every call runs
 * `r2 -q -c <cmd>... -- <path>` through the conversation's execution
 * environment (`api.env`). That makes analysis work against any durable
 * environment — local Node, a Gondolin VM, or a relayed dev box — and leaves
 * sandboxing to the environment, which is the durable way. Sessions and the
 * Seatbelt/bwrap backends stay host-side (index.ts).
 *
 * Replay policy: the curated read-only tools are `replay: "safe"` (a rerun
 * after a restart just runs r2 again); `r2_cmd` is not, since raw commands
 * may patch the binary.
 */

import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { cleanReply } from "./src/r2client.ts";

export interface Radare2DurableOptions {
	/** r2 binary name/path resolved inside the environment. Default "r2". */
	r2Path?: string;
	/** Per-call exec timeout in seconds. Default 120. */
	timeoutSeconds?: number;
	/** Run `aaa` before query commands (functions/disassemble/strings/xrefs). Default true. */
	autoAnalyze?: boolean;
	/** Cap on returned output characters. Default 12_000. */
	maxOutputChars?: number;
}

const SUMMARY_LIMIT = 200;

/** One-shot r2 argv; analysis depth is expressed as -c commands, never aaj/aaaj (they hang some builds). */
export function r2OneshotArgv(
	location: string,
	commands: readonly string[],
	r2Path: string = "r2",
	evals: readonly string[] = [],
): string[] {
	return [
		r2Path,
		"-q",
		"-N",
		"-e", "scr.color=0",
		"-e", "scr.prompt=0",
		"-e", "bin.relocs.apply=true",
		...evals.flatMap((item) => ["-e", item]),
		...commands.flatMap((command) => ["-c", command]),
		"-c", "q",
		"--",
		location,
	];
}

async function runR2(
	api: ToolExecutionApi,
	options: Required<Radare2DurableOptions>,
	argv: readonly string[],
	context: Context,
): Promise<{ text: string; exitCode: number }> {
	const env = api.env;
	if (!env) throw new Error("r2 tools need an execution environment (HarnessOptions.env)");
	let output = "";
	const result = await env.exec(argv, { timeout: options.timeoutSeconds, onOutput: (text) => { output += text; } }, context);
	if (!result.ok) throw new Error(`r2 failed: ${result.error.code}: ${result.error.message}`);
	return { text: cleanReply(output), exitCode: result.value.exitCode };
}

function truncated(text: string, maxOutputChars: number): string {
	if (text.length <= maxOutputChars) return text;
	return `${text.slice(0, maxOutputChars)}\n\n[truncated at ${maxOutputChars} characters]`;
}

/** Commands for an analysis level; aa/aaa/aaaa only — never the j variants. */
function analysisCommand(level: "aa" | "aaa" | "aaaa"): string {
	return level;
}

export function createRadare2DurableExtension(options: Radare2DurableOptions = {}) {
	const resolved: Required<Radare2DurableOptions> = {
		r2Path: options.r2Path ?? "r2",
		timeoutSeconds: options.timeoutSeconds ?? 120,
		autoAnalyze: options.autoAnalyze ?? true,
		maxOutputChars: options.maxOutputChars ?? 12_000,
	};
	const prelude = (analyze?: boolean) => (analyze ?? resolved.autoAnalyze ? [analysisCommand("aaa")] : []);

	return defineExtension({
		name: "radare2",
		tools: [
			defineTool({
				name: "r2_analyze",
				description: "Analyze a binary with radare2 (one-shot, in the conversation's environment) and return a function summary.",
				parameters: Type.Object({
					path: Type.String({ description: "Path to the binary, as the environment sees it" }),
					level: Type.Optional(Type.Union([Type.Literal("aa"), Type.Literal("aaa"), Type.Literal("aaaa")], { description: "Analysis depth; default aaa" })),
				}),
				replay: "safe",
				execute: async (args, api, context) => {
					const argv = r2OneshotArgv(args.path, [analysisCommand(args.level ?? "aaa"), "aflj"], resolved.r2Path);
					const { text } = await runR2(api, resolved, argv, context);
					let count = 0;
					try {
						count = (JSON.parse(text) as unknown[]).length;
					} catch {
						count = 0;
					}
					return { output: [{ type: "text", text: `analysis complete: ${count} functions (${args.level ?? "aaa"})` }] };
				},
			}),
			defineTool({
				name: "r2_functions",
				description: "List analyzed functions (aflj) of a binary, with an optional name filter.",
				parameters: Type.Object({
					path: Type.String(),
					filter: Type.Optional(Type.String()),
					limit: Type.Optional(Type.Number()),
					analyze: Type.Optional(Type.Boolean({ description: "Run aaa first; default true" })),
				}),
				replay: "safe",
				execute: async (args, api, context) => {
					const argv = r2OneshotArgv(args.path, [...prelude(args.analyze), "aflj"], resolved.r2Path);
					const { text } = await runR2(api, resolved, argv, context);
					let functions: Array<Record<string, unknown>> = [];
					try {
						functions = JSON.parse(text) as Array<Record<string, unknown>>;
					} catch {
						functions = [];
					}
					const filter = args.filter?.toLowerCase();
					const filtered = filter ? functions.filter((f) => String(f.name ?? "").toLowerCase().includes(filter)) : functions;
					const limit = args.limit ?? SUMMARY_LIMIT;
					const lines = filtered.slice(0, limit).map((f) => `${String(f.name ?? "?")} (size ${f.realsz ?? f.size ?? "?"})${f.signature ? `  ${f.signature}` : ""}`);
					return {
						output: [{ type: "text", text: truncated(`functions: ${filtered.length}${filtered.length > limit ? ` (showing ${limit})` : ""}\n${lines.join("\n")}`, resolved.maxOutputChars) }],
					};
				},
			}),
			defineTool({
				name: "r2_disassemble",
				description: "Disassemble a function (pdf @ target) or N instructions at an address (pd N @ target).",
				parameters: Type.Object({
					path: Type.String(),
					target: Type.String({ description: "Function name or address" }),
					length: Type.Optional(Type.Number()),
					analyze: Type.Optional(Type.Boolean()),
				}),
				replay: "safe",
				execute: async (args, api, context) => {
					const target = args.target.replace(/[`\\]/g, "");
					const command = args.length !== undefined ? `pd ${args.length} @ ${target}` : `pdf @ ${target}`;
					const argv = r2OneshotArgv(args.path, [...prelude(args.analyze), command], resolved.r2Path);
					const { text } = await runR2(api, resolved, argv, context);
					return { output: [{ type: "text", text: truncated(text, resolved.maxOutputChars) }] };
				},
			}),
			defineTool({
				name: "r2_strings",
				description: "Extract strings (iz data sections, or izz whole binary) with length/limit filters.",
				parameters: Type.Object({
					path: Type.String(),
					wholeBin: Type.Optional(Type.Boolean()),
					minLength: Type.Optional(Type.Number()),
					limit: Type.Optional(Type.Number()),
				}),
				replay: "safe",
				execute: async (args, api, context) => {
					const argv = r2OneshotArgv(args.path, [args.wholeBin ? "izzj" : "izj"], resolved.r2Path);
					const { text } = await runR2(api, resolved, argv, context);
					let strings: Array<{ string?: string; vaddr?: number; length?: number }> = [];
					try {
						strings = JSON.parse(text) as Array<{ string?: string; vaddr?: number; length?: number }>;
					} catch {
						strings = [];
					}
					const minLength = args.minLength ?? 4;
					const limit = args.limit ?? 300;
					const filtered = strings.filter((s) => (s.length ?? s.string?.length ?? 0) >= minLength).slice(0, limit);
					const lines = filtered.map((s) => `${s.vaddr ?? "?"}  ${s.string ?? ""}`);
					return {
						output: [{ type: "text", text: truncated(`strings: ${filtered.length}${strings.length !== filtered.length ? ` (of ${strings.length})` : ""}\n${lines.join("\n")}`, resolved.maxOutputChars) }],
					};
				},
			}),
			defineTool({
				name: "r2_xrefs",
				description: "List cross-references to (callers) or from (callees) a function/address.",
				parameters: Type.Object({
					path: Type.String(),
					target: Type.String(),
					direction: Type.Union([Type.Literal("to"), Type.Literal("from")]),
					analyze: Type.Optional(Type.Boolean()),
				}),
				replay: "safe",
				execute: async (args, api, context) => {
					const target = args.target.replace(/[`\\]/g, "");
					const command = args.direction === "to" ? `axtj @ ${target}` : `axfj @ ${target}`;
					const argv = r2OneshotArgv(args.path, [...prelude(args.analyze), command], resolved.r2Path);
					const { text } = await runR2(api, resolved, argv, context);
					let refs: Array<{ from?: number; to?: number; type?: string }> = [];
					try {
						refs = JSON.parse(text) as Array<{ from?: number; to?: number; type?: string }>;
					} catch {
						refs = [];
					}
					const lines = refs.slice(0, SUMMARY_LIMIT).map((r) => `${r.type ?? "?"}  ${r.from ?? "?"} -> ${r.to ?? "?"}`);
					return { output: [{ type: "text", text: truncated(`xrefs (${args.direction} ${target}): ${refs.length}\n${lines.join("\n") || "(none — run analysis first)"}`, resolved.maxOutputChars) }] };
				},
			}),
			defineTool({
				name: "r2_cmd",
				description:
					"Run any raw radare2 command against a binary (escape hatch: flags, graphs, decompilers, patching). One-shot; each call is a fresh r2 process in the conversation's environment. Prefer the curated r2_* tools when they fit.",
				parameters: Type.Object({
					path: Type.String(),
					command: Type.String({ description: "A single r2 command; no newlines" }),
					analyze: Type.Optional(Type.Boolean()),
				}),
				// Raw commands may patch the binary: not replay-safe.
				execute: async (args, api, context) => {
					if (/[\r\n]/.test(args.command)) throw new Error("r2 command must not contain newlines (split into separate r2_cmd calls).");
					const argv = r2OneshotArgv(args.path, [...prelude(args.analyze), args.command], resolved.r2Path);
					const { text } = await runR2(api, resolved, argv, context);
					return { output: [{ type: "text", text: truncated(text, resolved.maxOutputChars) }] };
				},
			}),
		],
	});
}

export default createRadare2DurableExtension;
