/**
 * Layered configuration for the radare2 extension.
 *
 * Precedence (later wins):
 *   1. ~/.pi/agent/radare2.json
 *   2. .pi/radare2.json (trusted projects only — the caller gates this)
 *   3. PI_R2_CONFIG (JSON object) plus PI_R2_* scalar env vars
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SandboxBackend = "auto" | "bwrap" | "gondolin";

export interface Radare2Config {
	/** "auto": register tools only when an r2 binary is found. */
	enabled: "auto" | "on" | "off";
	/** r2 binary name or absolute path. */
	r2Path: string;
	/** Per-command timeout in milliseconds. */
	timeoutMs: number;
	/** Max bytes of a single command's output kept in the tool result. */
	maxOutputBytes: number;
	/** Max concurrently open r2 sessions. */
	maxOpenSessions: number;
	/** Auto-run `aaa` after opening a binary. */
	autoAnalyze: boolean;
	/** Allow opening persisted r2 project files (`.r2`). */
	allowProjects: boolean;
	/** Allow opening remote locations (`rap://`, `tcp://`). */
	allowRemote: boolean;
	sandbox: {
		/** "auto": Seatbelt on darwin, bwrap on Linux; "gondolin" forces the VM. */
		backend: SandboxBackend;
		/** Extra Seatbelt deny actions appended verbatim to the bundled profile. */
		extraSeatbeltDenies: string[];
	};
}

export const DEFAULT_CONFIG: Radare2Config = {
	enabled: "auto",
	r2Path: "radare2",
	timeoutMs: 30_000,
	maxOutputBytes: 256 * 1024,
	maxOpenSessions: 4,
	autoAnalyze: true,
	allowProjects: true,
	allowRemote: false,
	sandbox: { backend: "auto", extraSeatbeltDenies: [] },
};

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string")
		? (value as string[])
		: undefined;
}

/** Coerce an unknown value into the config shape; unknown keys are ignored. */
export function parseConfig(value: unknown): Partial<Radare2Config> {
	const object = asObject(value);
	if (!object) return {};
	const config: Partial<Radare2Config> = {};
	if (object.enabled === "auto" || object.enabled === "on" || object.enabled === "off") {
		config.enabled = object.enabled;
	}
	if (typeof object.r2Path === "string" && object.r2Path.trim() !== "") {
		config.r2Path = object.r2Path.trim();
	}
	for (const key of ["timeoutMs", "maxOutputBytes", "maxOpenSessions"] as const) {
		const num = object[key];
		if (typeof num === "number" && Number.isFinite(num) && num > 0) config[key] = Math.floor(num);
	}
	if (typeof object.autoAnalyze === "boolean") config.autoAnalyze = object.autoAnalyze;
	if (typeof object.allowProjects === "boolean") config.allowProjects = object.allowProjects;
	if (typeof object.allowRemote === "boolean") config.allowRemote = object.allowRemote;
	const sandbox = asObject(object.sandbox);
	if (sandbox) {
		const parsed: Partial<Radare2Config["sandbox"]> = {};
		if (sandbox.backend === "auto" || sandbox.backend === "bwrap" || sandbox.backend === "gondolin") {
			parsed.backend = sandbox.backend;
		}
		const denies = strings(sandbox.extraSeatbeltDenies);
		if (denies) parsed.extraSeatbeltDenies = denies;
		config.sandbox = parsed as Radare2Config["sandbox"];
	}
	return config;
}

function readConfigFile(path: string): Partial<Radare2Config> {
	if (!existsSync(path)) return {};
	try {
		return parseConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		// Malformed config files are ignored; the effective config is visible
		// through /r2 status.
		return {};
	}
}

/** Environment overrides on top of the parsed file/env-JSON config. */
function applyEnv(config: Partial<Radare2Config>): Partial<Radare2Config> {
	const env = process.env;
	const result: Partial<Radare2Config> = { ...config };
	const num = (name: string): number | undefined => {
		const raw = env[name];
		if (!raw) return undefined;
		const value = Number(raw);
		return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
	};
	const bool = (name: string): boolean | undefined =>
		env[name] === undefined ? undefined : ["1", "true", "yes", "on"].includes(env[name].toLowerCase());
	const r2Path = env.PI_R2_PATH;
	if (r2Path && r2Path.trim() !== "") result.r2Path = r2Path.trim();
	const timeoutMs = num("PI_R2_TIMEOUT_MS");
	if (timeoutMs !== undefined) result.timeoutMs = timeoutMs;
	const maxOutputBytes = num("PI_R2_MAX_OUTPUT_BYTES");
	if (maxOutputBytes !== undefined) result.maxOutputBytes = maxOutputBytes;
	const autoAnalyze = bool("PI_R2_AUTO_ANALYZE");
	if (autoAnalyze !== undefined) result.autoAnalyze = autoAnalyze;
	const allowProjects = bool("PI_R2_ALLOW_PROJECTS");
	if (allowProjects !== undefined) result.allowProjects = allowProjects;
	const allowRemote = bool("PI_R2_ALLOW_REMOTE");
	if (allowRemote !== undefined) result.allowRemote = allowRemote;
	const backend = env.PI_R2_SANDBOX_BACKEND;
	if (backend === "auto" || backend === "bwrap" || backend === "gondolin") {
		result.sandbox = { ...DEFAULT_CONFIG.sandbox, ...result.sandbox, backend };
	}
	return result;
}

function mergeConfig(base: Partial<Radare2Config>, next: Partial<Radare2Config>): Partial<Radare2Config> {
	return {
		...base,
		...next,
		sandbox: { ...DEFAULT_CONFIG.sandbox, ...base.sandbox, ...next.sandbox },
	};
}

/**
 * Layered load: global file → project file (callers only pass it for trusted
 * projects) → PI_R2_CONFIG JSON → scalar PI_R2_* env vars.
 */
export function loadRadare2Config(projectDir?: string): Radare2Config {
	const global = readConfigFile(join(homedir(), ".pi", "agent", "radare2.json"));
	const project = projectDir
		? readConfigFile(join(projectDir, ".pi", "radare2.json"))
		: {};
	const envJson = (() => {
		const raw = process.env.PI_R2_CONFIG;
		if (!raw) return {};
		try {
			return parseConfig(JSON.parse(raw));
		} catch {
			return {};
		}
	})();
	return {
		...DEFAULT_CONFIG,
		...mergeConfig(mergeConfig(global, project), applyEnv(envJson)),
	};
}

/**
 * Locate the r2 binary. An absolute `r2Path` is used as-is; otherwise each
 * PATH directory is probed. Returns undefined when not found.
 */
export function findR2Binary(r2Path: string, platform = process.platform): string | undefined {
	if (r2Path.includes("/")) {
		return existsSync(r2Path) ? r2Path : undefined;
	}
	// Homebrew's sbin directories are often not on the PATH.
	const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
	if (platform === "darwin") {
		for (const extra of ["/opt/homebrew/bin", "/usr/local/bin"]) {
			if (!pathDirs.includes(extra)) pathDirs.push(extra);
		}
	}
	for (const dir of pathDirs) {
		const candidate = join(dir, r2Path);
		if (existsSync(candidate)) return candidate;
	}
	// The extension runs behind jiti's bundler; `process.execPath` is Node, so
	// execPath-based probing is not useful here. As a last resort, let the OS
	// resolve it (spawns will still fail closed if it truly does not exist).
	return r2Path;
}
