/**
 * File Guard Extension for Pi
 *
 * Two composable modes:
 *  - Guard mode: restricts file access to paths listed in `.piinclude`. Permission
 *    prompts are non-blocking and decisions persist for the session.
 *  - View mode: logs critical tool moments (reads, writes, edits, bash, grep,
 *    find, ls) as durable timeline entries with extracted context, even when
 *    guard mode is disabled. When both modes are active, guard decisions are
 *    logged with the same context so users can decide more effectively.
 *
 * When the Gondolin sandbox extension is also enabled, both modes switch to
 * VM interception (see src/gondolin.ts): policy is enforced at the sandbox
 * VM's filesystem layer instead of restricting tools, since Gondolin already
 * runs read/write/edit/bash inside the VM.
 *
 * Features:
 * - `.piinclude` files support globs and directories.
 * - User allow/deny decisions are remembered for the session.
 * - Multiple permission requests are batched into a single dialog.
 * - Allowed paths are compressed with brace notation and injected into the system prompt.
 * - Toggle modes via env vars (`PI_FILE_GUARD_ENABLED`, `PI_FILE_GUARD_VIEW`,
 *   `PI_FILE_GUARD_MODES`) or config files.
 */

import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config.ts";
import { extractToolContext } from "./src/context.ts";
import { ContextEnricher, formatEnrichedSummary } from "./src/enrich.ts";
import { extractToolPaths, handleGuardedTool, wrapTool } from "./src/guard.ts";
import {
	createVmFsGuard,
	getGondolinHandle,
	isInterceptionActive,
	isVmTool,
	type GondolinHandle,
	type VmGuardLogger,
} from "./src/gondolin.ts";
import { AllowedSet, modelKey } from "./src/includes.ts";
import { PromptQueue } from "./src/prompts.ts";
import { compressAllowedPaths } from "./src/compress.ts";
import { registerViewRenderer, ViewLogger } from "./src/view.ts";
import type { AnyTool, FileGuardConfig, ModelRef, PersistedState } from "./src/types.ts";

const OVERRIDDEN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];

function modelsEqual(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
	if (!a && !b) return true;
	if (!a || !b) return false;
	return a.provider === b.provider && a.id === b.id;
}

function formatIncludeTier(label: string, files: string[], override: boolean): string {
	return `${label} (${override ? "model override" : "base"}): ${files.join(", ") || "(none)"}`;
}

