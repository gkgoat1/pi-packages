import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ConfigError, loadConfig, limitsFor, TOOL_NAMES, type ToolOutputLimitConfig } from "./src/config.ts";

function status(config: ToolOutputLimitConfig): string {
	const format = (value: number | null) => value === null ? "unlimited" : `${value.toLocaleString()}`;
	const lines = [
		`tool-output-limit: ${config.enabled ? "enabled" : "disabled"}`,
		`default: ${format(config.maxBytes)} bytes, ${format(config.maxLines)} lines; hard cap: ${format(config.hardMaxBytes)} bytes`,
	];
	for (const tool of TOOL_NAMES) {
		const limits = limitsFor(config, tool);
		lines.push(`${tool}: ${format(limits.maxBytes)} bytes, ${format(limits.maxLines)} lines`);
	}
	return lines.join("\n");
}

export default function toolOutputLimit(pi: ExtensionAPI) {
	let config: ToolOutputLimitConfig;
	let error: string | undefined;

	const refresh = (cwd: string, trusted: boolean) => {
		try {
			config = loadConfig({ cwd, trusted });
			error = undefined;
		} catch (cause) {
			config = { enabled: false, maxBytes: 0, maxLines: 0, hardMaxBytes: 0, tools: {}, tempOutput: { retain: true, directory: null } };
			error = cause instanceof Error ? cause.message : String(cause);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		refresh(ctx.cwd, ctx.isProjectTrusted());
		if (ctx.hasUI && error) ctx.ui.notify(`tool-output-limit disabled: ${error}`, "error");
	});

	pi.registerCommand("tool-output-limit", {
		description: "Show or reload tool-output-limit configuration",
		handler: async (args, ctx) => {
			if (args.trim() === "reload") {
				refresh(ctx.cwd, ctx.isProjectTrusted());
				if (error) {
					if (ctx.hasUI) ctx.ui.notify(`tool-output-limit disabled: ${error}`, "error");
					return;
				}
				await ctx.reload();
				return;
			}
			refresh(ctx.cwd, ctx.isProjectTrusted());
			const message = error ? `tool-output-limit disabled: ${error}` : status(config);
			if (ctx.hasUI) ctx.ui.notify(message, error ? "error" : "info");
		},
	});
}

export { ConfigError, loadConfig, limitsFor };
