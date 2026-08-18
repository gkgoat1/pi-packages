/**
 * Configuration loading for the Gondolin sandbox extension.
 *
 * Layering (later wins): global (`~/.pi/agent/gondolin.json`) ←
 * trusted project (`.pi/gondolin.json`) ← `PI_GONDOLIN_CONFIG` JSON.
 * `PI_GONDOLIN_ENABLED` is a boolean shortcut for the top-level `enabled`
 * flag.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";

/** A credential the proxy may inflate. `envVar` reads the value from the host env. */
export interface SecretSpec {
	/** Host patterns this credential may be sent to (inflation only happens here). */
	hosts: string[];
	/** Host env var holding the real value. Defaults to the secret's key name. */
	envVar?: string;
}

export interface HttpProxyConfig {
	/** When false, no HTTP hooks run and the guest sees no stubs. */
	enabled: boolean;
	/** Auto-discover well-known API-key env vars present in the host env. */
	discoverKnownSecrets: boolean;
	/** Extra credentials keyed by guest env var name. */
	secrets: Record<string, SecretSpec>;
}

export interface GondolinConfig {
	/** Explicit opt-in: installed package extensions start disabled. */
	enabled: boolean;
	/** QEMU acceleration backend. Defaults to "tcg" (software emulation, nested-VM safe). */
	accel: string;
	/** Guest mount point for the host working directory. */
	guestWorkspace: string;
	/** VM memory (qemu syntax). Omitted uses gondolin's default ("1G"). */
	memory?: string;
	/** VM cpu count. Omitted uses gondolin's default. */
	cpus?: number;
	/** Guest image selector (e.g. "alpine-base:latest") or directory. */
	image?: string;
	/** Guest readiness timeout in ms. Omitted uses gondolin's default. */
	startTimeoutMs?: number;
	/** Outbound host allowlist. Omitted = allow all; [] = deny all. */
	allowedHosts?: string[];
	/** Host env var names copied into the guest after secret scrubbing. */
	envPassthrough: string[];
	/** HTTP proxy + credential stub configuration. */
	httpProxy: HttpProxyConfig;
}

const DEFAULTS: GondolinConfig = {
	enabled: false,
	accel: "tcg",
	guestWorkspace: "/workspace",
	envPassthrough: [],
	httpProxy: {
		enabled: true,
		discoverKnownSecrets: true,
		secrets: {},
	},
};

/** Default config with a fresh empty secrets record (avoids shared mutation). */
export function DEFAULTS_PLACEHOLDER(): GondolinConfig {
	return { ...DEFAULTS, httpProxy: { ...DEFAULTS.httpProxy, secrets: {} } };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string")
		? value
		: undefined;
}

function parseSecretSpec(value: unknown): SecretSpec | undefined {
	const object = asObject(value);
	if (!object) return undefined;
	const hosts = asStringArray(object.hosts);
	if (!hosts || hosts.length === 0) return undefined;
	const spec: SecretSpec = { hosts };
	if (typeof object.envVar === "string" && object.envVar) spec.envVar = object.envVar;
	return spec;
}

function parseHttpProxy(value: unknown): HttpProxyConfig | undefined {
	const object = asObject(value);
	if (!object) return undefined;
	const secrets: Record<string, SecretSpec> = {};
	const secretMap = asObject(object.secrets);
	if (secretMap) {
		for (const [name, raw] of Object.entries(secretMap)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
			const spec = parseSecretSpec(raw);
			if (spec) secrets[name] = spec;
		}
	}
	return {
		enabled: typeof object.enabled === "boolean" ? object.enabled : true,
		discoverKnownSecrets: typeof object.discoverKnownSecrets === "boolean" ? object.discoverKnownSecrets : true,
		secrets,
	};
}

