/**
 * Tool Output Limit — pi-durable entrypoint.
 *
 * Durable tools already declare `outputLimits` (`maxBytes`/`maxLines`/
 * `retain`), so this entrypoint is a pair of pure `wrapTool` decorators that
 * raise the caps of the durable `bash` and `read` tools to the configured
 * values. `null` ("unlimited") limits are omitted, leaving the tool's own
 * default. Unlike the pi-coding-agent extension (which replaces the tools to
 * keep full output in private temp files), durable's `bash` already spills
 * oversized output and reports `fullOutputPath`; this wrapper only widens
 * what the model sees.
 */

import { defineExtension, wrapTool, type Extension, type Wrap } from "@earendil-works/pi-durable";
import { createBashTool, createReadTool } from "@earendil-works/pi-durable/tools";
import { limitsFor, type ToolLimits, type ToolName, type ToolOutputLimitConfig } from "./src/config.ts";

function durableLimits(limits: ToolLimits): { maxBytes?: number; maxLines?: number } {
	return {
		...(limits.maxBytes === null ? {} : { maxBytes: limits.maxBytes }),
		...(limits.maxLines === null ? {} : { maxLines: limits.maxLines }),
	};
}

export function createToolOutputLimitDurableExtension(config: ToolOutputLimitConfig): Extension {
	if (!config.enabled) return defineExtension({ name: "tool-output-limit" });
	const forTool = (tool: ToolName) => durableLimits(limitsFor(config, tool));
	// SAFETY: each wrap targets a different concrete tool type and Wrap<T> is
	// invariant in its parameter schema; both wrappers only spread the tool and
	// replace outputLimits, which is valid for any ToolRegistration.
	const wraps = [
		wrapTool(createBashTool(), (tool) => ({
			...tool,
			outputLimits: { ...tool.outputLimits, ...forTool("bash"), retain: tool.outputLimits?.retain ?? "tail" as const },
		})),
		wrapTool(createReadTool(), (tool) => ({
			...tool,
			outputLimits: { ...tool.outputLimits, ...forTool("read") },
		})),
	] as unknown as Wrap[];
	return defineExtension({
		name: "tool-output-limit",
		wraps,
	});
}

export default createToolOutputLimitDurableExtension;
