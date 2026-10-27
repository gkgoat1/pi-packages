import { createRequire as __createRequire } from 'node:module';const require = __createRequire(import.meta.url);

// extensions/tool-output-limit/durable.ts
import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
import { createBashTool, createReadTool } from "@earendil-works/pi-durable/tools";

// extensions/tool-output-limit/src/config.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var DEFAULT_CONFIG = {
  enabled: false,
  maxBytes: 4 * 1024 * 1024,
  maxLines: 5e4,
  hardMaxBytes: 64 * 1024 * 1024,
  tools: {},
  tempOutput: { retain: true, directory: null }
};
function limitsFor(config, tool) {
  const override = config.tools[tool] ?? {};
  return {
    maxBytes: override.maxBytes === void 0 ? config.maxBytes : override.maxBytes,
    maxLines: override.maxLines === void 0 ? config.maxLines : override.maxLines,
    hardMaxBytes: config.hardMaxBytes
  };
}

// extensions/tool-output-limit/durable.ts
function durableLimits(limits) {
  return {
    ...limits.maxBytes === null ? {} : { maxBytes: limits.maxBytes },
    ...limits.maxLines === null ? {} : { maxLines: limits.maxLines }
  };
}
function createToolOutputLimitDurableExtension(config) {
  if (!config.enabled) return defineExtension({ name: "tool-output-limit" });
  const forTool = (tool) => durableLimits(limitsFor(config, tool));
  const wraps = [
    wrapTool(createBashTool(), (tool) => ({
      ...tool,
      outputLimits: { ...tool.outputLimits, ...forTool("bash"), retain: tool.outputLimits?.retain ?? "tail" }
    })),
    wrapTool(createReadTool(), (tool) => ({
      ...tool,
      outputLimits: { ...tool.outputLimits, ...forTool("read") }
    }))
  ];
  return defineExtension({
    name: "tool-output-limit",
    wraps
  });
}
var durable_default = createToolOutputLimitDurableExtension;
export {
  createToolOutputLimitDurableExtension,
  durable_default as default
};
