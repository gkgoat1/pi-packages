/**
 * Deterministic + optional LLM enrichment for view mode and guard prompts.
 */

import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { analyseCommand } from "./bash.ts";
import { normalizePath, shortenPath } from "./paths.ts";
import type { EnrichedContext, RiskLevel, ViewEnrichmentConfig } from "./types.ts";

const HIGH_RISK_COMMANDS = new Set([
	"rm",
	"rmdir",
	"chmod",
	"chown",
	"mv",
	"mkfs",
	"dd",
	"curl",
	"wget",
	"shred",
	"format",
]);

const SENSITIVE_CONTENT_PATTERNS = [
	/password\s*[:=]/i,
	/api[_-]?key\s*[:=]/i,
	/secret\s*[:=]/i,
	/token\s*[:=]/i,
	/private[_-]?key/i,
	/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

function truncate(str: string, max: number): string {
	if (str.length <= max) return str;
	return `${str.slice(0, max)}…`;
}

function* matchRiskPatterns(filePath: string, cwd: string, patterns: string[] = []): Generator<string> {
	if (patterns.length === 0) return;
	const abs = normalizePath(filePath, cwd);
	const base = path.basename(abs);
	for (const p of patterns) {
		const regex = globToRegex(p);
		if (regex.test(base) || regex.test(abs)) yield p;
	}
}

function globToRegex(pattern: string): RegExp {
	let regex = "";
	let i = 0;
	while (i < pattern.length) {
		const c = pattern[i];
		if (c === "*" && pattern[i + 1] === "*") {
			regex += ".*";
			i += 2;
		} else if (c === "*") {
			regex += "[^/]*";
			i++;
		} else if (c === "?") {
			regex += "[^/]";
			i++;
		} else if ("+.^$|()[]{}\\".includes(c)) {
			regex += "\\" + c;
			i++;
		} else {
			regex += c;
			i++;
		}
	}
	return new RegExp(regex, "i");
}

function readFilePreview(filePath: string, charBudget: number): string | undefined {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return truncate(raw, charBudget);
	} catch {
		return undefined;
	}
}

