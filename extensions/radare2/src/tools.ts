/**
 * r2_* tool definitions for the radare2 extension.
 *
 * Curated tools are conveniences over r2 commands; `r2_cmd` is the raw
 * escape hatch — per the resolved design any r2 command is allowed (`w`,
 * `!`, remote, …) because confinement happens in the OS sandbox, not here.
 */

import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Radare2Config } from "./config.ts";
import { truncateOutput, isWriteCommand } from "./policy.ts";
import type { SessionRegistry } from "./sessions.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface ToolDeps {
	config: Radare2Config;
	registry: SessionRegistry;
	openLocation: (
		location: string,
		signal: AbortSignal | undefined,
		analyze: boolean,
	) => Promise<{ handle: string; sandbox: string; info: string }>;
}

const HANDLE_PARAM = Type.String({ description: "Session handle returned by r2_open (e.g. r2-1)." });

function requireSession(deps: ToolDeps, handle: string) {
	const record = deps.registry.get(handle);
	if (!record) {
		throw new Error(`Unknown r2 session handle: ${handle}. Call r2_open first.`);
	}
	return record;
}

async function runCommand(
	deps: ToolDeps,
	handle: string,
	command: string,
	json: boolean,
): Promise<{ text: string; writeOp: boolean; truncated: boolean }> {
	const record = requireSession(deps, handle);
	const full = json ? `${command}j` : command;
	const raw = await record.session.cmd(full);
	const { text, truncated } = truncateOutput(raw, deps.config.maxOutputBytes);
	return { text: text || "(empty output)", writeOp: isWriteCommand(command), truncated };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const OpenSchema = Type.Object({
	path: Type.String({ description: "Binary file path to open, or a rap://tcp:// URI when allowRemote is enabled." }),
	analyze: Type.Optional(Type.Boolean({ description: "Run `aaa` analysis after opening (default: config autoAnalyze, currently true)." })),
	project: Type.Optional(Type.String({ description: "Save an r2 project (.r2) with this name after opening." })),
});

const AnalyzeSchema = Type.Object({
	handle: HANDLE_PARAM,
	level: Type.Union([
		Type.Literal("aa"),
		Type.Literal("aaa"),
		Type.Literal("aaaa"),
	], { description: "Analysis level (aa = symbols/entry, aaa = standard, aaaa = experimental)." }),
});

const FunctionsSchema = Type.Object({
	handle: HANDLE_PARAM,
	filter: Type.Optional(Type.String({ description: "Substring filter on function names." })),
	limit: Type.Optional(Type.Number({ description: "Max functions to return (default 200)." })),
});

const DisassembleSchema = Type.Object({
	handle: HANDLE_PARAM,
	target: Type.String({ description: "Function name (e.g. main, sym._add) or address (e.g. 0x100003f50)." }),
	json: Type.Optional(Type.Boolean({ description: "Return JSON disassembly (pdj) instead of text (pdf)." })),
	length: Type.Optional(Type.Number({ description: "Instruction count when the target is an address." })),
});

const StringsSchema = Type.Object({
	handle: HANDLE_PARAM,
	minLength: Type.Optional(Type.Number({ description: "Minimum string length (default 4)." })),
	limit: Type.Optional(Type.Number({ description: "Max strings to return (default 300)." })),
	wholeBin: Type.Optional(Type.Boolean({ description: "Scan the whole binary (izz) instead of only data sections (iz)." })),
});

const XrefsSchema = Type.Object({
	handle: HANDLE_PARAM,
	target: Type.String({ description: "Function name or address to get xrefs for." }),
	direction: Type.Union([Type.Literal("to"), Type.Literal("from")], { description: "to = callers (axt), from = callees (axf)." }),
});

const CmdSchema = Type.Object({
	handle: HANDLE_PARAM,
	command: Type.String({ description: "Any r2 command, e.g. `afl`, `iS`, `pdc @ main`, `wtf`, `axt @ sym._add`. `!` shell escapes run inside the sandbox (writes confined to workspace/tmp)." }),
	json: Type.Optional(Type.Boolean({ description: "Append `j` to the command and return parsed JSON." })),
});

const CloseSchema = Type.Object({ handle: HANDLE_PARAM });

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const SUMMARY_LIMIT = 200;

function summaryLine(label: string, count: number, sample: string[]): string {
	return `${label}: ${count}${sample.length > 0 ? ` (e.g. ${sample.slice(0, 3).join(", ")})` : ""}`;
}

export function registerR2Tools(pi: ExtensionAPI, deps: ToolDeps): void {
	// NOTE: deps.config/deps.registry are live getters — do not destructure
	// them here, the values only exist after the extension activates.
	void deps;
	const config = (): Radare2Config => deps.config;
	const registry = (): SessionRegistry => deps.registry;

	pi.registerTool({
		name: "r2_open",
		label: "r2: Open Binary",
		description:
			"Open a binary (ELF/Mach-O/PE) in a sandboxed radare2 session. Runs auto-analysis (`aaa`) by default and returns a session handle plus file info and function summary. Subsequent r2_* tools take the handle.",
		parameters: OpenSchema,
		async execute(_toolCallId, params, signal) {
			if (!config().allowRemote && /^[a-z]+:\/\//i.test(params.path) && !/^(file|rap|tcp):\/\//i.test(params.path)) {
				throw new Error(`Unsupported location scheme: ${params.path}`);
			}
			if (!config().allowRemote && /^(rap|tcp):\/\//i.test(params.path)) {
				throw new Error("Remote locations are disabled (allowRemote=false in radare2.json).");
			}
			const project = params.project;
			if (project && !config().allowProjects) {
				throw new Error("r2 projects are disabled (allowProjects=false in radare2.json).");
			}
			if (project && /[\r\n;`]/.test(project)) {
				throw new Error("project name must not contain ; \n or backticks");
			}
			const analyze = params.analyze ?? config().autoAnalyze;
			const result = await deps.openLocation(params.path, signal, analyze);
			let extra = "";
			if (project) {
				const record = registry().get(result.handle);
				await record?.session.cmd(`Ps ${project}`);
				extra = `\nproject saved: ${project}`;
			}
			return {
				content: [{ type: "text", text: `${result.info}${extra}\n\nUse this handle in r2_* tools: ${result.handle} (sandbox: ${result.sandbox})` }],
				details: { handle: result.handle, sandbox: result.sandbox },
			};
		},
	});

	pi.registerTool({
		name: "r2_analyze",
		label: "r2: Analyze",
		description: "Run r2 analysis at the requested level on an open session and return a function-count summary.",
		parameters: AnalyzeSchema,
		async execute(_toolCallId, params, signal) {
			requireSession(deps, params.handle);
			const record = registry().get(params.handle)!;
			await record.session.cmd(params.level);
			const functions = await record.session.cmdj<Array<{ name: string }>>("afl").catch(() => []);
			return {
				content: [{ type: "text", text: summaryLine(`functions after ${params.level}`, functions.length, functions.map((f) => f.name)) }],
				details: { count: functions.length },
			};
		},
	});

	pi.registerTool({
		name: "r2_functions",
		label: "r2: List Functions",
		description: "List analyzed functions (aflj) with an optional name filter.",
		parameters: FunctionsSchema,
		async execute(_toolCallId, params, signal) {
			const record = requireSession(deps, params.handle);
			const all = await record.session.cmdj<Array<Record<string, unknown>>>('afl').catch(() => []);
			const filter = params.filter?.toLowerCase();
			const filtered = filter
				? all.filter((f) => String(f.name ?? "").toLowerCase().includes(filter))
				: all;
			const limit = params.limit ?? SUMMARY_LIMIT;
			const lines = filtered.slice(0, limit).map((f) => {
				const name = String(f.name ?? "?");
				const size = f.realsz ?? f.size ?? "?";
				const sig = f.signature ? `  ${f.signature}` : "";
				return `${name} (size ${size})${sig}`;
			});
			const { text, truncated } = truncateOutput(lines.join("\n"), config().maxOutputBytes);
			const header = `functions: ${filtered.length}${filtered.length > limit ? ` (showing ${limit})` : ""}\n`;
			return {
				content: [{ type: "text", text: header + text }],
				details: { count: filtered.length, truncated: truncated || filtered.length > limit },
			};
		},
	});

	pi.registerTool({
		name: "r2_disassemble",
		label: "r2: Disassemble",
		description: "Disassemble a function (pdf) or address (pd N @ target).",
		parameters: DisassembleSchema,
		async execute(_toolCallId, params, signal) {
			const target = params.target.replace(/[`\\]/g, "");
			const command = params.length
				? `pd ${params.length} @ ${target}`
				: `pdf @ ${target}`;
			const result = await runCommand(deps, params.handle, command, params.json === true);
			return {
				content: [{ type: "text", text: result.text }],
				details: { writeOp: result.writeOp, truncated: result.truncated },
			};
		},
	});

	pi.registerTool({
		name: "r2_strings",
		label: "r2: Strings",
		description: "Extract strings (iz data sections, or izz whole binary) with length/limit filters.",
		parameters: StringsSchema,
		async execute(_toolCallId, params, signal) {
			const record = requireSession(deps, params.handle);
			const cmd = params.wholeBin ? "izz" : "iz";
			const all = await record.session
				.cmdj<Array<{ string?: string; vaddr?: number; length?: number }>>(cmd)
				.catch(() => []);
			const minLength = params.minLength ?? 4;
			const limit = params.limit ?? 300;
			const filtered = all
				.filter((s) => (s.length ?? s.string?.length ?? 0) >= minLength)
				.slice(0, limit)
				.map((s) => `${s.vaddr ?? "?"}  ${s.string ?? ""}`);
			const { text, truncated } = truncateOutput(filtered.join("\n"), config().maxOutputBytes);
			return {
				content: [{ type: "text", text: `strings: ${filtered.length}${all.length !== filtered.length ? ` (of ${all.length})` : ""}\n${text}` }],
				details: { count: filtered.length, truncated },
			};
		},
	});

	pi.registerTool({
		name: "r2_xrefs",
		label: "r2: Xrefs",
		description: "List cross-references to (axtj, callers) or from (axfj, callees) a function/address.",
		parameters: XrefsSchema,
		async execute(_toolCallId, params, signal) {
			const target = params.target.replace(/[`\\]/g, "");
			const cmd = params.direction === "to" ? "axt" : "axf";
			const record = requireSession(deps, params.handle);
			const refs = await record.session
				.cmdj<Array<{ from?: number; to?: number; type?: string }>>(`${cmd} @ ${target}`)
				.catch(() => []);
			const lines = refs.slice(0, SUMMARY_LIMIT).map((r) => `${r.type ?? "?"}  ${r.from ?? "?"} -> ${r.to ?? "?"}`);
			return {
				content: [{ type: "text", text: `xrefs (${params.direction} ${target}): ${refs.length}\n${lines.join("\n") || "(none — run analysis first)"}` }],
				details: { count: refs.length },
			};
		},
	});

	pi.registerTool({
		name: "r2_cmd",
		label: "r2: Command",
		description:
			"Run any raw r2 command in an open session (escape hatch: flags, graphs, decompilers, patching). The process is OS-sandboxed: writes are confined to the workspace/tmp and secret reads are blocked; `!` shell escapes inherit that confinement. Use curated r2_* tools when they fit.",
		parameters: CmdSchema,
		async execute(_toolCallId, params, signal) {
			if (/[\r\n]/.test(params.command)) {
				throw new Error("r2 command must not contain newlines (split into separate r2_cmd calls).");
			}
			const result = await runCommand(deps, params.handle, params.command, params.json === true);
			return {
				content: [{ type: "text", text: result.text }],
				details: { command: params.command, writeOp: result.writeOp, truncated: result.truncated },
			};
		},
	});

	pi.registerTool({
		name: "r2_close",
		label: "r2: Close Session",
		description: "Close an open radare2 session (quits the sandboxed r2 process without saving).",
		parameters: CloseSchema,
		async execute(_toolCallId, params, signal) {
			const closed = await registry().close(params.handle);
			return {
				content: [{ type: "text", text: closed ? `closed ${params.handle}` : `unknown handle: ${params.handle}` }],
				details: { closed },
			};
		},
	});
}
