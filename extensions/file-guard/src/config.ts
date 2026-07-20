/**
 * Configuration loading for File Guard.
 */

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileGuardConfig, Mode, ModelIncludeMap, ViewEnrichmentConfig } from "./types.ts";

function defaultEnrichment(): ViewEnrichmentConfig {
	return {
		enabled: false,
		useModel: false,
		maxContextLength: 2000,
		timeoutMs: 2000,
		riskPatterns: [
			"*secret*",
			"*token*",
			"*.key",
			"*.pem",
			"*.env*",
			".bashrc",
			".zshrc",
			".ssh/*",
			"**/.git/**",
		],
	};
}

const DEFAULT_CONFIG: FileGuardConfig = {
	enabled: false,
	guardEnabled: false,
	viewMode: false,
	globalIncludeFiles: [path.join(os.homedir(), ".piinclude")],
	globalModelIncludeFiles: {},
	projectIncludeFiles: [".piinclude"],
	projectModelIncludeFiles: {},
	defaultPolicy: "prompt",
	wrapAllTools: true,
	viewEnrichment: defaultEnrichment(),
};

function parseModes(value: unknown): { guard?: boolean; view?: boolean } {
	if (typeof value === "string") {
		const modes = value.split(",").map((m) => m.trim().toLowerCase());
		return {
			guard: modes.includes("guard"),
			view: modes.includes("view"),
		};
	}
	if (Array.isArray(value)) {
		const modes = value.filter((v): v is string => typeof v === "string").map((m) => m.toLowerCase());
		return {
			guard: modes.includes("guard"),
			view: modes.includes("view"),
		};
	}
	return {};
}

function parseModelIncludeMap(value: unknown): ModelIncludeMap {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result: ModelIncludeMap = {};
	for (const [key, val] of Object.entries(value)) {
		if (Array.isArray(val) && val.every((entry) => typeof entry === "string")) {
			result[key] = val;
		}
	}
	return result;
}

function sanitizeRiskPatterns(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const patterns = value.filter((v): v is string => typeof v === "string");
	return patterns.length > 0 ? patterns : undefined;
}

function parseEnrichmentModelRef(value: unknown): Partial<{ provider: string; id: string }> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const obj = value as Record<string, unknown>;
	const provider = typeof obj.provider === "string" ? obj.provider : undefined;
	const id = typeof obj.id === "string" ? obj.id : undefined;
	if (provider && id) return { provider, id };
	if (id) return { id };
	if (provider) return { provider };
	return undefined;
}

function parseViewEnrichment(enrich: unknown): ViewEnrichmentConfig | undefined {
	if (typeof enrich === "boolean") {
		return enrich ? { ...defaultEnrichment(), enabled: true } : undefined;
	}
	if (!enrich || typeof enrich !== "object" || Array.isArray(enrich)) return undefined;
	const obj = enrich as Record<string, unknown>;
	const base = defaultEnrichment();
	const model = parseEnrichmentModelRef(obj.model) ?? base.model;
	return {
		enabled: obj.enabled !== undefined ? Boolean(obj.enabled) : true,
		useModel: obj.useModel !== undefined ? Boolean(obj.useModel) : base.useModel,
		model,
		maxContextLength: typeof obj.maxContextLength === "number" && obj.maxContextLength > 0
			? Math.min(obj.maxContextLength as number, 8000)
			: base.maxContextLength,
		timeoutMs: typeof obj.timeoutMs === "number" && obj.timeoutMs > 0 ? (obj.timeoutMs as number) : base.timeoutMs,
		riskPatterns: sanitizeRiskPatterns(obj.riskPatterns) ?? base.riskPatterns,
	};
}