export default function fileGuardExtension(pi: ExtensionAPI): void {
	let config!: FileGuardConfig;
	let allowedSet: AllowedSet | undefined;
	let promptQueue: PromptQueue | undefined;
	let viewLogger: ViewLogger | undefined;
	let enricher: ContextEnricher | undefined;
	let currentModel: ModelRef | undefined;

	// Gondolin sandbox integration (see src/gondolin.ts): when both extensions
	// are enabled, guard/view runs as VM-filesystem interception instead of
	// tool restriction.
	let gondolinHandle: GondolinHandle | undefined;
	let gondolinVmActive = false;
	let interception = false;
	let unregisterVmGuard: (() => void) | undefined;

	// Pending tools registered before session_start (i.e. during other extensions'
	// factory functions when File Guard loaded first). They are wrapped once the
	// guard state is ready.
	const pendingToolDefs: AnyTool[] = [];
	const wrappedToolNames = new Set<string>();
	const originalRegisterTool = pi.registerTool.bind(pi);

	function anyModeActive(): boolean {
		return config.guardEnabled || config.viewMode;
	}

	function maybeWrapTool(toolDef: AnyTool): AnyTool {
		if (!anyModeActive() || !config.wrapAllTools || !allowedSet || !promptQueue || !viewLogger) return toolDef;
		if (!toolDef?.name) return toolDef;
		// The Gondolin extension runs these tools inside the VM; wrapping them
		// again would duplicate prompts or replace the VM-backed execution with
		// host-backed execution. The VM filesystem layer enforces policy.
		if (gondolinVmActive && isVmTool(toolDef.name)) return toolDef;
		wrappedToolNames.add(toolDef.name);
		return wrapTool(pi, allowedSet, promptQueue, viewLogger, enricher, config, toolDef);
	}

	(pi as AnyTool).registerTool = (toolDef: AnyTool) => {
		// Extension factories may register tools before session_start supplies a
		// context/configuration. Queue them so they can still be wrapped once.
		if (!config) {
			pendingToolDefs.push(toolDef);
			return;
		}
		if (!anyModeActive()) {
			originalRegisterTool(toolDef);
			return;
		}
		if (!allowedSet) {
			// Guard state isn't ready yet; queue for wrapping during session_start.
			pendingToolDefs.push(toolDef);
			return;
		}
		originalRegisterTool(maybeWrapTool(toolDef));
	};

	function reloadIncludes(model: ModelRef | undefined): void {
		allowedSet?.reload(model);
	}

	function reinitialize(ctx: ExtensionContext): void {
		config = loadConfig(ctx.cwd);
		if (!allowedSet) {
			allowedSet = new AllowedSet(ctx.cwd, config);
		} else {
			allowedSet.reload(ctx.model);
		}
		promptQueue = new PromptQueue(ctx, allowedSet);
		enricher = new ContextEnricher(ctx, config.viewEnrichment);
		viewLogger = new ViewLogger(pi, ctx.cwd, enricher);

		const entries = ctx.sessionManager.getEntries();
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === "file-guard-state") {
				const data = (entry as { data?: PersistedState }).data;
				if (data) allowedSet.restore(data);
			}
		}
	}

	function formatStatusLines(model: ModelRef | undefined): string[] {
		if (!allowedSet) return [];
		const sources = allowedSet.getLoadedSources();
		return [
			`Guard mode: ${config.guardEnabled}`,
			`View mode: ${config.viewMode}`,
			`Wrap all tools: ${config.wrapAllTools}`,
			`Model: ${model ? modelKey(model) : "(none)"}`,
			formatIncludeTier("Global includes", sources.global, sources.globalOverride),
			formatIncludeTier("Project includes", sources.project, sources.projectOverride),
			`Default policy (non-interactive): ${config.defaultPolicy}`,
		];
	}

	function persist(): void {
		if (allowedSet?.isDirty()) {
			pi.appendEntry("file-guard-state", allowedSet.serialize());
		}
	}

	registerViewRenderer(pi);

	pi.on("tool_call", async (event, ctx) => {
		if (!anyModeActive()) return undefined;
		if (!allowedSet || !promptQueue) {
			reinitialize(ctx);
			currentModel = ctx.model;
			reloadIncludes(ctx.model);
		}

		// Tools handled by our wrappers (built-in overrides plus anything wrapped
		// via the monkey-patched registerTool) don't need this synchronous fallback.
		// Tools the Gondolin VM owns are guarded at the VM filesystem layer.
		if (gondolinVmActive && isVmTool(event.toolName)) return undefined;
		if (OVERRIDDEN_TOOLS.includes(event.toolName) || wrappedToolNames.has(event.toolName)) return undefined;

		if (!config.guardEnabled) return undefined;

		const guardInfo = extractToolPaths(event.toolName, event.input, ctx.cwd);
		if (!guardInfo) return undefined;

		const nonAllowedPaths = guardInfo.paths.filter((p) => !allowedSet!.isAllowed(p));
		if (nonAllowedPaths.length === 0) return undefined;

		if (nonAllowedPaths.every((p) => allowedSet!.isDenied(p))) {
			if (config.viewMode && viewLogger) {
				viewLogger.logGuard(event.toolName, event.toolCallId, "blocked", event.input, ctx, "previously denied");
			}
			return { block: true, reason: `File Guard: ${nonAllowedPaths.join(", ")} was previously denied.` };
		}

		if (!ctx.hasUI) {
			if (config.defaultPolicy === "allow") return undefined;
			if (config.viewMode && viewLogger) {
				viewLogger.logGuard(event.toolName, event.toolCallId, "blocked", event.input, ctx, "no UI available");
			}
			return { block: true, reason: "File Guard: no UI available to confirm file access." };
		}

		const context = extractToolContext(event.toolName, event.input, ctx.cwd);
		let contextSummary = context?.summary;
		if (enricher) {
			try {
				const enriched = await enricher.enrich(event.toolCallId, event.toolName, event.input);
				contextSummary = formatEnrichedSummary(enriched, contextSummary);
			} catch {
				// Fall back to the simple context summary.
			}
		}
		const approved = await promptQueue!.request(
			event.toolName,
			`${guardInfo.reason}: ${nonAllowedPaths.join(", ")}`,
			nonAllowedPaths,
			contextSummary,
		);
		if (!approved) {
			if (config.viewMode && viewLogger) {
				viewLogger.logGuard(event.toolName, event.toolCallId, "user-denied", event.input, ctx);
			}
			return { block: true, reason: `File Guard: user denied ${nonAllowedPaths.join(", ")}.` };
		}
		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		reinitialize(ctx);
		currentModel = ctx.model;
		reloadIncludes(ctx.model);

		// Resolve the Gondolin integration before wrapping tools: refreshTrust
		// re-reads its config with this session's trust decision so the answer is
		// correct even though File Guard loads before Gondolin's session_start.
		gondolinHandle = getGondolinHandle();
		gondolinVmActive = gondolinHandle ? gondolinHandle.refreshTrust(ctx.isProjectTrusted()) : false;
		interception = isInterceptionActive(gondolinVmActive, config.guardEnabled);

		if (gondolinHandle && gondolinVmActive && (config.guardEnabled || config.viewMode) && allowedSet && promptQueue) {
			const guard = createVmFsGuard({
				cwd: ctx.cwd,
				isAllowed: (p) => allowedSet!.isAllowed(p),
				isDenied: (p) => allowedSet!.isDenied(p),
				prompt: (toolName, description, paths, contextSummary) =>
					promptQueue!.request(toolName, description, paths, contextSummary),
				...(viewLogger ? { view: viewLogger as unknown as VmGuardLogger } : {}),
				...(ctx.hasUI
					? { notify: (message, level) => ctx.ui.notify(message, level) }
					: {}),
				hasUI: ctx.hasUI,
				defaultPolicy: config.defaultPolicy,
			});
			unregisterVmGuard?.();
			unregisterVmGuard = gondolinHandle.registerFsGuard(guard);
		}

		// Drain any tools that were registered before the guard was ready.
		for (const toolDef of pendingToolDefs.splice(0)) {
			originalRegisterTool(maybeWrapTool(toolDef));
		}

		if (!anyModeActive()) return;

		if (config.guardEnabled || config.viewMode) {
			const localGrep = createGrepTool(ctx.cwd);
			const localFind = createFindTool(ctx.cwd);
			const localLs = createLsTool(ctx.cwd);

			// Use originalRegisterTool directly so built-in overrides aren't wrapped twice
			// by the monkey-patched registerTool. When the Gondolin VM is active it owns
			// read/write/edit/bash (guarded at the filesystem layer), so only the
			// host-side search/list tools are wrapped here.
			const hostTools = gondolinVmActive
				? [localGrep, localFind, localLs]
				: [
						createReadTool(ctx.cwd),
						createWriteTool(ctx.cwd),
						createEditTool(ctx.cwd),
						createBashTool(ctx.cwd),
						localGrep,
						localFind,
						localLs,
					];
			for (const tool of hostTools) {
				originalRegisterTool(wrapTool(pi, allowedSet!, promptQueue!, viewLogger!, enricher, config, tool));
			}
		}

		if (ctx.hasUI) {
			const parts: string[] = [];
			if (config.guardEnabled) parts.push(interception ? "guard (VM interception)" : "guard");
			if (config.viewMode) parts.push("view");
			if (parts.length > 0) {
				ctx.ui.notify(`File Guard active (${parts.join(" + ")}) — use \`/file-guard\` to inspect.`, "info");
			}
		}
	});

	pi.on("model_select", async (event, ctx) => {
		if (!config.guardEnabled || !allowedSet) return;
		currentModel = event.model;
		reloadIncludes(event.model);
		enricher?.updateContext(ctx);
		if (ctx.hasUI) {
			const lines = formatStatusLines(event.model);
			ctx.ui.notify(`File Guard reloaded for ${modelKey(event.model)}.\n${lines.slice(2, 4).join("\n")}`, "info");
		}
	});

	pi.registerCommand("file-guard", {
		description: "Show File Guard configuration and allowed paths",
		handler: async (_args, ctx) => {
			reinitialize(ctx);
			currentModel = ctx.model;
			reloadIncludes(ctx.model);
			if (!allowedSet) return;
			const compressed = compressAllowedPaths(allowedSet, ctx.cwd);
		const lines = [
				...formatStatusLines(ctx.model),
			`Gondolin interception: ${
				interception
					? "active (policy enforced at the VM filesystem layer)"
					: gondolinHandle
						? "inactive (Gondolin " + (gondolinVmActive ? "enabled but guard mode off" : "disabled") + ")"
						: "not installed"
			}`,
			`Allowed paths: ${compressed || "(none)"}`,
		];
		ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!anyModeActive() || !allowedSet) return undefined;

		if (!modelsEqual(ctx.model, currentModel)) {
			currentModel = ctx.model;
			reloadIncludes(ctx.model);
		}

		const compressed = compressAllowedPaths(allowedSet, ctx.cwd);
		const lines: string[] = [];
		lines.push("## File Guard");

		if (config.guardEnabled) {
			if (interception) {
				lines.push(
					"Filesystem access is enforced inside the sandbox VM: operations on paths outside the allowed set fail with `EACCES` (Permission denied).",
				);
				lines.push(
					"The user may be prompted when a tool touches a path outside the allowed set; granted access persists for the session. Denied paths fail immediately.",
				);
			} else {
				lines.push(
					"The agent may only access files listed in configured `.piinclude` files and paths the user has explicitly allowed during this session.",
				);
				lines.push(
					"Model-specific include files may override base includes per tier when configured in `.pi/file-guard.json`.",
				);
				lines.push("");
				lines.push(
					"Tool results may be deferred while the user reviews file access. A result starting with `[File Guard pending]` is a placeholder.",
				);
				lines.push(
					"The real result or a block notice will arrive as a user message starting with `[File Guard result for tool call <id>]` or `[File Guard blocked tool call <id>]`.",
				);
				lines.push("Treat that follow-up message as the result for the matching tool call; do not act on the pending placeholder.");
			}
		}

		if (config.viewMode) {
			if (config.guardEnabled) lines.push("");
			lines.push(
				interception
					? "File Guard view mode is active: mutating filesystem operations inside the sandbox VM and host-side search tools are logged as timeline entries."
					: "File Guard view mode is active: reads, writes, edits, bash, grep, find, and ls operations are logged as timeline entries with extracted context.",
			);
		}

		if (compressed) {
			lines.push("");
			lines.push("Allowed paths:");
			lines.push(compressed);
		}

		return { systemPrompt: `${event.systemPrompt}\n\n${lines.join("\n")}` };
	});

	pi.on("turn_end", async () => {
		persist();
	});

	pi.on("session_shutdown", async () => {
		persist();
		unregisterVmGuard?.();
		unregisterVmGuard = undefined;
	});
}