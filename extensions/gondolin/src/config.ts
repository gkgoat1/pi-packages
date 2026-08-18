/**
 * Configuration loading for the Gondolin sandbox extension.
 *
 * Authority model — who may set what (later layers win within their authority):
 *
 *   defaults → global file → repo file → environment
 *
 * - global (`~/.pi/agent/gondolin.json`): the user's machine-wide policy and
 *   the *ceiling* for every capability — which host folders may be mounted
 *   (and at what maximum access), which credentials exist, egress allowlists.
 * - repo (`.pi/gondolin.json`): trusted projects may override the whole
 *   surface *except mounts*: every repo — trusted or not — can only restrict
 *   mounts below the global ceiling (drop a mount, or downgrade rw → ro).
 *   Untrusted repos can additionally only restrict everything else: disable
 *   the HTTP proxy, narrow host allowlists / env passthrough / credential
 *   hosts. Nothing an untrusted repo writes can grant capability, because
 *   the agent itself can write that file.
 * - environment: `PI_GONDOLIN_ENABLED=force` / `dangerously-force-disable`
 *   and `PI_GONDOLIN_CONFIG` (JSON) are honored unconditionally — the user
 *   typed them when launching Pi, and a malicious agent cannot change the
 *   environment of the already-running process without being detected.
 *
 * Mounts: the host workspace is always mounted read-write at
 * `guestWorkspace`. Extra host folders come from the `mounts` config key
 * (`"<host path>": "ro" | "rw" | { "access": ..., "guestPath": ... }`,
 * `~` expanded, `"skills"` aliases the global skills directories). When no
 * config mentions `mounts`, the default is the global skills directories
 * (`~/.agents/skills` and `~/.pi/agent/skills`) mounted read-only and
 * nothing else.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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

/** An extra host folder mounted into the guest (besides the workspace). */
export interface MountConfig {
	/** Absolute host path. */
	hostPath: string;
	/** Mount access. `ro` blocks every mutating operation with `EROFS`. */
	access: "ro" | "rw";
	/** Absolute guest path the host folder appears at. */
	guestPath: string;
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
	/**
	 * Extra host mounts, already restricted to the global ceiling. The
	 * workspace itself is not listed here (it is always mounted read-write
	 * at `guestWorkspace`).
	 */
	mounts: MountConfig[];
}

/**
 * A partially-specified config as written by one authority. Only explicitly
 * set fields influence the layer; absence means "no opinion".
 */
export interface ConfigLayer {
	enabled?: boolean;
	accel?: string;
	guestWorkspace?: string;
	memory?: string;
	cpus?: number;
	image?: string;
	startTimeoutMs?: number;
	allowedHosts?: string[];
	envPassthrough?: string[];
	httpProxy?: {
		enabled?: boolean;
		discoverKnownSecrets?: boolean;
		/** `null` values are explicit removals (`{ "hosts": [] }`). */
		secrets?: Record<string, SecretSpec | null>;
	};
	/** Normalized mount requests; unmentioned ceiling mounts are dropped. */
	mounts?: MountConfig[];
	/** Whether the source spelled out a `mounts` key at all. */
	mountsExplicit?: boolean;
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
	mounts: [],
};

/**
 * Host directories treated as global skills, in ceiling order. The standard
 * cross-agent `~/.agents/skills` and the Pi-specific `~/.pi/agent/skills`
 * are both mounted by default, so skills installed by either convention are
 * visible in the sandbox.
 */
export function skillsHostPaths(home: string = homedir()): string[] {
	return [join(home, ".pi", "agent", "skills"), join(home, ".agents", "skills")];
}

/**
 * Default guest mirror for a skills host dir: the host layout under the home
 * directory is replayed under the guest `HOME` (`/root`), so `$HOME`-relative
 * skill paths resolve naturally. Returns undefined for non-skills host paths.
 */
export function defaultSkillsGuestPath(hostPath: string, home: string = homedir()): string | undefined {
	for (const root of skillsHostPaths(home)) {
		if (hostPath === root) return "/root" + hostPath.slice(home.length);
	}
	return undefined;
}

