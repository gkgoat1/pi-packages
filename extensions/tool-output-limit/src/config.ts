import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Limit = number | null;
export type ToolName = "bash" | "read" | "grep" | "find" | "ls";

export interface ToolLimits {
	maxBytes: Limit;
	maxLines: Limit;
}

export interface ToolOutputLimitConfig extends ToolLimits {
	enabled: boolean;
	hardMaxBytes: Limit;
	tools: Partial<Record<ToolName, Partial<ToolLimits>>>;
	tempOutput: { retain: boolean; directory: string | null };
}

export const TOOL_NAMES: ToolName[] = ["bash", "read", "grep", "find", "ls"];

export const DEFAULT_CONFIG: ToolOutputLimitConfig = {
	enabled: false,
	maxBytes: 4 * 1024 * 1024,
	maxLines: 50_000,
	hardMaxBytes: 64 * 1024 * 1024,
	tools: {},
	tempOutput: { retain: true, directory: null },
};

export class ConfigError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLimit(value: unknown, name: string): Limit | undefined {
	if (value === undefined) return undefined;
	if (value === "unlimited" || value === null) return null;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new ConfigError(`${name} must be a positive safe integer or "unlimited"`);
	}
	return value;
}

function parseBoolean(value: unknown, name: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new ConfigError(`${name} must be a boolean`);
	return value;
}

function parseObject(value: unknown, source: string): Record<string, unknown> {
	if (!isRecord(value)) throw new ConfigError(`${source} must contain a JSON object`);
	return value;
}

function readJson(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return parseObject(JSON.parse(readFileSync(path, "utf8")), path);
	} catch (error) {
		throw error instanceof ConfigError ? error : new ConfigError(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function merge(...sources: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
	return Object.assign({}, ...sources.filter((source): source is Record<string, unknown> => source !== undefined));
}

function valueOrDefault<T>(value: T | undefined, fallback: T): T {
	return value === undefined ? fallback : value;
}

function parseConfig(raw: Record<string, unknown>): ToolOutputLimitConfig {
	const toolsRaw = raw.tools === undefined ? {} : parseObject(raw.tools, "tools");
	const tools: ToolOutputLimitConfig["tools"] = {};
	for (const name of TOOL_NAMES) {
		if (toolsRaw[name] === undefined) continue;
		const tool = parseObject(toolsRaw[name], `tools.${name}`);
		const maxBytes = parseLimit(tool.maxBytes, `tools.${name}.maxBytes`);
		const maxLines = parseLimit(tool.maxLines, `tools.${name}.maxLines`);
		tools[name] = {
			...(maxBytes === undefined ? {} : { maxBytes }),
			...(maxLines === undefined ? {} : { maxLines }),
		};
	}
	const tempRaw = raw.tempOutput === undefined ? {} : parseObject(raw.tempOutput, "tempOutput");
	const directory = tempRaw.directory;
	if (directory !== undefined && directory !== null && typeof directory !== "string") {
		throw new ConfigError("tempOutput.directory must be a string or null");
	}
	return {
		enabled: valueOrDefault(parseBoolean(raw.enabled, "enabled"), DEFAULT_CONFIG.enabled),
		maxBytes: valueOrDefault(parseLimit(raw.maxBytes, "maxBytes"), DEFAULT_CONFIG.maxBytes),
		maxLines: valueOrDefault(parseLimit(raw.maxLines, "maxLines"), DEFAULT_CONFIG.maxLines),
		hardMaxBytes: valueOrDefault(parseLimit(raw.hardMaxBytes, "hardMaxBytes"), DEFAULT_CONFIG.hardMaxBytes),
		tools,
		tempOutput: {
			retain: valueOrDefault(parseBoolean(tempRaw.retain, "tempOutput.retain"), DEFAULT_CONFIG.tempOutput.retain),
			directory: directory === undefined ? DEFAULT_CONFIG.tempOutput.directory : directory,
		},
	};
}

function envOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	if (env.PI_TOOL_OUTPUT_LIMIT_ENABLED !== undefined) {
		if (env.PI_TOOL_OUTPUT_LIMIT_ENABLED !== "true" && env.PI_TOOL_OUTPUT_LIMIT_ENABLED !== "false") {
			throw new ConfigError("PI_TOOL_OUTPUT_LIMIT_ENABLED must be true or false");
		}
		result.enabled = env.PI_TOOL_OUTPUT_LIMIT_ENABLED === "true";
	}
	for (const [envName, field] of [["PI_TOOL_OUTPUT_LIMIT_MAX_BYTES", "maxBytes"], ["PI_TOOL_OUTPUT_LIMIT_MAX_LINES", "maxLines"]] as const) {
		const value = env[envName];
		if (value === undefined) continue;
		result[field] = value === "unlimited" ? "unlimited" : Number(value);
	}
	return result;
}

export function loadConfig(options: { cwd: string; trusted: boolean; env?: NodeJS.ProcessEnv; home?: string } ): ToolOutputLimitConfig {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const globalConfig = readJson(join(home, ".pi", "agent", "tool-output-limit.json"));
	const projectConfig = options.trusted ? readJson(join(options.cwd, ".pi", "tool-output-limit.json")) : undefined;
	const inline = env.PI_TOOL_OUTPUT_LIMIT_CONFIG === undefined ? undefined : parseObject(JSON.parse(env.PI_TOOL_OUTPUT_LIMIT_CONFIG), "PI_TOOL_OUTPUT_LIMIT_CONFIG");
	return parseConfig(merge(globalConfig, projectConfig, inline, envOverrides(env)));
}

export function limitsFor(config: ToolOutputLimitConfig, tool: ToolName): ToolLimits & { hardMaxBytes: Limit } {
	const override = config.tools[tool] ?? {};
	return {
		maxBytes: override.maxBytes === undefined ? config.maxBytes : override.maxBytes,
		maxLines: override.maxLines === undefined ? config.maxLines : override.maxLines,
		hardMaxBytes: config.hardMaxBytes,
	};
}
