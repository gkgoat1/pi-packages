/**
 * Gondolin Sandbox Extension for Pi.
 *
 * Adapted from https://github.com/pasky/pi-gondolin (MIT) with two changes:
 *
 * 1. `accel: "tcg"` — QEMU software emulation only, so the micro-VM also works
 *    when pi itself runs inside a VM (nested virtualization, where hvf/kvm are
 *    unavailable).
 *
 * 2. HTTP proxying with credential stubs — API keys are discovered from the
 *    host environment and the guest only ever sees opaque stubs. Gondolin's
 *    HTTP hooks inflate a stub back into the real credential in outbound
 *    headers, and only for that credential's allowed hosts. Every other
 *    request — including ones carrying real, non-stub API keys — passes
 *    through the proxy untouched.
 *
 * Like the other extensions in this package, this one is disabled until its
 * config opts in: set `"enabled": true` in `~/.pi/agent/gondolin.json` or
 * `.pi/gondolin.json` (trusted projects), or `PI_GONDOLIN_ENABLED=true`.
 * Requires QEMU (`brew install qemu` on macOS); the guest image (~200 MB) is
 * downloaded into `~/.cache/gondolin/` on first run.
 *
 * The running VM is also published as a symbol-keyed global handle
 * (`Symbol.for("pi-packages.gondolin.shared")`, see src/shared.ts) so the
 * other extensions in this package can reuse it without depending on this
 * bundle: File Guard enforces its policy as VM-filesystem interception, and
 * radare2 runs analysis inside the VM. Both integrations activate only when
 * this extension and the consumer are enabled. The older in-VM MCP server
 * path was retired with the bundled mcp-client extension; MCP is Pi's
 * built-in feature now (`mcp.json`, `pi mcp`, `/mcp`).
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { VM, createHttpHooks } from "@earendil-works/gondolin";
import { loadConfig, type GondolinConfig } from "./src/config.ts";
import { buildSecretDefinitions, buildStubEnv, discoverSecrets, type DiscoveredSecret } from "./src/secrets.ts";
import { GUEST_BASE_ENV, buildSandboxPromptAddendum, createGondolinBashOps, createGondolinEditOps, createGondolinReadOps, createGondolinWriteOps } from "./src/ops.ts";
import {
	buildExtraMountProviders,
	createGuardedWorkspaceProvider,
	installGondolinShared,
	launchGuestProcess,
	mapHostToGuestPath,
	RealFSProvider,
	type GondolinFsGuard,
	type GondolinShared,
} from "./src/shared.ts";

interface VmState {
	vm: VM | null;
	starting: Promise<VM> | null;
	error: string | undefined;
	secrets: DiscoveredSecret[];
}

export default function gondolinExtension(pi: ExtensionAPI) {
	const localCwd = process.cwd();
	const fsGuards = new Set<GondolinFsGuard>();

	// Baseline local tools (definitions + renderers reused; execution overridden)
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);

	let config: GondolinConfig = loadConfig({ cwd: localCwd, isProjectTrusted: () => false });
	const state: VmState = { vm: null, starting: null, error: undefined, secrets: [] };
	// Project trust is resolved before session_start; capture it for config reloads.
	const trustedRef = { value: false };

	// -------------------------------------------------------------------------
	// Shared handle — other extensions in this package reuse the VM through a
	// symbol-keyed global instead of a dependency (see src/shared.ts).
	// -------------------------------------------------------------------------

	const shared: GondolinShared = {
		version: 1,
		get hostCwd() {
			return localCwd;
		},
		get guestWorkspace() {
			return config.guestWorkspace;
		},
		get mounts() {
			return config.mounts.map((mount) => ({ hostPath: mount.hostPath, guestPath: mount.guestPath, access: mount.access }));
		},
		isEnabled: () => config.enabled,
		refreshTrust: (isProjectTrusted) => {
			trustedRef.value = isProjectTrusted;
			config = loadConfig({ cwd: localCwd, isProjectTrusted: () => trustedRef.value });
			return config.enabled;
		},
		ensureVm: () => ensureVm(),
		getVm: () => state.vm,
		toGuestPath: (hostPath) => mapHostToGuestPath(localCwd, config.guestWorkspace, config.mounts, hostPath),
		registerFsGuard: (guard) => {
			fsGuards.add(guard);
			return () => {
				fsGuards.delete(guard);
			};
		},
		execGuest: (spec) => {
			const vm = state.vm;
			if (!vm) throw new Error("Gondolin VM is not running; await ensureVm() before execGuest()");
			return launchGuestProcess(vm, spec, state.secrets, config.guestWorkspace);
		},
	};
	installGondolinShared(shared);

	function statusLine(ctx: ExtensionContext, text: string, tone: "accent" | "muted" = "accent"): void {
		ctx.ui.setStatus("gondolin", ctx.ui.theme.fg(tone, `Gondolin: ${text}`));
	}

	async function ensureVm(ctx?: ExtensionContext): Promise<VM> {
		if (state.vm) return state.vm;
		if (state.starting) return state.starting;

		state.starting = (async () => {
			// Refresh config and credentials on each boot attempt so a host-side
			// key rotation is picked up without reloading the extension.
			config = loadConfig({ cwd: localCwd, isProjectTrusted: () => trustedRef.value });
			state.secrets = discoverSecrets(process.env, config);
			const guestWorkspace = config.guestWorkspace;

			ctx?.ui.setStatus("gondolin", ctx.ui.theme.fg("accent", `Gondolin: starting (accel ${config.accel}, mount ${guestWorkspace})`));

			const extraMounts = buildExtraMountProviders(config.mounts, fsGuards);
			const vfsMounts: Record<string, import("@earendil-works/gondolin").VirtualProvider> = {
				[guestWorkspace]: createGuardedWorkspaceProvider(
					new RealFSProvider(localCwd),
					fsGuards,
					localCwd,
					guestWorkspace,
				),
			};
			Object.assign(vfsMounts, extraMounts.mounts);

			const httpHooks = config.httpProxy.enabled
				? createHttpHooks({
						// Omitted = allow all hosts; requests without stubs always pass through.
						...(config.allowedHosts ? { allowedHosts: config.allowedHosts } : {}),
						secrets: buildSecretDefinitions(state.secrets),
					}).httpHooks
				: undefined;

			const created = await VM.create({
				env: { ...GUEST_BASE_ENV, ...buildStubEnv(state.secrets) },
				...(httpHooks ? { httpHooks } : {}),
				...(config.memory ? { memory: config.memory } : {}),
				...(config.cpus ? { cpus: config.cpus } : {}),
				...(config.startTimeoutMs !== undefined ? { startTimeoutMs: config.startTimeoutMs } : {}),
				sandbox: {
					// Software emulation only: required for nested VMs and the
					// explicit default of this extension.
					accel: config.accel,
					...(config.image ? { imagePath: config.image } : {}),
				},
				vfs: {
					// The host workspace is mounted through a guardable provider so
					// other extensions (File Guard) can enforce policy at the VM
					// filesystem layer instead of restricting the tools themselves.
					// Extra host mounts (skills, user folders) are added alongside.
					mounts: vfsMounts,
				},
				sessionLabel: `pi-gondolin:${path.basename(localCwd)}`,
			});

			state.vm = created;
			state.error = undefined;

			const stubCount = state.secrets.length;
			const proxyNote = config.httpProxy.enabled
				? `; ${stubCount} credential${stubCount === 1 ? "" : "s"} stubbed (real values stay host-side)`
				: "";
			const mountCount = Object.keys(extraMounts.mounts).length;
			const mountNote = mountCount > 0 ? `; ${mountCount} extra mount${mountCount === 1 ? "" : "s"}` : "";
			const skipNote =
				extraMounts.skipped.length > 0
					? `; ${extraMounts.skipped.length} mount${extraMounts.skipped.length === 1 ? "" : "s"} skipped`
					: "";
			ctx?.ui.notify(
				`Gondolin VM ready — host ${localCwd} mounted at ${guestWorkspace}${mountNote}${skipNote}${proxyNote}`,
				"info",
			);
			return created;
		})();

		try {
			return await state.starting;
		} catch (err) {
			state.error = err instanceof Error ? err.message : String(err);
			if (ctx?.hasUI) ctx.ui.notify(`Gondolin VM failed to start: ${state.error}`, "error");
			throw err;
		} finally {
			state.starting = null;
		}
	}

	// -------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		trustedRef.value = ctx.isProjectTrusted();
		config = loadConfig({ cwd: ctx.cwd, isProjectTrusted: () => trustedRef.value });
		if (!config.enabled) return;
		// Start eagerly so users see failures (missing QEMU, unsupported arch,
		// image download) early. Fail closed: tool calls below retry ensureVm.
		await ensureVm(ctx).catch(() => {});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!state.vm) return;
		statusLine(ctx, "stopping", "muted");
		try {
			await state.vm.close();
		} finally {
			state.vm = null;
			state.starting = null;
		}
	});

	// -------------------------------------------------------------------------
	// Tool overrides — delegate read/write/edit/bash into the VM
	// -------------------------------------------------------------------------

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			if (!config.enabled) return localRead.execute(id, params, signal, onUpdate);
			const activeVm = await ensureVm(ctx);
			return createReadTool(localCwd, {
				operations: createGondolinReadOps(activeVm, localCwd, config.guestWorkspace),
			}).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			if (!config.enabled) return localWrite.execute(id, params, signal, onUpdate);
			const activeVm = await ensureVm(ctx);
			return createWriteTool(localCwd, {
				operations: createGondolinWriteOps(activeVm, localCwd, config.guestWorkspace),
			}).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			if (!config.enabled) return localEdit.execute(id, params, signal, onUpdate);
			const activeVm = await ensureVm(ctx);
			return createEditTool(localCwd, {
				operations: createGondolinEditOps(activeVm, localCwd, config.guestWorkspace),
			}).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			if (!config.enabled) return localBash.execute(id, params, signal, onUpdate);
			const activeVm = await ensureVm(ctx);
			return createBashTool(localCwd, {
				operations: createGondolinBashOps(activeVm, localCwd, config.guestWorkspace, {
					secrets: state.secrets,
					passthrough: config.envPassthrough,
				}),
			}).execute(id, params, signal, onUpdate);
		},
	});

	// -------------------------------------------------------------------------
	// User ! commands also run inside the VM (fail closed: wait for the VM)
	// -------------------------------------------------------------------------

	pi.on("user_bash", async (_event) => {
		if (!config.enabled) return; // fall back to local execution
		const activeVm = await ensureVm();
		return {
			operations: createGondolinBashOps(activeVm, localCwd, config.guestWorkspace, {
				secrets: state.secrets,
				passthrough: config.envPassthrough,
			}),
		};
	});

	// -------------------------------------------------------------------------
	// System prompt — tell the LLM it is operating in the VM with stub keys
	// -------------------------------------------------------------------------

	pi.on("before_agent_start", async (event) => {
		if (!config.enabled) return;
		await ensureVm().catch(() => {});
		const modified = event.systemPrompt.replace(
			`Current working directory: ${localCwd}`,
			`Current working directory: ${config.guestWorkspace} (Gondolin VM, host mount: ${localCwd})`,
		);
		return { systemPrompt: `${modified}${buildSandboxPromptAddendum(config, localCwd)}` };
	});

	// -------------------------------------------------------------------------
	// /gondolin — inspect sandbox + proxy state (never prints secret values)
	// -------------------------------------------------------------------------

	pi.registerCommand("gondolin", {
		description: "Show Gondolin VM status, QEMU accel mode, and stubbed credential hosts",
		handler: async (_args, ctx) => {
			if (!config.enabled) {
				ctx.ui.notify(
					'Gondolin is disabled. Set "enabled": true in gondolin.json or PI_GONDOLIN_ENABLED=true to enable it.',
					"info",
				);
				return;
			}
			const lines = [
				`vm: ${state.vm ? "running" : state.starting ? "starting" : state.error ? `failed — ${state.error}` : "not started"}`,
				`accel: ${config.accel} (QEMU; "tcg" = software emulation, nested-VM safe)`,
				`mount: ${localCwd} → ${config.guestWorkspace} (read-write)`,
			];
			for (const mount of config.mounts) {
				const missing = existsSync(mount.hostPath) ? "" : " (host path does not exist; not mounted)";
				lines.push(`mount: ${mount.hostPath} → ${mount.guestPath} (${mount.access})${missing}`);
			}
			lines.push(`shared handle: published (fs guards: ${fsGuards.size})`);
			if (config.httpProxy.enabled) {
				const allowedHosts = config.allowedHosts
					? config.allowedHosts.join(", ") || "(deny all)"
					: "(allow all hosts)";
				lines.push(`http proxy: enabled; allowedHosts ${allowedHosts}`);
				if (state.secrets.length === 0) {
					lines.push("credentials: none discovered in host environment");
				} else {
					lines.push(`credentials (${state.secrets.length}):`);
					for (const secret of state.secrets) {
						lines.push(`  ${secret.name} (${secret.envVar}) → ${secret.hosts.join(", ")}`);
					}
				}
				lines.push(`env passthrough: ${config.envPassthrough.join(", ") || "(none)"}`);
			} else {
				lines.push("http proxy: disabled (no stubs; guest network is unmediated)");
			}
			ctx.ui.notify(lines.join("\n"), state.error ? "warning" : "info");
		},
	});
}
