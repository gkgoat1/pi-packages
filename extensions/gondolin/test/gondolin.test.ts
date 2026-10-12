import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULTS_PLACEHOLDER,
	applyLayer,
	defaultMounts,
	defaultSkillsGuestPath,
	envConfig,
	loadConfig,
	mergeConfig,
	normalizeHostKey,
	parseConfig,
	parseEnablementEnv,
	parseLayer,
	restrictMounts,
	type MountConfig,
} from "../src/config.ts";
import {
	buildSecretDefinitions,
	buildStubEnv,
	discoverSecrets,
	looksLikeSecretValue,
	scrubValue,
	sanitizeGuestEnv,
} from "../src/secrets.ts";
import type { RandomSource } from "../src/secrets.ts";
import { GUEST_BASE_ENV, buildGuestEnv, buildSandboxPromptAddendum, toGuestPath } from "../src/ops.ts";
import type { VM } from "@earendil-works/gondolin";
import {
	buildExtraMountProviders,
	clearGondolinSharedForTest,
	createGuardedWorkspaceProvider,
	getGondolinShared,
	GONDOLIN_SHARED_KEY,
	hostPathToGuestPath,
	installGondolinShared,
	isWriteFsOp,
	launchGuestProcess,
	mapHostToGuestPath,
	stubifyEnv,
	toHostPath,
	type FsGuardRequest,
	type GondolinFsGuard,
} from "../src/shared.ts";
import { MemoryProvider } from "@earendil-works/gondolin";
import { createHttpHooks } from "@earendil-works/gondolin";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const fixedRandom: RandomSource = { hex: () => "0123456789abcdef" };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test("gondolin config is disabled by default", () => {
	assert.equal(parseConfig({}).enabled, false);
	assert.equal(parseConfig({ enabled: false }).enabled, false);
	assert.equal(DEFAULTS_PLACEHOLDER().accel, "tcg");
});

test("gondolin accel defaults to tcg for nested VMs", () => {
	const config = parseConfig({ enabled: true });
	assert.equal(config.accel, "tcg");
	assert.equal(config.httpProxy.enabled, true);
	assert.equal(config.httpProxy.discoverKnownSecrets, true);
	assert.deepEqual(config.allowedHosts, undefined);
	assert.deepEqual(config.envPassthrough, []);
});

test("gondolin config validates and keeps explicit values", () => {
	const config = parseConfig({
		enabled: true,
		accel: "hvf",
		memory: "2G",
		cpus: 4,
		image: "alpine-base:latest",
		allowedHosts: ["api.github.com"],
		envPassthrough: ["LANG", "TZ"],
		httpProxy: {
			secrets: {
				MY_SERVICE_TOKEN: { hosts: ["api.myservice.com"], envVar: "MY_SERVICE_TOKEN" },
				INVALID: { hosts: [] },
			},
		},
	});
	assert.equal(config.accel, "hvf");
	assert.equal(config.memory, "2G");
	assert.equal(config.cpus, 4);
	assert.equal(config.image, "alpine-base:latest");
	assert.deepEqual(config.allowedHosts, ["api.github.com"]);
	assert.deepEqual(config.envPassthrough, ["LANG", "TZ"]);
	assert.deepEqual(Object.keys(config.httpProxy.secrets), ["MY_SERVICE_TOKEN"]);
	assert.deepEqual(config.httpProxy.secrets.MY_SERVICE_TOKEN.hosts, ["api.myservice.com"]);
});

test("gondolin config layering merges secrets and honors env overrides", () => {
	const global = parseConfig({
		enabled: true,
		httpProxy: { secrets: { A_KEY: { hosts: ["a.example"] }, B_KEY: { hosts: ["b.example"] } } },
	});
	const project = parseConfig({
		enabled: true,
		httpProxy: { secrets: { B_KEY: { hosts: ["b2.example"] } } },
	});
	const merged = mergeConfig(global, project);
	assert.deepEqual(Object.keys(merged.httpProxy.secrets).sort(), ["A_KEY", "B_KEY"]);
	assert.deepEqual(merged.httpProxy.secrets.B_KEY.hosts, ["b2.example"]);

	const previous = { ...process.env };
	try {
		process.env.PI_GONDOLIN_ENABLED = "true";
		const fromEnv = envConfig();
		assert.equal(fromEnv.enabled, true);
		assert.equal(fromEnv.accel, "tcg");
		process.env.PI_GONDOLIN_ENABLED = "0";
		assert.equal(envConfig().enabled, false);
	} finally {
		if ("PI_GONDOLIN_ENABLED" in process.env) delete process.env.PI_GONDOLIN_ENABLED;
		process.env.PI_GONDOLIN_CONFIG = JSON.stringify({
			enabled: true,
			allowedHosts: ["*.internal"],
			httpProxy: { secrets: { C_KEY: { hosts: ["c.example"] } } },
		});
		try {
			const layered = envConfig();
			assert.equal(layered.enabled, true);
			assert.deepEqual(layered.allowedHosts, ["*.internal"]);
			assert.deepEqual(layered.httpProxy.secrets.C_KEY.hosts, ["c.example"]);
		} finally {
			delete process.env.PI_GONDOLIN_CONFIG;
			Object.assign(process.env, previous);
		}
	}
});

