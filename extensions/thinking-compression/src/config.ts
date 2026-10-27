import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DISABLED_CONFIG, parseConfig } from "./config-core.ts";

export { COMPRESSOR_INSTRUCTIONS, parseConfig } from "./config-core.ts";
export type { ModelRef, ThinkingCompressionConfig } from "./config-core.ts";
import type { ThinkingCompressionConfig } from "./config-core.ts";

export function loadConfig(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): { config: ThinkingCompressionConfig; error?: string } {
	if (!ctx.isProjectTrusted()) return { config: DISABLED_CONFIG };
	const path = join(ctx.cwd, CONFIG_DIR_NAME, "thinking-compression.json");
	if (!existsSync(path)) return { config: DISABLED_CONFIG };
	try { return { config: parseConfig(JSON.parse(readFileSync(path, "utf8"))) }; }
	catch (error) { return { config: DISABLED_CONFIG, error: error instanceof Error ? error.message : String(error) }; }
}