/** Parse and validate raw JSON. Throws on malformed config. */
export function parseConfig(value: unknown): GondolinConfig {
	const root = asObject(value);
	if (!root || root.enabled !== true) return { ...DEFAULTS, httpProxy: { ...DEFAULTS.httpProxy, secrets: {} } };
	const httpProxy = parseHttpProxy(root.httpProxy) ?? {
		enabled: true,
		discoverKnownSecrets: true,
		secrets: {},
	};
	const config: GondolinConfig = {
		enabled: true,
		accel: typeof root.accel === "string" && root.accel ? root.accel : DEFAULTS.accel,
		guestWorkspace: typeof root.guestWorkspace === "string" && root.guestWorkspace
			? root.guestWorkspace
			: DEFAULTS.guestWorkspace,
		envPassthrough: asStringArray(root.envPassthrough) ?? DEFAULTS.envPassthrough,
		httpProxy,
	};
	if (typeof root.memory === "string" && root.memory) config.memory = root.memory;
	if (Number.isInteger(root.cpus) && (root.cpus as number) > 0) config.cpus = root.cpus as number;
	if (typeof root.image === "string" && root.image) config.image = root.image;
	if (Number.isInteger(root.startTimeoutMs) && (root.startTimeoutMs as number) >= 0) {
		config.startTimeoutMs = root.startTimeoutMs as number;
	}
	const allowedHosts = asStringArray(root.allowedHosts);
	if (allowedHosts) config.allowedHosts = allowedHosts;
	return config;
}

function readConfigFile(path: string): GondolinConfig {
	if (!existsSync(path)) return { ...DEFAULTS, httpProxy: { ...DEFAULTS.httpProxy, secrets: {} } };
	try {
		return parseConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return { ...DEFAULTS, httpProxy: { ...DEFAULTS.httpProxy, secrets: {} } };
	}
}

function mergeSecrets(base: Record<string, SecretSpec>, next: Record<string, SecretSpec>): Record<string, SecretSpec> {
	return { ...base, ...next };
}

/** Merge two layered configs; `next` wins for scalars, secrets merge per-key. */
export function mergeConfig(base: GondolinConfig, next: GondolinConfig): GondolinConfig {
	return {
		enabled: next.enabled ?? base.enabled,
		accel: next.accel ?? base.accel,
		guestWorkspace: next.guestWorkspace ?? base.guestWorkspace,
		memory: next.memory ?? base.memory,
		cpus: next.cpus ?? base.cpus,
		image: next.image ?? base.image,
		startTimeoutMs: next.startTimeoutMs ?? base.startTimeoutMs,
		allowedHosts: next.allowedHosts ?? base.allowedHosts,
		envPassthrough: next.envPassthrough.length > 0 ? next.envPassthrough : base.envPassthrough,
		httpProxy: {
			enabled: next.httpProxy.enabled && base.httpProxy.enabled,
			discoverKnownSecrets: next.httpProxy.discoverKnownSecrets && base.httpProxy.discoverKnownSecrets,
			secrets: mergeSecrets(base.httpProxy.secrets, next.httpProxy.secrets),
		},
	};
}

function parseBool(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	return ["1", "true", "yes", "on"].includes(normalized);
}

/** Config derived from `PI_GONDOLIN_*` environment variables. */
export function envConfig(): GondolinConfig {
	let config: GondolinConfig | undefined;
	const encoded = process.env.PI_GONDOLIN_CONFIG;
	if (encoded) {
		try {
			config = parseConfig(JSON.parse(encoded));
		} catch {
			config = undefined;
		}
	}
	const enabled = parseBool(process.env.PI_GONDOLIN_ENABLED);
	if (enabled !== undefined && config) config.enabled = enabled;
	else if (enabled !== undefined) {
		config = { ...DEFAULTS, httpProxy: { ...DEFAULTS.httpProxy, secrets: {} }, enabled };
	}
	return config ?? { ...DEFAULTS, httpProxy: { ...DEFAULTS.httpProxy, secrets: {} } };
}

/** Load and layer config from disk + environment. */
export function loadConfig(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): GondolinConfig {
	const globalConfig = readConfigFile(join(homedir(), ".pi", "agent", "gondolin.json"));
	const projectConfig = ctx.isProjectTrusted()
		? readConfigFile(join(ctx.cwd, CONFIG_DIR_NAME, "gondolin.json"))
		: { ...DEFAULTS, httpProxy: { ...DEFAULTS.httpProxy, secrets: {} } };
	return mergeConfig(mergeConfig(globalConfig, projectConfig), envConfig());
}