// ---------------------------------------------------------------------------
// Secret discovery
// ---------------------------------------------------------------------------

test("gondolin discovery finds known api keys and assigns stubs", () => {
	const config = parseConfig({
		enabled: true,
		httpProxy: { secrets: { MY_TOKEN: { hosts: ["api.mine.dev"] } } },
	});
	const secrets = discoverSecrets(
		{
			ANTHROPIC_API_KEY: "sk-ant-real-key-value",
			GITHUB_TOKEN: "ghp_realgithubtoken1234",
			MY_TOKEN: "custom-secret-value-1",
			OPENAI_API_KEY: "too short",
			GROQ_API_KEY: "has whitespace inside",
			DEEPSEEK_API_KEY: "changeme",
		},
		config,
		fixedRandom,
	);
	assert.deepEqual(
		secrets.map((s) => s.name),
		["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "MY_TOKEN"],
	);
	const anthropic = secrets.find((s) => s.name === "ANTHROPIC_API_KEY")!;
	assert.equal(anthropic.value, "sk-ant-real-key-value");
	assert.deepEqual(anthropic.hosts, ["api.anthropic.com"]);
	assert.equal(anthropic.placeholder, "gondolin-stub-ANTHROPIC_API_KEY-0123456789abcdef");
	const custom = secrets.find((s) => s.name === "MY_TOKEN")!;
	assert.deepEqual(custom.hosts, ["api.mine.dev"]);

	// Stub env and secret definitions never leak real values.
	const stubEnv = buildStubEnv(secrets);
	assert.deepEqual(stubEnv, {
		ANTHROPIC_API_KEY: "gondolin-stub-ANTHROPIC_API_KEY-0123456789abcdef",
		GITHUB_TOKEN: "gondolin-stub-GITHUB_TOKEN-0123456789abcdef",
		MY_TOKEN: "gondolin-stub-MY_TOKEN-0123456789abcdef",
	});
	assert.equal(JSON.stringify(stubEnv).includes("sk-ant-real-key-value"), false);
	const definitions = buildSecretDefinitions(secrets);
	assert.equal(definitions.ANTHROPIC_API_KEY.value, "sk-ant-real-key-value");
	assert.equal(definitions.ANTHROPIC_API_KEY.placeholder, "gondolin-stub-ANTHROPIC_API_KEY-0123456789abcdef");
});

test("gondolin discovery respects config toggles", () => {
	const disabled = parseConfig({ enabled: true, httpProxy: { enabled: false } });
	assert.deepEqual(discoverSecrets({ ANTHROPIC_API_KEY: "sk-ant-real-key-value" }, disabled, fixedRandom), []);

	const noCatalog = parseConfig({ enabled: true, httpProxy: { discoverKnownSecrets: false } });
	assert.deepEqual(discoverSecrets({ ANTHROPIC_API_KEY: "sk-ant-real-key-value" }, noCatalog, fixedRandom), []);

	// Custom secrets with a distinct envVar name still work without the catalog.
	const customOnly = parseConfig({
		enabled: true,
		httpProxy: {
			discoverKnownSecrets: false,
			secrets: { SERVICE_KEY: { hosts: ["svc.example"], envVar: "SVC_PROD_KEY" } },
		},
	});
	const secrets = discoverSecrets({ SVC_PROD_KEY: "svc-prod-secret-value" }, customOnly, fixedRandom);
	assert.equal(secrets.length, 1);
	assert.equal(secrets[0].name, "SERVICE_KEY");
	assert.equal(secrets[0].envVar, "SVC_PROD_KEY");

	// The extension's own config channel is never stubbed.
	const weird = parseConfig({
		enabled: true,
		httpProxy: { discoverKnownSecrets: false, secrets: { PI_GONDOLIN_CONFIG: { hosts: ["x"] } } },
	});
	assert.deepEqual(discoverSecrets({ PI_GONDOLIN_CONFIG: "{\"enabled\":true}" }, weird, fixedRandom), []);
});

test("gondolin secret value heuristics reject sentinels", () => {
	assert.equal(looksLikeSecretValue(undefined), false);
	assert.equal(looksLikeSecretValue("short"), false);
	assert.equal(looksLikeSecretValue("contains space value"), false);
	assert.equal(looksLikeSecretValue("placeholder"), false);
	assert.equal(looksLikeSecretValue("12345678"), true);
});

test("gondolin env sanitization scrubs real keys from passthrough values", () => {
	const config = parseConfig({ enabled: true });
	const secrets = discoverSecrets(
		{
			ANTHROPIC_API_KEY: "sk-ant-real-key-value",
			GITHUB_TOKEN: "ghp_realgithubtoken1234",
		},
		config,
		fixedRandom,
	);
	const env = {
		// Embedded in a URL-style value
		NPM_CONFIG_REGISTRY_AUTH: "https://user:sk-ant-real-key-value@registry.example/npm/",
		LANG: "en_US.UTF-8",
		ANTHROPIC_API_KEY: "sk-ant-real-key-value",
	};
	const guest = sanitizeGuestEnv(env, secrets, ["NPM_CONFIG_REGISTRY_AUTH", "LANG", "ANTHROPIC_API_KEY"]);
	assert.equal(guest.ANTHROPIC_API_KEY, "gondolin-stub-ANTHROPIC_API_KEY-0123456789abcdef");
	assert.equal(
		guest.NPM_CONFIG_REGISTRY_AUTH,
		"https://user:gondolin-stub-ANTHROPIC_API_KEY-0123456789abcdef@registry.example/npm/",
	);
	assert.equal(guest.LANG, "en_US.UTF-8");
	// Values never in the passthrough list never reach the guest.
	assert.equal("GITHUB_TOKEN" in guest, false);
	assert.equal(JSON.stringify(guest).includes("ghp_realgithubtoken1234"), false);
});

// ---------------------------------------------------------------------------
// Guest env + path mapping
// ---------------------------------------------------------------------------

test("gondolin guest env is minimal and never copies host env wholesale", () => {
	const env = buildGuestEnv({
		hostEnv: { ...GUEST_BASE_ENV, HOST_ONLY: "leak", LANG: "en_US.UTF-8" },
		secrets: [],
		passthrough: ["LANG"],
	});
	assert.deepEqual(env, { LANG: "en_US.UTF-8" });
	assert.equal("HOST_ONLY" in env, false);
});

test("gondolin path mapping escapes are rejected", () => {
	assert.equal(toGuestPath("/work", "/work", "/workspace"), "/workspace");
	assert.equal(toGuestPath("/work", "/work/src/a.ts", "/workspace"), "/workspace/src/a.ts");
	assert.throws(() => toGuestPath("/work", "/etc/passwd", "/workspace"));
	assert.throws(() => toGuestPath("/work", "/work/../secret", "/workspace"));
});

// ---------------------------------------------------------------------------
// HTTP hook contract (real gondolin createHttpHooks engine)
// ---------------------------------------------------------------------------

test("gondolin http hooks inflate stubs to real keys only for allowed hosts", async () => {
	const { httpHooks } = createHttpHooks({
		secrets: {
			TOK: { hosts: ["api.example.com"], value: "real-secret-value-123", placeholder: "gondolin-stub-TOK-aaaa" },
		},
	});
	const auth = async (url: string, headers: Record<string, string>) => {
		const result = await httpHooks.onRequest!(new Request(url, { headers }));
		return (result as Request).headers.get("authorization");
	};

	// Stub to its allowed host is inflated back into the real credential.
	assert.equal(await auth("https://api.example.com/v1", { Authorization: "Bearer gondolin-stub-TOK-aaaa" }), "Bearer real-secret-value-123");

	// A real, non-stub API key passes through untouched.
	assert.equal(await auth("https://api.example.com", { Authorization: "Bearer sk-real-other-key-xyz" }), "Bearer sk-real-other-key-xyz");

	// A request with no credential passes through untouched.
	assert.equal(await auth("https://example.com", {}), null);

	// A stub sent to a host that is not its allowed host is blocked (defense in
	// depth), so stubs never leak to arbitrary hosts.
	await assert.rejects(
		() => Promise.resolve(httpHooks.onRequest!(new Request("https://evil.example", { headers: { Authorization: "Bearer gondolin-stub-TOK-aaaa" } }))),
		(err: unknown) => (err as { status?: number }).status === 403,
	);
});

// ---------------------------------------------------------------------------
// Extension factory (disabled state must stay completely inert)
// ---------------------------------------------------------------------------

test("gondolin extension leaves tools local while disabled", async () => {
	delete process.env.PI_GONDOLIN_ENABLED;
	delete process.env.PI_GONDOLIN_CONFIG;
	// Isolate HOME: a real ~/.pi/agent/gondolin.json with enabled:true would
	// otherwise flip this "disabled" test onto the VM path.
	const isolatedHome = await mkdtemp(join(tmpdir(), "pi-gondolin-test-home-"));
	const previousHome = process.env.HOME;
	process.env.HOME = isolatedHome;
	try {
	const { default: gondolinExtension } = await import("../index.ts");

	const tools = new Map<string, { name: string; execute: (id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }> }>();
	const pi = {
		on: () => {},
		registerCommand: () => {},
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
	} as unknown as ExtensionAPI;
	gondolinExtension(pi);
	assert.deepEqual([...tools.keys()].sort(), ["bash", "edit", "read", "write"]);

	// A local read must succeed without any VM boot attempt (booting would
	// download a guest image or fail on missing QEMU, so this stays fast only
	// if the disabled path truly delegates to the local tool).
	const directory = await mkdtemp(join(tmpdir(), "pi-gondolin-disabled-"));
	try {
		const file = join(directory, "note.txt");
		await writeFile(file, "local content");
		const result = await tools.get("read")!.execute("t1", { path: file });
		assert.equal(result.content[0]?.text.includes("local content"), true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await rm(isolatedHome, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Shared handle (symbol-keyed global reused by other extensions)
// ---------------------------------------------------------------------------

test("gondolin shared handle installs and reads via the registered symbol", () => {
	const handle: import("../src/shared.ts").GondolinShared = {
		version: 1,
		hostCwd: "/host",
		guestWorkspace: "/workspace",
		mounts: [],
		isEnabled: () => true,
		refreshTrust: () => true,
		ensureVm: async () => null as unknown as VM,
		getVm: () => null,
		toGuestPath: (p) => p,
		registerFsGuard: () => () => {},
		execGuest: () => {
			throw new Error("not under test");
		},
	};
	installGondolinShared(handle);
	try {
		assert.equal(getGondolinShared(), handle);
		// Wrong contract versions are rejected.
		(globalThis as Record<symbol, unknown>)[GONDOLIN_SHARED_KEY] = { ...handle, version: 2 as unknown as 1 };
		assert.equal(getGondolinShared(), undefined);
	} finally {
		clearGondolinSharedForTest();
	}
	assert.equal(getGondolinShared(), undefined);
});

test("gondolin shared path mapping converts host and guest paths", () => {
	assert.equal(toHostPath("/host/proj", "/workspace", "/src/a.ts"), "/host/proj/src/a.ts");
	assert.equal(toHostPath("/host/proj", "/workspace", "/workspace/src/a.ts"), "/host/proj/src/a.ts");
	assert.equal(toHostPath("/host/proj", "/workspace", "/"), "/host/proj");
	assert.equal(hostPathToGuestPath("/host/proj", "/workspace", "/host/proj/src/a.ts"), "/workspace/src/a.ts");
	assert.equal(hostPathToGuestPath("/host/proj", "/workspace", "/host/proj"), "/workspace");
	assert.equal(hostPathToGuestPath("/host/proj", "/workspace", "/etc/passwd"), undefined);
});

test("gondolin write-op classification covers flags and mutating ops", () => {
	assert.equal(isWriteFsOp("open", 0), false); // O_RDONLY
	assert.equal(isWriteFsOp("open", 1), true); // O_WRONLY
	assert.equal(isWriteFsOp("open", 2), true); // O_RDWR
	assert.equal(isWriteFsOp("open", "r"), false);
	assert.equal(isWriteFsOp("open", "w"), true);
	assert.equal(isWriteFsOp("open", "a+"), true);
	assert.equal(isWriteFsOp("mkdir", undefined), true);
	assert.equal(isWriteFsOp("unlink", undefined), true);
	assert.equal(isWriteFsOp("readdir", undefined), false);
});

test("gondolin guarded workspace provider denies with EACCES and skips handle I/O", async () => {
	const backend = new MemoryProvider();
	await backend.writeFile!("/secret.txt", Buffer.from("classified"));
	await backend.writeFile!("/public.txt", Buffer.from("hello world"));

	const guards = new Set<GondolinFsGuard>();
	const seen: FsGuardRequest[] = [];
	guards.add({
		before: async (request) => {
			seen.push(request);
			return request.hostPath.endsWith("secret.txt") ? { reason: `denied ${request.hostPath}` } : undefined;
		},
		after: async () => {},
	});

	const provider = createGuardedWorkspaceProvider(backend, guards, "/host/proj", "/workspace");

	await assert.rejects(provider.readFile("/secret.txt"), (error: unknown) => {
		const err = error as NodeJS.ErrnoException;
		assert.equal(err.code, "EACCES");
		assert.equal(err.errno, 13);
		assert.equal(err.message.includes("denied /host/proj/secret.txt"), true);
		return true;
	});

	// Allowed path passes through and maps to the host path.
	assert.equal((await provider.readFile("/public.txt")).toString(), "hello world");
	assert.equal(seen.at(-1)?.hostPath, "/host/proj/public.txt");

	// Write intent is detected from numeric open flags.
	await provider.open("/public.txt", "r");
	assert.equal(seen.at(-1)?.write, false);
	await provider.open("/public.txt", "w");
	assert.equal(seen.at(-1)?.write, true);

	// The open gates the handle; readFile afterwards is a cheap re-check of the
	// same (already allowed) path — no prompt, no error.
	seen.length = 0;
	const handle = await provider.open("/public.txt", "r");
	await handle.readFile();
	assert.deepEqual(seen.map((request) => request.op), ["open", "readFile"]);
	assert.equal(seen.every((request) => !request.write), true);

	// Rename consults the guard once per path.
	seen.length = 0;
	await assert.rejects(provider.rename("/public.txt", "/secret.txt"));
	assert.deepEqual(
		seen.map((request) => request.guestPath).sort(),
		["/public.txt", "/secret.txt"],
	);

	// Unregistering stops enforcement.
	guards.clear();
	assert.equal((await provider.readFile("/secret.txt")).toString(), "classified");
});

test("gondolin stubifyEnv replaces credential values and names with stubs", () => {
	const config = parseConfig({
		enabled: true,
		httpProxy: { secrets: { MY_TOKEN: { hosts: ["api.mine.dev"] } } },
	});
	const secrets = discoverSecrets({ MY_TOKEN: "real-secret-value" }, config, fixedRandom);
	const stubbed = stubifyEnv(
		{ MY_TOKEN: "real-secret-value", OTHER_KEY: "another-secret-value", UNRELATED: "plain" },
		secrets,
	);
	assert.equal(stubbed.MY_TOKEN, secrets[0].placeholder);
	assert.equal(stubbed.OTHER_KEY, "another-secret-value");
	assert.equal(stubbed.UNRELATED, "plain");
});

test("gondolin execGuest launches via the guest shell with stubbed env", async () => {
	const config = parseConfig({
		enabled: true,
		httpProxy: { secrets: { MY_TOKEN: { hosts: ["api.mine.dev"] } } },
	});
	const secrets = discoverSecrets({ MY_TOKEN: "real-secret-value" }, config, fixedRandom);

	const calls: Array<{ command: unknown; options: Record<string, unknown> }> = [];
	const fakeResult = { exitCode: 0, stdout: "", stderr: "" };
	const fakeVm = {
		exec(command: unknown, options: Record<string, unknown>) {
			calls.push({ command, options });
			return { write: () => {}, end: () => {}, stdout: null, stderr: null, result: Promise.resolve(fakeResult) };
		},
	} as unknown as VM;

	const proc = launchGuestProcess(
		fakeVm,
		{ command: "npx", args: ["-y", "some mcp server"], env: { MY_TOKEN: "real-secret-value", EXTRA: "1" } },
		secrets,
		"/workspace",
	);

	assert.deepEqual(calls.length, 1);
	assert.deepEqual(calls[0].command, ["/bin/sh", "-c", "exec 'npx' '-y' 'some mcp server'"]);
	const options = calls[0].options;
	assert.equal(options.cwd, "/workspace");
	assert.equal(options.stdin, true);
	assert.equal(options.stdout, "pipe");
	assert.equal(options.stderr, "pipe");
	const env = options.env as Record<string, string>;
	assert.equal(env.MY_TOKEN, secrets[0].placeholder);
	assert.equal(env.EXTRA, "1");
	assert.equal(env.PATH, GUEST_BASE_ENV.PATH);
	assert.equal(await proc.result, fakeResult);
});

// ---------------------------------------------------------------------------
// Config authority model (global ceiling / repo restrict-only / env overrides)
// ---------------------------------------------------------------------------

test("gondolin parseEnablementEnv recognizes force and dangerously-force-disable", () => {
	const parse = parseEnablementEnv;
	assert.equal(parse(undefined), undefined);
	assert.equal(parse(""), undefined);
	assert.equal(parse("nope"), undefined);
	assert.equal(parse("force"), true);
	assert.equal(parse("FORCE"), true);
	assert.equal(parse("true"), true);
	assert.equal(parse("1"), true);
	assert.equal(parse("dangerously-force-disable"), false);
	assert.equal(parse("dangerously_force_disable"), false);
	assert.equal(parse("dangerouslyforcedisable"), false);
	assert.equal(parse("false"), false);
	assert.equal(parse("0"), false);
});

test("gondolin default mounts are the skills dirs, read-only", () => {
	const mounts = defaultMounts("/home/me");
	assert.deepEqual(mounts, [
		{ hostPath: "/home/me/.pi/agent/skills", access: "ro", guestPath: "/root/.pi/agent/skills" },
		{ hostPath: "/home/me/.agents/skills", access: "ro", guestPath: "/root/.agents/skills" },
	]);
});

test("gondolin parseConfig mounts default to skills, and explicit mounts replace", () => {
	const disabled = parseConfig({});
	assert.equal(disabled.mounts.length, 2);
	assert.equal(disabled.mounts.every((m) => m.access === "ro"), true);

	const enabled = parseConfig({
		enabled: true,
		mounts: {
			"skills": "ro",
			"~/docs": "rw",
			"/abs/ref": { access: "ro", guestPath: "/ref" },
			"relative/path": "ro",
			"skills-dup": "rw",
		},
	});
	// skills alias expands to both dirs; ~ expansion + explicit guest path honored; relative key ignored.
	assert.deepEqual(
		enabled.mounts.map((m) => ({ hostPath: m.hostPath, access: m.access, guestPath: m.guestPath })),
		[
			{ hostPath: join(homedir(), ".pi", "agent", "skills"), access: "ro", guestPath: "/root/.pi/agent/skills" },
			{ hostPath: join(homedir(), ".agents", "skills"), access: "ro", guestPath: "/root/.agents/skills" },
			{ hostPath: join(homedir(), "docs"), access: "rw", guestPath: "/mnt/docs" },
			{ hostPath: "/abs/ref", access: "ro", guestPath: "/ref" },
		],
	);
});

test("gondolin normalizeHostKey expands the skills alias to both dirs", () => {
	assert.deepEqual(normalizeHostKey("skills", "/home/me"), [
		"/home/me/.pi/agent/skills",
		"/home/me/.agents/skills",
	]);
	assert.deepEqual(normalizeHostKey("~", "/home/me"), ["/home/me"]);
	assert.deepEqual(normalizeHostKey("~/x", "/home/me"), ["/home/me/x"]);
	assert.deepEqual(normalizeHostKey("/abs", "/home/me"), ["/abs"]);
	assert.equal(normalizeHostKey("relative", "/home/me"), undefined);
});

test("gondolin defaultSkillsGuestPath mirrors skills dirs under /root", () => {
	const home = "/home/me";
	assert.equal(defaultSkillsGuestPath(join(home, ".pi", "agent", "skills"), home), "/root/.pi/agent/skills");
	assert.equal(defaultSkillsGuestPath(join(home, ".agents", "skills"), home), "/root/.agents/skills");
	assert.equal(defaultSkillsGuestPath(join(home, "docs"), home), undefined);
});

test("gondolin explicit skills paths mirror their host layout under /root", () => {
	// Explicit ~ paths get the skills default guest path too, so one dir can be
	// dropped or upgraded without touching the other.
	const onlyAgents = parseConfig({ enabled: true, mounts: { "~/.agents/skills": "rw" } });
	assert.deepEqual(onlyAgents.mounts, [
		{ hostPath: join(homedir(), ".agents", "skills"), access: "rw", guestPath: "/root/.agents/skills" },
	]);

	// A later explicit key overrides one dir of the alias (order: later wins).
	const overridden = parseConfig({
		enabled: true,
		mounts: { "skills": "ro", "~/.agents/skills": { access: "rw", guestPath: "/skills" } },
	});
	assert.deepEqual(
		overridden.mounts.map((m) => `${m.hostPath}:${m.access}:${m.guestPath}`),
		[
			`${join(homedir(), ".pi", "agent", "skills")}:ro:/root/.pi/agent/skills`,
			`${join(homedir(), ".agents", "skills")}:rw:/skills`,
		],
	);
});

test("gondolin restrictMounts only narrows the ceiling", () => {
	const ceiling: MountConfig[] = [
		{ hostPath: "/skills", access: "ro", guestPath: "/skills" },
		{ hostPath: "/docs", access: "rw", guestPath: "/mnt/docs" },
	];
	// rw request under ro ceiling is clamped to ro.
	assert.deepEqual(
		restrictMounts(ceiling, [{ hostPath: "/skills", access: "rw", guestPath: "/skills" }]),
		[{ hostPath: "/skills", access: "ro", guestPath: "/skills" }],
	);
	// ro request under rw ceiling downgrades.
	assert.deepEqual(
		restrictMounts(ceiling, [{ hostPath: "/docs", access: "ro", guestPath: "/mnt/docs" }]),
		[{ hostPath: "/docs", access: "ro", guestPath: "/mnt/docs" }],
	);
	// new path outside the ceiling is ignored; omission removes.
	assert.deepEqual(
		restrictMounts(ceiling, [{ hostPath: "/secret", access: "ro", guestPath: "/mnt/secret" }]),
		[],
	);
	// no request = inherit the ceiling.
	assert.equal(restrictMounts(ceiling, undefined).length, 2);
});

test("gondolin applyLayer trusted overrides prefs but restricts mounts", () => {
	const base = parseConfig({
		enabled: true,
		accel: "tcg",
		allowedHosts: ["a.example", "b.example"],
		envPassthrough: ["LANG", "TZ"],
		mounts: { "skills": "ro", "~/docs": "rw" },
		httpProxy: { secrets: { A: { hosts: ["a.example", "x.example"] } } },
	});
	const repo = parseLayer({
		accel: "hvf",
		allowedHosts: ["a.example"],
		mounts: { "skills": "ro" },
	});
	const out = applyLayer(base, repo, "trusted");
	assert.equal(out.accel, "hvf");
	assert.deepEqual(out.allowedHosts, ["a.example"]);
	assert.deepEqual(out.envPassthrough, ["LANG", "TZ"]); // trusted override: absent = keep base
	// mounts restricted: docs dropped, both skills dirs kept ro.
	assert.deepEqual(out.mounts, [
		{ hostPath: join(homedir(), ".pi", "agent", "skills"), access: "ro", guestPath: "/root/.pi/agent/skills" },
		{ hostPath: join(homedir(), ".agents", "skills"), access: "ro", guestPath: "/root/.agents/skills" },
	]);
	// secret survives (trusted full override, repo didn't touch it).
	assert.deepEqual(Object.keys(out.httpProxy.secrets), ["A"]);
});

test("gondolin applyLayer untrusted can only restrict", () => {
	const base = parseConfig({
		enabled: true,
		accel: "tcg",
		allowedHosts: ["a.example", "b.example"],
		envPassthrough: ["LANG", "TZ"],
		mounts: { "skills": "ro", "~/docs": "rw" },
		httpProxy: { enabled: true, discoverKnownSecrets: true, secrets: { A: { hosts: ["a.example", "x.example"] }, B: { hosts: ["b.example"] } } },
	});
	const repo = parseLayer({
		enabled: false, // ignored
		accel: "hvf", // ignored
		allowedHosts: ["a.example", "z.example"], // narrowed to intersection
		envPassthrough: ["LANG", "ZZ"], // narrowed
		mounts: { "skills": "rw", "~/docs": "ro", "/secret": "ro" }, // skills clamped to ro, docs downgraded, secret ignored
		httpProxy: {
			enabled: false, // honored
			discoverKnownSecrets: false, // honored
			secrets: { A: { hosts: ["a.example"] }, B: { hosts: [] }, C: { hosts: ["c.example"] } }, // A narrowed, B removed, C ignored
		},
	});
	const out = applyLayer(base, repo, "untrusted");
	assert.equal(out.enabled, true); // cannot disable
	assert.equal(out.accel, "tcg"); // cannot change
	assert.deepEqual(out.allowedHosts, ["a.example"]);
	assert.deepEqual(out.envPassthrough, ["LANG"]);
	assert.equal(out.httpProxy.enabled, false);
	assert.equal(out.httpProxy.discoverKnownSecrets, false);
	assert.deepEqual(Object.keys(out.httpProxy.secrets), ["A"]);
	assert.deepEqual(out.httpProxy.secrets.A.hosts, ["a.example"]);
	assert.deepEqual(
		out.mounts.map((m) => m.access),
		["ro", "ro", "ro"],
	);
	assert.deepEqual(
		out.mounts.map((m) => m.hostPath),
		[join(homedir(), ".pi", "agent", "skills"), join(homedir(), ".agents", "skills"), join(homedir(), "docs")],
	);
});

test("gondolin env layer force-enables over a disabled global, and dangerously-force-disable wins", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-gondolin-home-"));
	const repo = await mkdtemp(join(tmpdir(), "pi-gondolin-repo-"));
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await mkdir(join(repo, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "agent", "gondolin.json"), JSON.stringify({ enabled: false }));
	const previousHome = process.env.HOME;
	const previous = { ...process.env };
	try {
		process.env.HOME = home;
		delete process.env.PI_GONDOLIN_ENABLED;
		delete process.env.PI_GONDOLIN_CONFIG;
		assert.equal(loadConfig({ cwd: repo, isProjectTrusted: () => true }).enabled, false);

		process.env.PI_GONDOLIN_ENABLED = "force";
		assert.equal(loadConfig({ cwd: repo, isProjectTrusted: () => false }).enabled, true);

		await writeFile(join(home, ".pi", "agent", "gondolin.json"), JSON.stringify({ enabled: true }));
		process.env.PI_GONDOLIN_ENABLED = "dangerously-force-disable";
		assert.equal(loadConfig({ cwd: repo, isProjectTrusted: () => true }).enabled, false);

		// PI_GONDOLIN_CONFIG mounts replace the ceiling (env is unconditional).
		process.env.PI_GONDOLIN_ENABLED = "force";
		process.env.PI_GONDOLIN_CONFIG = JSON.stringify({ mounts: { "/opt/data": "rw" } });
		const envMounted = loadConfig({ cwd: repo, isProjectTrusted: () => false });
		assert.equal(envMounted.enabled, true);
		assert.deepEqual(envMounted.mounts, [{ hostPath: "/opt/data", access: "rw", guestPath: "/mnt/data" }]);
	} finally {
		process.env.HOME = previousHome;
		delete process.env.PI_GONDOLIN_ENABLED;
		delete process.env.PI_GONDOLIN_CONFIG;
		Object.assign(process.env, previous);
		await rm(home, { recursive: true, force: true });
		await rm(repo, { recursive: true, force: true });
	}
});

test("gondolin loadConfig layers global ceiling and repo restrictions", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-gondolin-home-"));
	const repo = await mkdtemp(join(tmpdir(), "pi-gondolin-repo-"));
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await mkdir(join(repo, ".pi"), { recursive: true });
	await writeFile(
		join(home, ".pi", "agent", "gondolin.json"),
		JSON.stringify({
			enabled: true,
			accel: "tcg",
			mounts: { "skills": "ro", "~/docs": "rw" },
			allowedHosts: ["a.example", "b.example"],
			envPassthrough: ["LANG", "TZ"],
			httpProxy: { secrets: { A: { hosts: ["a.example", "x.example"] }, B: { hosts: ["b.example"] } } },
		}),
	);
	const previousHome = process.env.HOME;
	const previous = { ...process.env };
	try {
		process.env.HOME = home;
		delete process.env.PI_GONDOLIN_ENABLED;
		delete process.env.PI_GONDOLIN_CONFIG;

		// trusted repo overrides prefs and restricts mounts.
		await writeFile(join(repo, ".pi", "gondolin.json"), JSON.stringify({ accel: "hvf", mounts: { "skills": "ro" } }));
		const trusted = loadConfig({ cwd: repo, isProjectTrusted: () => true });
		assert.equal(trusted.accel, "hvf");
		assert.deepEqual(trusted.mounts, [
			{ hostPath: join(home, ".pi", "agent", "skills"), access: "ro", guestPath: "/root/.pi/agent/skills" },
			{ hostPath: join(home, ".agents", "skills"), access: "ro", guestPath: "/root/.agents/skills" },
		]);

		// untrusted repo can only restrict.
		await writeFile(join(repo, ".pi", "gondolin.json"), JSON.stringify({ enabled: false, mounts: { "~/docs": "ro" } }));
		const untrusted = loadConfig({ cwd: repo, isProjectTrusted: () => false });
		assert.equal(untrusted.enabled, true); // cannot disable
		assert.equal(untrusted.accel, "tcg"); // cannot change
		assert.deepEqual(untrusted.mounts, [
			{ hostPath: join(home, "docs"), access: "ro", guestPath: "/mnt/docs" },
		]);
	} finally {
		process.env.HOME = previousHome;
		Object.assign(process.env, previous);
		delete process.env.PI_GONDOLIN_ENABLED;
		delete process.env.PI_GONDOLIN_CONFIG;
		await rm(home, { recursive: true, force: true });
		await rm(repo, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Extra mounts: provider building + host↔guest mapping
// ---------------------------------------------------------------------------

test("gondolin buildExtraMountProviders wraps ro mounts and skips missing/duplicate paths", async () => {
	const skills = await mkdtemp(join(tmpdir(), "pi-gondolin-skills-"));
	const docs = await mkdtemp(join(tmpdir(), "pi-gondolin-docs-"));
	await writeFile(join(skills, "SKILL.md"), "# skill");
	const guards = new Set<GondolinFsGuard>();
	const seen: FsGuardRequest[] = [];
	guards.add({ before: async (r) => { seen.push(r); return undefined; }, after: async () => {} });

	const build = buildExtraMountProviders(
		[
			{ hostPath: skills, access: "ro", guestPath: "/root/.pi/agent/skills" },
			{ hostPath: docs, access: "rw", guestPath: "/mnt/docs" },
			{ hostPath: "/definitely/not/there", access: "ro", guestPath: "/mnt/missing" },
		],
		guards,
	);
	assert.deepEqual(Object.keys(build.mounts).sort(), ["/mnt/docs", "/root/.pi/agent/skills"]);
	assert.equal(build.skipped.length, 1);
	assert.equal(build.skipped[0].guestPath, "/mnt/missing");

	// Read-only mount blocks writes with EROFS (errno 30) before the guard runs.
	await assert.rejects(build.mounts["/root/.pi/agent/skills"].open("/SKILL.md", "w"), (error: unknown) => {
		const err = error as NodeJS.ErrnoException;
		assert.equal(Math.abs((err.errno as number) ?? 0), 30);
		return true;
	});

	// Reads pass through and the guard sees the mapped host path.
	seen.length = 0;
	await build.mounts["/root/.pi/agent/skills"].readFile!("/SKILL.md");
	assert.equal(seen.at(-1)?.hostPath, join(skills, "SKILL.md"));
	assert.equal(seen.at(-1)?.guestPath, "/SKILL.md");

	// Read-write mount allows writes (to the temp dir).
	await build.mounts["/mnt/docs"].writeFile!("/note.txt", Buffer.from("hi"));
	assert.equal((await build.mounts["/mnt/docs"].readFile!("/note.txt")).toString(), "hi");

	await rm(skills, { recursive: true, force: true });
	await rm(docs, { recursive: true, force: true });
});

test("gondolin mapHostToGuestPath resolves workspace and extra mounts", () => {
	const mounts = [
		{ hostPath: "/home/me/.pi/agent/skills", guestPath: "/root/.pi/agent/skills" },
		{ hostPath: "/home/me/docs", guestPath: "/mnt/docs" },
	];
	assert.equal(mapHostToGuestPath("/host/proj", "/workspace", [], "/host/proj/src/a.ts"), "/workspace/src/a.ts");
	assert.equal(mapHostToGuestPath("/host/proj", "/workspace", mounts, "/home/me/.pi/agent/skills"), "/root/.pi/agent/skills");
	assert.equal(
		mapHostToGuestPath("/host/proj", "/workspace", mounts, "/home/me/docs/sub/note.md"),
		"/mnt/docs/sub/note.md",
	);
	assert.equal(mapHostToGuestPath("/host/proj", "/workspace", mounts, "/etc/passwd"), undefined);
});

test("gondolin buildSandboxPromptAddendum lists mounts and proxy stubs", () => {
	const withProxy = parseConfig({
		enabled: true,
		mounts: { "skills": "ro", "~/docs": "rw" },
	});
	const addendum = buildSandboxPromptAddendum(withProxy, "/host/proj");
	assert.equal(addendum.includes("## Gondolin sandbox"), true);
	assert.equal(addendum.includes("read-write at /workspace"), true);
	assert.equal(addendum.includes("/root/.pi/agent/skills"), true);
	assert.equal(addendum.includes("/root/.agents/skills"), true);
	assert.equal(addendum.includes("read-only"), true);
	assert.equal(addendum.includes("gondolin-stub-"), true);

	const noProxy = parseConfig({ enabled: true, httpProxy: { enabled: false } });
	assert.equal(buildSandboxPromptAddendum(noProxy, "/host/proj").includes("gondolin-stub-"), false);
});
