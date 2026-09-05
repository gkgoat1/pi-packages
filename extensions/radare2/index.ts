/**
 * radare2 integration for Pi: sandboxed r2pipe sessions + curated r2_* tools.
 *
 * - Every r2 process runs confined: Seatbelt on macOS (bundled radare2.sb
 *   profile, my.sb-inspired), bubblewrap user namespaces on Linux, or the
 *   Gondolin VM when `sandbox.backend` is "gondolin" (opt-in, both platforms;
 *   on macOS the QEMU process itself stays Seatbelt-wrapped by the host
 *   profile the user runs pi under).
 * - Commands are not restricted at the policy layer — the sandbox is.
 * - Fail closed: probe failures, missing sandbox tooling, or a Gondolin
 *   backend that is selected but unavailable all produce errors, never an
 *   unsandboxed run (bare-run on macOS only when already nested in Seatbelt).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, findR2Binary, loadRadare2Config, type Radare2Config } from "./src/config.ts";
import { R2Session, r2Argv } from "./src/r2client.ts";
import { SessionRegistry } from "./src/sessions.ts";
import { registerR2Tools } from "./src/tools.ts";
import {
	createBwrapBackend,
	createGondolinBackend,
	createSeatbeltBackend,
	getGondolinHandle,
	SandboxError,
	type GondolinHandle,
	type Sandbox,
	type SandboxedSpawn,
	type SpawnPlan,
} from "./src/sandbox/index.ts";

const PROFILE_RELATIVE = join("src", "sandbox", "radare2.sb");

function loadProfileText(): string {
	// Bundled (dist/radare2/index.js) → profile is copied next to the bundle.
	// Source-run (jiti) → resolve relative to this module.
	const candidates = [
		join(fileURLToPath(new URL(`./${PROFILE_RELATIVE}`, import.meta.url))),
		join(fileURLToPath(new URL("./radare2.sb", import.meta.url))),
	];
	for (const candidate of candidates) {
		try {
			return readFileSync(candidate, "utf8");
		} catch {
			continue;
		}
	}
	throw new Error("radare2 extension: bundled Seatbelt profile not found (radare2.sb)");
}

interface ActiveState {
	config: Radare2Config;
	backend: Sandbox;
	registry: SessionRegistry;
	gondolin?: GondolinHandle;
}

export default function radare2Extension(pi: ExtensionAPI) {
	let state: ActiveState | undefined;
	let startupError: string | undefined;
	let projectDir = process.cwd();

	const openLocation = async (
		location: string,
		signal: AbortSignal | undefined,
		analyze: boolean,
	): Promise<{ handle: string; sandbox: string; info: string }> => {
		const current = state;
		if (!current) throw new Error("radare2 extension is not active");
		// The registry enforces maxOpenSessions; openImpl resolves the sandbox
		// plan (fresh per session so per-session temp profiles are used) and
		// attaches the spawned process.
		const record = await current.registry.open(
			{ location, projectDir, tmpDir: tmpdir(), signal },
			current.config.maxOpenSessions,
		);
		const functions = await record.session.cmdj<Array<{ name: string }>>("afl").catch(() => []);
		let extra = "";
		if (analyze) {
			await record.session.cmd("aaa");
			extra = "\nanalysis: aaa (auto)";
		} else {
			extra = "\nanalysis: skipped";
		}
		const info = `location: ${location}${extra}\n${summary(functions)}`;
		return { handle: record.handle, sandbox: record.sandbox, info };
	};

	const summary = (functions: Array<{ name: string }>): string =>
		`functions: ${functions.length}${functions.length > 0 ? ` (e.g. ${functions.slice(0, 3).map((f) => f.name).join(", ")})` : ""}`;

	/** Injected open implementation: sandbox plan → spawn → R2Session handshake. */
	const makeOpenImpl = (current: ActiveState): SessionRegistry["openImpl"] => {
		return async (options) => {
			const r2Binary = current.config.r2Path.includes("/")
				? current.config.r2Path
				: findR2Binary(current.config.r2Path) ?? current.config.r2Path;
			const spawnResult = await current.backend.spawn({
				r2Binary,
				r2Args: r2Argv(options.location),
				projectDir: options.projectDir,
				tmpDir: options.tmpDir,
				signal: options.signal,
			});
			const plan: SpawnPlan = current.backend.backendName === "gondolin"
				? (current.backend as ReturnType<typeof createGondolinBackend>).plan({
						r2Binary,
						r2Args: r2Argv(options.location),
						projectDir: options.projectDir,
						tmpDir: options.tmpDir,
						signal: options.signal,
					})
				: spawnResult;
			const session = new R2Session({
				timeoutMs: current.config.timeoutMs,
				signal: options.signal,
			});
			if (plan.kind === "gondolin") {
				await plan.handle.ensureVm();
				const guestProc = plan.handle.execGuest({
					command: plan.guestBinary,
					args: plan.args,
					cwd: plan.cwd,
					signal: options.signal,
				});
				session.attachProcess({
					stdin: {
						write: (data) => guestProc.write(data),
						end: () => guestProc.end(),
					},
					stdout: guestProc.stdout,
					stderr: guestProc.stderr,
					onExit: (handler) => {
						void guestProc.result.then(() => handler()).catch(() => handler());
						return () => {};
					},
					kill: () => guestProc.end(),
				});
				await session.handshake();
				return { session, sandboxName: "gondolin" };
			}
			// Host backends (seatbelt / seatbelt-nested / bwrap): the plan holds
			// the wrapped argv; spawn it and attach. For the nested backend the
			// plan IS the r2 argv (already confined by the enclosing sandbox).
			const hostPlan = plan;
			const child = spawn(hostPlan.command, hostPlan.args, {
				stdio: ["pipe", "pipe", "pipe"] as const,
				env: { ...process.env, ...hostPlan.env },
			});
			session.attachProcess({
				stdin: {
					write: (data) => child.stdin.write(data),
					end: () => child.stdin.end(),
				},
				stdout: child.stdout,
				onExit: (handler) => {
					const wrapped = (): void => handler();
					child.once("exit", wrapped);
					return () => child.off("exit", wrapped);
				},
				kill: () => child.kill("SIGKILL"),
			});
			await session.handshake();
			return { session, sandboxName: current.backend.backendName };
		};
	};

	const activate = async (cwd: string, trusted: boolean): Promise<boolean> => {
		const config = loadRadare2Config(trusted ? cwd : undefined);
		projectDir = cwd;
		if (config.enabled === "off") return false;
		const r2Binary = findR2Binary(config.r2Path);
		if (!r2Binary) {
			if (config.enabled === "on") {
				startupError = `radare2 binary "${config.r2Path}" not found (set r2Path in radare2.json or PI_R2_PATH).`;
			}
			return false;
		}
		if (config.sandbox.backend === "gondolin") {
			const gondolin = getGondolinHandle();
			if (!gondolin) {
				startupError = 'sandbox.backend is "gondolin" but the Gondolin sandbox extension is not loaded; radare2 tools are disabled.';
				return false;
			}
			gondolin.refreshTrust(trusted);
		}
		const resolved: Radare2Config = { ...config, r2Path: r2Binary };
		let backend: Sandbox;
		try {
			if (resolved.sandbox.backend === "gondolin") {
				const handle = getGondolinHandle();
				if (!handle || !handle.isEnabled()) {
					throw new SandboxError(
						'sandbox.backend is "gondolin" but the Gondolin sandbox extension is not loaded/enabled; radare2 tools are disabled.',
						"gondolin",
					);
				}
				backend = createGondolinBackend(handle);
			} else if (process.platform === "darwin") {
				backend = await createSeatbeltBackend(
					{ profileText: loadProfileText(), extraDenies: resolved.sandbox.extraSeatbeltDenies },
					process.platform,
				);
			} else {
				backend = createBwrapBackend(process.platform);
			}
		} catch (error) {
			startupError = error instanceof Error ? error.message : String(error);
			return false;
		}
		const registry = new SessionRegistry();
		const current: ActiveState = { config: resolved, backend, registry };
		registry.openImpl = makeOpenImpl(current);
		state = current;
		return true;
	};

	pi.on("session_start", async (_event, ctx) => {
		startupError = undefined;
		await state?.registry.closeAll();
		state = undefined;
		await activate(ctx.cwd, ctx.isProjectTrusted());
	});

	pi.on("session_shutdown", async () => {
		await state?.registry.closeAll();
		state = undefined;
	});

	pi.registerCommand("r2", {
		description: "Show radare2 extension status (backend, sessions, config)",
		handler: async (_args, ctx) => {
			if (!state) {
				ctx.ui.notify(
					startupError ?? "radare2 tools are not active (binary not found, or enabled=off).",
					"warning",
				);
				return;
			}
			const sessions = state.registry.list();
			ctx.ui.notify(
				[
					`r2: ${state.config.r2Path}`,
					`sandbox: ${state.backend.backendName}`,
					`backend setting: ${state.config.sandbox.backend}`,
					`autoAnalyze: ${state.config.autoAnalyze}`,
					`allowProjects: ${state.config.allowProjects}`,
					`allowRemote: ${state.config.allowRemote}`,
					`timeoutMs: ${state.config.timeoutMs}`,
					`sessions: ${sessions.length === 0 ? "none" : sessions.map((s) => `${s.handle} (${s.location}, ${s.sandbox})`).join(", ")}`,
				].join("\n"),
				"info",
			);
		},
	});

	// Tools are registered up-front so they appear in listings; execute
	// fail-closed when the extension could not activate.
	registerR2Tools(pi, {
		get config(): Radare2Config {
			return state?.config ?? DEFAULT_CONFIG;
		},
		get registry(): SessionRegistry {
			if (!state) throw new Error(startupError ?? "radare2 extension is not active (no sandbox backend).");
			return state.registry;
		},
		openLocation: async (location, signal, analyze) => {
			if (!state) throw new Error(startupError ?? "radare2 extension is not active.");
			return openLocation(location, signal, analyze);
		},
	});
}