/** Default mount ceiling: the skills directories read-only, nothing else. */
export function defaultMounts(home: string = homedir()): MountConfig[] {
	return skillsHostPaths(home).map((hostPath) => ({
		hostPath,
		access: "ro" as const,
		guestPath: defaultSkillsGuestPath(hostPath, home)!,
	}));
}

/** Default config with fresh empty containers (avoids shared mutation). */
export function DEFAULTS_PLACEHOLDER(): GondolinConfig {
	return {
		...DEFAULTS,
		httpProxy: { ...DEFAULTS.httpProxy, secrets: {} },
		mounts: defaultMounts(),
	};
}

function withDefaults(): GondolinConfig {
	return {
		...DEFAULTS,
		httpProxy: { ...DEFAULTS.httpProxy, secrets: {} },
		mounts: defaultMounts(),
	};
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

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

/** Parse a secret spec; `null` = explicit removal, `undefined` = malformed. */
function parseSecretSpec(value: unknown): SecretSpec | null | undefined {
	const object = asObject(value);
	if (!object) return undefined;
	const hosts = asStringArray(object.hosts);
	if (!hosts) return undefined;
	if (hosts.length === 0) return null;
	const spec: SecretSpec = { hosts };
	if (typeof object.envVar === "string" && object.envVar) spec.envVar = object.envVar;
	return spec;
}

/**
 * Resolve a mounts-map key to absolute host path(s). `~` is expanded against
 * the home directory; the alias `skills` names both skills directories (the
 * standard `~/.agents/skills` and the Pi-specific `~/.pi/agent/skills`).
 * Returns undefined for keys that are neither absolute nor `~`-relative.
 */
export function normalizeHostKey(key: string, home: string): string[] | undefined {
	if (key === "skills") return skillsHostPaths(home);
	if (key === "~") return [home];
	if (key.startsWith("~/")) return [join(home, key.slice(2))];
	if (key.startsWith("/")) return [key];
	return undefined;
}

function normalizeGuestPath(value: unknown, hostPath: string, home: string): string | undefined {
	let guestPath: string | undefined;
	if (typeof value === "string" && value.startsWith("/")) guestPath = value;
	if (!guestPath) {
		// Default: skills dirs mirror their host layout under the guest HOME
		// (/root) so $HOME-relative skill paths resolve; other folders mount
		// at /mnt/<name>.
		guestPath = defaultSkillsGuestPath(hostPath, home) ?? `/mnt/${basename(hostPath)}`;
	}
	const segments: string[] = [];
	for (const segment of guestPath.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") return undefined;
		segments.push(segment);
	}
	if (segments.length === 0) return undefined;
	return `/${segments.join("/")}`;
}

function parseMountsValue(raw: unknown): MountConfig[] {
	const object = asObject(raw);
	if (!object) return [];
	const home = homedir();
	const byHost = new Map<string, MountConfig>();
	for (const [key, value] of Object.entries(object)) {
		const paths = normalizeHostKey(key, home);
		if (!paths) continue;
		let access: "ro" | "rw";
		let guestRaw: unknown;
		if (value === "ro" || value === "rw") access = value;
		else if (asObject(value)) {
			const accessRaw = asObject(value)?.access;
			if (accessRaw === "ro" || accessRaw === "rw") access = accessRaw;
			else continue;
			guestRaw = asObject(value)?.guestPath;
		} else continue; // "none"/unknown values mean "do not mount"
		for (const hostPath of paths) {
			const guestPath = normalizeGuestPath(guestRaw, hostPath, home);
			if (!guestPath) continue;
			byHost.set(hostPath, { hostPath, access, guestPath });
		}
	}
	// Later entries win guest-path collisions (same host key already replaced).
	const mounts: MountConfig[] = [];
	for (const entry of byHost.values()) {
		const clash = mounts.findIndex((existing) => existing.guestPath === entry.guestPath);
		if (clash >= 0) mounts.splice(clash, 1);
		mounts.push(entry);
	}
	return mounts;
}

/** Parse raw JSON into a layer of only the explicitly set, well-formed fields. */
export function parseLayer(value: unknown): ConfigLayer {
	const root = asObject(value);
	if (!root) return {};
	const layer: ConfigLayer = {};
	if (typeof root.enabled === "boolean") layer.enabled = root.enabled;
	if (typeof root.accel === "string" && root.accel) layer.accel = root.accel;
	if (typeof root.guestWorkspace === "string" && root.guestWorkspace.startsWith("/")) {
		layer.guestWorkspace = root.guestWorkspace;
	}
	if (typeof root.memory === "string" && root.memory) layer.memory = root.memory;
	if (Number.isInteger(root.cpus) && (root.cpus as number) > 0) layer.cpus = root.cpus as number;
	if (typeof root.image === "string" && root.image) layer.image = root.image;
	if (Number.isInteger(root.startTimeoutMs) && (root.startTimeoutMs as number) >= 0) {
		layer.startTimeoutMs = root.startTimeoutMs as number;
	}
	const allowedHosts = asStringArray(root.allowedHosts);
	if (allowedHosts) layer.allowedHosts = allowedHosts;
	const envPassthrough = asStringArray(root.envPassthrough);
	if (envPassthrough) layer.envPassthrough = envPassthrough;

	const proxy = asObject(root.httpProxy);
	if (proxy) {
		const parsed: NonNullable<ConfigLayer["httpProxy"]> = {};
		if (typeof proxy.enabled === "boolean") parsed.enabled = proxy.enabled;
		if (typeof proxy.discoverKnownSecrets === "boolean") {
			parsed.discoverKnownSecrets = proxy.discoverKnownSecrets;
		}
		const secretMap = asObject(proxy.secrets);
		if (secretMap) {
			const secrets: Record<string, SecretSpec | null> = {};
			for (const [name, raw] of Object.entries(secretMap)) {
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
				const spec = parseSecretSpec(raw);
				if (spec !== undefined) secrets[name] = spec;
			}
			parsed.secrets = secrets;
		}
		if (Object.keys(parsed).length > 0) layer.httpProxy = parsed;
	}

	if (root.mounts !== undefined) {
		layer.mounts = parseMountsValue(root.mounts);
		layer.mountsExplicit = true;
	}
	return layer;
}

// ---------------------------------------------------------------------------
// Layer application
// ---------------------------------------------------------------------------

/** Which authority a layer speaks for. */
export type LayerAuthority = "global" | "env" | "trusted" | "untrusted";

function cloneConfig(base: GondolinConfig): GondolinConfig {
	return { ...base, httpProxy: { ...base.httpProxy, secrets: { ...base.httpProxy.secrets } } };
}

/** Full-override application (global/env layers, and trusted non-mount fields). */
function applyOverride(base: GondolinConfig, layer: ConfigLayer): GondolinConfig {
	const next = cloneConfig(base);
	if (layer.enabled !== undefined) next.enabled = layer.enabled;
	if (layer.accel) next.accel = layer.accel;
	if (layer.guestWorkspace) next.guestWorkspace = layer.guestWorkspace;
	if (layer.memory) next.memory = layer.memory;
	if (layer.cpus !== undefined) next.cpus = layer.cpus;
	if (layer.image) next.image = layer.image;
	if (layer.startTimeoutMs !== undefined) next.startTimeoutMs = layer.startTimeoutMs;
	if (layer.allowedHosts) next.allowedHosts = [...layer.allowedHosts];
	if (layer.envPassthrough) next.envPassthrough = [...layer.envPassthrough];
	if (layer.httpProxy) {
		if (layer.httpProxy.enabled !== undefined) next.httpProxy.enabled = layer.httpProxy.enabled;
		if (layer.httpProxy.discoverKnownSecrets !== undefined) {
			next.httpProxy.discoverKnownSecrets = layer.httpProxy.discoverKnownSecrets;
		}
		if (layer.httpProxy.secrets) {
			for (const [name, spec] of Object.entries(layer.httpProxy.secrets)) {
				if (spec === null) delete next.httpProxy.secrets[name];
				else next.httpProxy.secrets[name] = { hosts: [...spec.hosts], ...(spec.envVar ? { envVar: spec.envVar } : {}) };
			}
		}
	}
	if (layer.mountsExplicit) next.mounts = layer.mounts ? layer.mounts.map((m) => ({ ...m })) : [];
	return next;
}

/**
 * Restrict-only application (untrusted repos): every field may only narrow
 * the base. Enablement and preferences (accel, memory, image, …) are ignored
 * entirely — an untrusted repo cannot turn the sandbox off or reconfigure it.
 */
function applyRestricting(base: GondolinConfig, layer: ConfigLayer): GondolinConfig {
	const next = cloneConfig(base);
	if (layer.allowedHosts) {
		next.allowedHosts = base.allowedHosts
			? layer.allowedHosts.filter((host) => base.allowedHosts!.includes(host))
			: [...layer.allowedHosts];
	}
	if (layer.envPassthrough) {
		const requested = new Set(layer.envPassthrough);
		next.envPassthrough = base.envPassthrough.filter((name) => requested.has(name));
	}
	if (layer.httpProxy) {
		if (layer.httpProxy.enabled === false) next.httpProxy.enabled = false;
		if (layer.httpProxy.discoverKnownSecrets === false) {
			next.httpProxy.discoverKnownSecrets = false;
		}
		if (layer.httpProxy.secrets) {
			for (const [name, spec] of Object.entries(layer.httpProxy.secrets)) {
				const current = next.httpProxy.secrets[name];
				if (!current) continue; // cannot add credentials
				if (spec === null) {
					delete next.httpProxy.secrets[name];
					continue;
				}
				const hosts = spec.hosts.filter((host) => current.hosts.includes(host));
				if (hosts.length === 0) delete next.httpProxy.secrets[name];
				else next.httpProxy.secrets[name] = { hosts, ...(current.envVar ? { envVar: current.envVar } : {}) };
			}
		}
	}
	next.mounts = restrictMounts(base.mounts, layer.mounts);
	return next;
}

/**
 * Restrict a mount ceiling by a repo's requests: only ceiling paths can stay
 * mounted, access can only be downgraded (rw → ro), and requests outside the
 * ceiling (or above it) fall back to the ceiling entry. Omitted mounts drop.
 */
export function restrictMounts(ceiling: MountConfig[], requested: MountConfig[] | undefined): MountConfig[] {
	if (!requested) return ceiling.map((m) => ({ ...m }));
	const byHost = new Map(ceiling.map((m) => [m.hostPath, m]));
	const out: MountConfig[] = [];
	for (const request of requested) {
		const cap = byHost.get(request.hostPath);
		if (!cap) continue; // not in the ceiling → not mountable from a repo
		const access = request.access === "rw" && cap.access === "ro" ? "ro" : request.access;
		out.push({ hostPath: cap.hostPath, guestPath: cap.guestPath, access });
	}
	return out;
}

/**
 * Apply a layer onto a config under the given authority:
 * - `global`/`env`: full override (env replaces the mount ceiling wholesale)
 * - `trusted`: full override except mounts, which only restrict the ceiling
 * - `untrusted`: restrict-only across the whole surface
 */
export function applyLayer(base: GondolinConfig, layer: ConfigLayer, authority: LayerAuthority): GondolinConfig {
	if (authority === "global" || authority === "env") return applyOverride(base, layer);
	if (authority === "trusted") {
		const overridden = applyOverride(base, { ...layer, mounts: undefined, mountsExplicit: undefined });
		overridden.mounts = restrictMounts(base.mounts, layer.mounts);
		return overridden;
	}
	return applyRestricting(base, layer);
}

// ---------------------------------------------------------------------------
// Public compat helpers
// ---------------------------------------------------------------------------

/** Parse and validate raw JSON as a standalone config. Throws on malformed JSON input. */
export function parseConfig(value: unknown): GondolinConfig {
	const layer = parseLayer(value);
	if (layer.enabled !== true) return withDefaults();
	return applyLayer(withDefaults(), layer, "global");
}

/** Rebuild a layer from a materialized config (every field is an opinion). */
function configToLayer(config: GondolinConfig): ConfigLayer {
	return {
		enabled: config.enabled,
		accel: config.accel,
		guestWorkspace: config.guestWorkspace,
		...(config.memory ? { memory: config.memory } : {}),
		...(config.cpus !== undefined ? { cpus: config.cpus } : {}),
		...(config.image ? { image: config.image } : {}),
		...(config.startTimeoutMs !== undefined ? { startTimeoutMs: config.startTimeoutMs } : {}),
		...(config.allowedHosts ? { allowedHosts: [...config.allowedHosts] } : {}),
		envPassthrough: [...config.envPassthrough],
		httpProxy: {
			enabled: config.httpProxy.enabled,
			discoverKnownSecrets: config.httpProxy.discoverKnownSecrets,
			secrets: Object.fromEntries(
				Object.entries(config.httpProxy.secrets).map(([name, spec]) => [
					name,
					{ hosts: [...spec.hosts], ...(spec.envVar ? { envVar: spec.envVar } : {}) },
				]),
			),
		},
		mounts: config.mounts.map((m) => ({ ...m })),
		mountsExplicit: true,
	};
}

/** Merge two layered configs (trusted-project semantics; `next` wins, mounts restrict-only). */
export function mergeConfig(base: GondolinConfig, next: GondolinConfig): GondolinConfig {
	return applyLayer(base, configToLayer(next), "trusted");
}

/**
 * Read `PI_GONDOLIN_ENABLED` as an enablement override:
 * - `force` (aliases: true/1/yes/on) — force-enable the VM
 * - `dangerously-force-disable` (aliases: false/0/no/off) — disable the VM
 * - unset, empty, or unrecognized — no opinion (file config decides)
 */
export function parseEnablementEnv(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const compact = value.trim().toLowerCase().replace(/[-_\s]+/g, "");
	if (!compact) return undefined;
	if (["force", "true", "1", "yes", "on"].includes(compact)) return true;
	if (["dangerouslyforcedisable", "false", "0", "no", "off"].includes(compact)) return false;
	return undefined;
}

/** Config layer derived from `PI_GONDOLIN_*` environment variables. */
export function envLayer(): ConfigLayer {
	let layer: ConfigLayer = {};
	const encoded = process.env.PI_GONDOLIN_CONFIG;
	if (encoded) {
		try {
			layer = parseLayer(JSON.parse(encoded));
		} catch {
			layer = {};
		}
	}
	const enabled = parseEnablementEnv(process.env.PI_GONDOLIN_ENABLED);
	if (enabled !== undefined) layer.enabled = enabled;
	return layer;
}

/** Config derived from `PI_GONDOLIN_*` environment variables (defaults filled). */
export function envConfig(): GondolinConfig {
	return applyLayer(withDefaults(), envLayer(), "env");
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

function readLayer(path: string): ConfigLayer {
	if (!existsSync(path)) return {};
	try {
		return parseLayer(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return {};
	}
}

/**
 * Load and layer config: global ceiling ← repo (authority by trust) ← env.
 * The repo file is read even for untrusted projects — its restricting
 * choices are honored, nothing it says can grant capability.
 */
export function loadConfig(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): GondolinConfig {
	const globalLayer = readLayer(join(homedir(), ".pi", "agent", "gondolin.json"));
	const repoLayer = readLayer(join(ctx.cwd, CONFIG_DIR_NAME, "gondolin.json"));
	const repoAuthority: LayerAuthority = ctx.isProjectTrusted() ? "trusted" : "untrusted";
	return applyLayer(
		applyLayer(applyLayer(withDefaults(), globalLayer, "global"), repoLayer, repoAuthority),
		envLayer(),
		"env",
	);
}