function applyConfigFile(filePath: string, target: FileGuardConfig): void {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<
			FileGuardConfig & { projectIncludeFile?: string; modes?: Mode[] | string }
		>;

		if (parsed.enabled !== undefined) target.guardEnabled = Boolean(parsed.enabled);
		if (parsed.guardEnabled !== undefined) target.guardEnabled = Boolean(parsed.guardEnabled);
		if (parsed.viewMode !== undefined) target.viewMode = Boolean(parsed.viewMode);

		const fileModes = parseModes(parsed.modes);
		if (fileModes.guard !== undefined) target.guardEnabled = fileModes.guard;
		if (fileModes.view !== undefined) target.viewMode = fileModes.view;

		if (Array.isArray(parsed.globalIncludeFiles)) target.globalIncludeFiles = parsed.globalIncludeFiles;
		if (Array.isArray(parsed.projectIncludeFiles)) {
			target.projectIncludeFiles = parsed.projectIncludeFiles;
		} else if (typeof parsed.projectIncludeFile === "string") {
			target.projectIncludeFiles = [parsed.projectIncludeFile];
		}
		if (parsed.globalModelIncludeFiles !== undefined) {
			target.globalModelIncludeFiles = {
				...target.globalModelIncludeFiles,
				...parseModelIncludeMap(parsed.globalModelIncludeFiles),
			};
		}
		if (parsed.projectModelIncludeFiles !== undefined) {
			target.projectModelIncludeFiles = {
				...target.projectModelIncludeFiles,
				...parseModelIncludeMap(parsed.projectModelIncludeFiles),
			};
		}
		if (parsed.defaultPolicy === "allow" || parsed.defaultPolicy === "deny" || parsed.defaultPolicy === "prompt") {
			target.defaultPolicy = parsed.defaultPolicy;
		}
		if (parsed.wrapAllTools !== undefined) target.wrapAllTools = Boolean(parsed.wrapAllTools);
		if (parsed.viewEnrichment !== undefined) {
			const parsedEnrichment = parseViewEnrichment(parsed.viewEnrichment);
			if (parsedEnrichment) target.viewEnrichment = parsedEnrichment;
		}
	} catch {
		// Missing or malformed config is fine.
	}
}

export function loadConfig(cwd: string): FileGuardConfig {
	let guardEnabled = DEFAULT_CONFIG.guardEnabled;
	let viewMode = DEFAULT_CONFIG.viewMode;

	const envEnabled = process.env.PI_FILE_GUARD_ENABLED;
	if (envEnabled === "1" || envEnabled?.toLowerCase() === "true") guardEnabled = true;
	if (envEnabled === "0" || envEnabled?.toLowerCase() === "false") guardEnabled = false;

	const envView = process.env.PI_FILE_GUARD_VIEW;
	if (envView === "1" || envView?.toLowerCase() === "true") viewMode = true;
	if (envView === "0" || envView?.toLowerCase() === "false") viewMode = false;

	const envModes = parseModes(process.env.PI_FILE_GUARD_MODES);
	if (envModes.guard !== undefined) guardEnabled = envModes.guard;
	if (envModes.view !== undefined) viewMode = envModes.view;

	const enrichment: ViewEnrichmentConfig = { ...defaultEnrichment() };
	const envEnrich = process.env.PI_FILE_GUARD_ENRICH;
	if (envEnrich === "1" || envEnrich?.toLowerCase() === "true") enrichment.enabled = true;
	if (envEnrich === "0" || envEnrich?.toLowerCase() === "false") enrichment.enabled = false;

	const envEnrichModel = process.env.PI_FILE_GUARD_ENRICH_MODEL;
	if (envEnrichModel) {
		const [provider, id] = envEnrichModel.includes("/") ? envEnrichModel.split("/", 2) : [undefined, envEnrichModel];
		enrichment.model = { provider, id };
		enrichment.useModel = true;
	}

	const envTimeout = process.env.PI_FILE_GUARD_ENRICH_TIMEOUT;
	if (envTimeout) {
		const parsedTimeout = Number(envTimeout);
		if (!Number.isNaN(parsedTimeout) && parsedTimeout > 0) enrichment.timeoutMs = parsedTimeout;
	}

	const envMax = process.env.PI_FILE_GUARD_ENRICH_MAX_CONTEXT;
	if (envMax) {
		const parsedMax = Number(envMax);
		if (!Number.isNaN(parsedMax) && parsedMax > 0) enrichment.maxContextLength = Math.min(parsedMax, 8000);
	}

	const config: FileGuardConfig = {
		...DEFAULT_CONFIG,
		guardEnabled,
		viewMode,
		globalIncludeFiles: [...DEFAULT_CONFIG.globalIncludeFiles],
		globalModelIncludeFiles: { ...DEFAULT_CONFIG.globalModelIncludeFiles },
		projectIncludeFiles: [...DEFAULT_CONFIG.projectIncludeFiles],
		projectModelIncludeFiles: { ...DEFAULT_CONFIG.projectModelIncludeFiles },
		viewEnrichment: enrichment,
	};

	const globalDir = path.join(os.homedir(), ".pi", "agent", "extensions", "file-guard");
	applyConfigFile(path.join(globalDir, "config.json"), config);
	applyConfigFile(path.join(cwd, CONFIG_DIR_NAME, "file-guard.json"), config);

	// If config files didn't provide enrichment, keep env-derived values.
	if (!config.viewEnrichment) config.viewEnrichment = enrichment;

	return config;
}