function fileExists(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function looksSensitive(text: string): boolean {
	return SENSITIVE_CONTENT_PATTERNS.some((re) => re.test(text));
}

function classifyBashRisk(command: string): { risk: RiskLevel; notes: string[] } {
	const analyses = analyseCommand(command);
	const notes: string[] = [];
	let risk: RiskLevel = "safe";
	for (const a of analyses) {
		if (HIGH_RISK_COMMANDS.has(a.command)) {
			risk = "mutate";
			notes.push(`uses ${a.command}`);
		} else if (a.command === "cp" || a.command === "touch" || a.command === "mkdir") {
			if (risk === "safe") risk = "write";
			notes.push(`${a.command} creates or overwrites files`);
		} else if (a.command === "tar" || a.command === "zip") {
			if (risk === "safe") risk = "write";
			notes.push(`${a.command} may write archives`);
		} else if (a.knownFile && !a.knownSafe) {
			if (risk === "safe") risk = "read";
		} else if (!a.knownSafe && a.command) {
			if (risk === "safe") risk = "unknown";
			notes.push(`${a.command} is not a known-safe command`);
		}
	}
	if (/[><|]/.test(command) && risk === "safe") {
		risk = "write";
		notes.push("shell redirection may write files");
	}
	return { risk, notes };
}

function buildEnrichmentPrompt(toolName: string, params: unknown, deterministic: EnrichedContext, cwd: string): string {
	const input = (params ?? {}) as Record<string, unknown>;
	const rawParams = truncate(JSON.stringify(input), 3000);

	let contextBlock = `Operation: ${toolName}\n`;
	contextBlock += `Deterministic risk: ${deterministic.risk}\n`;
	contextBlock += `Affected files: ${deterministic.affectedFiles.join(", ") || "(none)"}\n`;
	if (deterministic.notes.length > 0) {
		contextBlock += `Notes: ${deterministic.notes.join("; ")}\n`;
	}
	contextBlock += `Params: ${rawParams}\n`;

	if ((toolName === "write" || toolName === "edit") && typeof input.path === "string") {
		const abs = normalizePath(input.path as string, cwd);
		if (fileExists(abs)) {
			const before = readFilePreview(abs, deterministic.affectedFiles.length > 0 ? 1200 : 2000);
			if (before !== undefined) contextBlock += `Existing file content:\n\`\`\`\n${before}\n\`\`\`\n`;
		} else {
			contextBlock += "The target file does not exist yet.\n";
		}
		if (toolName === "edit" && Array.isArray(input.edits)) {
			contextBlock += `Edits:\n${JSON.stringify(input.edits).slice(0, 1000)}\n`;
		} else if (typeof input.content === "string") {
			contextBlock += `New content preview:\n${truncate(input.content as string, 1200)}\n`;
		}
	}

	if (toolName === "bash" && typeof input.command === "string") {
		contextBlock += `Bash command: ${input.command}\n`;
	}

	return `${contextBlock}\nReturn ONLY valid JSON matching this schema (no markdown, no prose):\n` +
		`{ "risk": "safe|read|write|mutate", "intent": "one-line summary", "notes": ["..."], "affectedFiles": ["..."], "snippet": "up to 150 chars" }`;
}

async function callEnrichmentModel(
	ctx: ExtensionContext,
	config: ViewEnrichmentConfig,
	prompt: string,
): Promise<Partial<EnrichedContext> | undefined> {
	if (!ctx.model) return undefined;

	const target = config.model?.id
		? ctx.modelRegistry.find(config.model.provider ?? ctx.model.provider, config.model.id) ?? ctx.model
		: ctx.model;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(target);
	if (!auth.ok || !auth.apiKey) return undefined;

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: prompt }],
		timestamp: Date.now(),
	};

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

	try {
		const response = await complete(
			target,
			{
				systemPrompt:
					"You are a concise security classifier. Given a file operation and its parameters, classify risk and summarize intent. " +
					"Output valid JSON only. Keep all fields short.",
				messages: [userMessage],
			},
			{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: controller.signal, timeoutMs: config.timeoutMs },
		);
		if (response.stopReason !== "stop") return undefined;
		const raw = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim();
		const jsonMatch = raw.match(/\{[\s\S]*\}/);
		if (!jsonMatch) return undefined;
		const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
		const riskStr = String(parsed.risk ?? "").toLowerCase();
		const result: Partial<EnrichedContext> = {};
		if (["safe", "read", "write", "mutate", "unknown"].includes(riskStr)) {
			result.risk = riskStr as RiskLevel;
		}
		if (typeof parsed.intent === "string") result.intent = parsed.intent;
		if (Array.isArray(parsed.notes)) {
			result.notes = parsed.notes.filter((n): n is string => typeof n === "string");
		}
		if (Array.isArray(parsed.affectedFiles)) {
			result.affectedFiles = parsed.affectedFiles.filter((f): f is string => typeof f === "string");
		}
		if (typeof parsed.snippet === "string") result.snippet = parsed.snippet;
		return result;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

function deterministicEnrichment(
	toolName: string,
	params: unknown,
	cwd: string,
	config: ViewEnrichmentConfig | undefined,
): EnrichedContext {
	const input = (params ?? {}) as Record<string, unknown>;
	const notes: string[] = [];
	const affectedFiles: string[] = [];
	let risk: RiskLevel = "unknown";
	let snippet: string | undefined;
	let diff: string | undefined;
	const patterns = config?.riskPatterns ?? [];

	function touchPath(p: string, role: "source" | "target") {
		affectedFiles.push(p);
		for (const _ of matchRiskPatterns(p, cwd, patterns)) {
			notes.push(`touches sensitive path ${shortenPath(normalizePath(p, cwd), cwd)}`);
		}
	}

	switch (toolName) {
		case "read": {
			risk = "read";
			const filePath = String(input.path ?? "");
			if (filePath) {
				touchPath(filePath, "source");
				const preview = readFilePreview(normalizePath(filePath, cwd), 120);
				snippet = preview !== undefined ? `first lines: ${preview.slice(0, 120)}` : "file not found or unreadable";
			}
			break;
		}
		case "write": {
			risk = "write";
			const filePath = String(input.path ?? "");
			const content = String(input.content ?? "");
			if (filePath) {
				touchPath(filePath, "target");
				const abs = normalizePath(filePath, cwd);
				if (fileExists(abs)) {
					notes.push("overwrites existing file");
					const before = readFilePreview(abs, 400);
					diff = before !== undefined
						? `existing content:\n${truncate(before, 400)}`
						: "existing file unreadable";
				} else {
					notes.push("creates new file");
				}
			}
			if (content) {
				if (looksSensitive(content)) notes.push("new content contains credential-like patterns");
				snippet = `new content preview: ${truncate(content, 200)}`;
			}
			break;
		}
		case "edit": {
			risk = "write";
			const filePath = String(input.path ?? "");
			const edits = Array.isArray(input.edits) ? input.edits : [];
			if (filePath) {
				touchPath(filePath, "target");
				const abs = normalizePath(filePath, cwd);
				const before = readFilePreview(abs, 600);
				if (before !== undefined) snippet = `current file preview: ${truncate(before, 300)}`;
			}
			const editPreviews: string[] = [];
			for (const edit of edits) {
				if (!edit || typeof edit !== "object") continue;
				const e = edit as Record<string, unknown>;
				const oldText = String(e.oldText ?? "");
				const newText = String(e.newText ?? "");
				if (oldText || newText) {
					editPreviews.push(`- ${truncate(oldText, 80)} → ${truncate(newText, 80)}`);
				}
				if (looksSensitive(newText)) notes.push("edit introduces credential-like patterns");
			}
			if (editPreviews.length > 0) diff = `edits:\n${editPreviews.join("\n")}`;
			break;
		}
		case "bash": {
			const command = String(input.command ?? "");
			const classification = classifyBashRisk(command);
			risk = classification.risk;
			notes.push(...classification.notes);
			snippet = truncate(command, 200);
			for (const a of analyseCommand(command)) {
				for (const p of a.paths) touchPath(p, "target");
			}
			break;
		}
		case "grep":
		case "find":
		case "ls": {
			risk = "read";
			const filePath = String(input.path ?? ".");
			touchPath(filePath, "source");
			break;
		}
		default: {
			risk = "unknown";
			const rawPath = input.path;
			const paths = typeof rawPath === "string" ? [rawPath] : Array.isArray(rawPath) ? rawPath : [];
			for (const p of paths) if (typeof p === "string") touchPath(p, "target");
		}
	}

	return {
		risk,
		notes,
		intent: undefined,
		snippet,
		diff,
		affectedFiles: [...new Set(affectedFiles)],
		modelEnriched: false,
	};
}

export function formatEnrichedSummary(enriched: EnrichedContext, baseSummary?: string): string {
	const lines: string[] = [];
	if (baseSummary) lines.push(baseSummary);
	lines.push(`risk: ${enriched.risk}${enriched.modelEnriched ? " (model)" : ""}`);
	if (enriched.intent) lines.push(`intent: ${enriched.intent}`);
	if (enriched.notes.length > 0) lines.push(enriched.notes.join("; "));
	if (enriched.snippet) lines.push(`preview: ${enriched.snippet}`);
	else if (enriched.diff) lines.push(`preview: ${enriched.diff}`);
	return lines.join("\n");
}

export class ContextEnricher {
	private cache = new Map<string, Promise<EnrichedContext>>();

	constructor(
		private ctx: ExtensionContext,
		private config: ViewEnrichmentConfig | undefined,
	) {}

	updateContext(ctx: ExtensionContext): void {
		this.ctx = ctx;
	}

	private shouldEnrich(): boolean {
		return Boolean(this.config?.enabled);
	}

	private enrichKey(toolCallId: string | undefined, toolName: string): string {
		return toolCallId ?? `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	}

	enrich(toolCallId: string | undefined, toolName: string, params: unknown): Promise<EnrichedContext> {
		if (!this.shouldEnrich()) {
			return Promise.resolve(deterministicEnrichment(toolName, params, this.ctx.cwd, this.config));
		}

		const key = this.enrichKey(toolCallId, toolName);
		let promise = this.cache.get(key);
		if (promise) return promise;

		promise = this.doEnrich(toolName, params);
		this.cache.set(key, promise);
		// Don't let the cache grow unbounded forever within a session.
		promise.finally(() => {
			setTimeout(() => this.cache.delete(key), 60_000);
		});
		return promise;
	}

	private async doEnrich(toolName: string, params: unknown): Promise<EnrichedContext> {
		const deterministic = deterministicEnrichment(toolName, params, this.ctx.cwd, this.config);
		if (!this.config?.useModel) return deterministic;

		try {
			const prompt = buildEnrichmentPrompt(toolName, params, deterministic, this.ctx.cwd);
			const modelResult = await callEnrichmentModel(this.ctx, this.config, prompt);
			if (!modelResult) return deterministic;
			return {
				risk: modelResult.risk ?? deterministic.risk,
				notes: modelResult.notes && modelResult.notes.length > 0
					? [...deterministic.notes, "model: " + modelResult.notes.join("; ")]
					: deterministic.notes,
				intent: modelResult.intent,
				snippet: modelResult.snippet ?? deterministic.snippet,
				diff: deterministic.diff,
				affectedFiles: modelResult.affectedFiles && modelResult.affectedFiles.length > 0
					? [...new Set([...deterministic.affectedFiles, ...modelResult.affectedFiles])]
					: deterministic.affectedFiles,
				modelEnriched: true,
			};
		} catch {
			return deterministic;
		}
	}
}

export { deterministicEnrichment };