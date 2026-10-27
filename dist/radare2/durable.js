import { createRequire as __createRequire } from 'node:module';const require = __createRequire(import.meta.url);

// extensions/radare2/durable.ts
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

// extensions/radare2/src/r2client.ts
var ESCAPE_RE = /\x1b\[[?0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;
function cleanReply(raw) {
  return raw.replace(ESCAPE_RE, "").replaceAll("\0", "").replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

// extensions/radare2/durable.ts
var SUMMARY_LIMIT = 200;
function r2OneshotArgv(location, commands, r2Path = "r2", evals = []) {
  return [
    r2Path,
    "-q",
    "-N",
    "-e",
    "scr.color=0",
    "-e",
    "scr.prompt=0",
    "-e",
    "bin.relocs.apply=true",
    ...evals.flatMap((item) => ["-e", item]),
    ...commands.flatMap((command) => ["-c", command]),
    "-c",
    "q",
    "--",
    location
  ];
}
async function runR2(api, options, argv, context) {
  const env = api.env;
  if (!env) throw new Error("r2 tools need an execution environment (HarnessOptions.env)");
  let output = "";
  const result = await env.exec(argv, { timeout: options.timeoutSeconds, onOutput: (text) => {
    output += text;
  } }, context);
  if (!result.ok) throw new Error(`r2 failed: ${result.error.code}: ${result.error.message}`);
  return { text: cleanReply(output), exitCode: result.value.exitCode };
}
function truncated(text, maxOutputChars) {
  if (text.length <= maxOutputChars) return text;
  return `${text.slice(0, maxOutputChars)}

[truncated at ${maxOutputChars} characters]`;
}
function analysisCommand(level) {
  return level;
}
function createRadare2DurableExtension(options = {}) {
  const resolved = {
    r2Path: options.r2Path ?? "r2",
    timeoutSeconds: options.timeoutSeconds ?? 120,
    autoAnalyze: options.autoAnalyze ?? true,
    maxOutputChars: options.maxOutputChars ?? 12e3
  };
  const prelude = (analyze) => analyze ?? resolved.autoAnalyze ? [analysisCommand("aaa")] : [];
  return defineExtension({
    name: "radare2",
    tools: [
      defineTool({
        name: "r2_analyze",
        description: "Analyze a binary with radare2 (one-shot, in the conversation's environment) and return a function summary.",
        parameters: Type.Object({
          path: Type.String({ description: "Path to the binary, as the environment sees it" }),
          level: Type.Optional(Type.Union([Type.Literal("aa"), Type.Literal("aaa"), Type.Literal("aaaa")], { description: "Analysis depth; default aaa" }))
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          const argv = r2OneshotArgv(args.path, [analysisCommand(args.level ?? "aaa"), "aflj"], resolved.r2Path);
          const { text } = await runR2(api, resolved, argv, context);
          let count = 0;
          try {
            count = JSON.parse(text).length;
          } catch {
            count = 0;
          }
          return { output: [{ type: "text", text: `analysis complete: ${count} functions (${args.level ?? "aaa"})` }] };
        }
      }),
      defineTool({
        name: "r2_functions",
        description: "List analyzed functions (aflj) of a binary, with an optional name filter.",
        parameters: Type.Object({
          path: Type.String(),
          filter: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number()),
          analyze: Type.Optional(Type.Boolean({ description: "Run aaa first; default true" }))
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          const argv = r2OneshotArgv(args.path, [...prelude(args.analyze), "aflj"], resolved.r2Path);
          const { text } = await runR2(api, resolved, argv, context);
          let functions = [];
          try {
            functions = JSON.parse(text);
          } catch {
            functions = [];
          }
          const filter = args.filter?.toLowerCase();
          const filtered = filter ? functions.filter((f) => String(f.name ?? "").toLowerCase().includes(filter)) : functions;
          const limit = args.limit ?? SUMMARY_LIMIT;
          const lines = filtered.slice(0, limit).map((f) => `${String(f.name ?? "?")} (size ${f.realsz ?? f.size ?? "?"})${f.signature ? `  ${f.signature}` : ""}`);
          return {
            output: [{ type: "text", text: truncated(`functions: ${filtered.length}${filtered.length > limit ? ` (showing ${limit})` : ""}
${lines.join("\n")}`, resolved.maxOutputChars) }]
          };
        }
      }),
      defineTool({
        name: "r2_disassemble",
        description: "Disassemble a function (pdf @ target) or N instructions at an address (pd N @ target).",
        parameters: Type.Object({
          path: Type.String(),
          target: Type.String({ description: "Function name or address" }),
          length: Type.Optional(Type.Number()),
          analyze: Type.Optional(Type.Boolean())
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          const target = args.target.replace(/[`\\]/g, "");
          const command = args.length !== void 0 ? `pd ${args.length} @ ${target}` : `pdf @ ${target}`;
          const argv = r2OneshotArgv(args.path, [...prelude(args.analyze), command], resolved.r2Path);
          const { text } = await runR2(api, resolved, argv, context);
          return { output: [{ type: "text", text: truncated(text, resolved.maxOutputChars) }] };
        }
      }),
      defineTool({
        name: "r2_strings",
        description: "Extract strings (iz data sections, or izz whole binary) with length/limit filters.",
        parameters: Type.Object({
          path: Type.String(),
          wholeBin: Type.Optional(Type.Boolean()),
          minLength: Type.Optional(Type.Number()),
          limit: Type.Optional(Type.Number())
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          const argv = r2OneshotArgv(args.path, [args.wholeBin ? "izzj" : "izj"], resolved.r2Path);
          const { text } = await runR2(api, resolved, argv, context);
          let strings = [];
          try {
            strings = JSON.parse(text);
          } catch {
            strings = [];
          }
          const minLength = args.minLength ?? 4;
          const limit = args.limit ?? 300;
          const filtered = strings.filter((s) => (s.length ?? s.string?.length ?? 0) >= minLength).slice(0, limit);
          const lines = filtered.map((s) => `${s.vaddr ?? "?"}  ${s.string ?? ""}`);
          return {
            output: [{ type: "text", text: truncated(`strings: ${filtered.length}${strings.length !== filtered.length ? ` (of ${strings.length})` : ""}
${lines.join("\n")}`, resolved.maxOutputChars) }]
          };
        }
      }),
      defineTool({
        name: "r2_xrefs",
        description: "List cross-references to (callers) or from (callees) a function/address.",
        parameters: Type.Object({
          path: Type.String(),
          target: Type.String(),
          direction: Type.Union([Type.Literal("to"), Type.Literal("from")]),
          analyze: Type.Optional(Type.Boolean())
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          const target = args.target.replace(/[`\\]/g, "");
          const command = args.direction === "to" ? `axtj @ ${target}` : `axfj @ ${target}`;
          const argv = r2OneshotArgv(args.path, [...prelude(args.analyze), command], resolved.r2Path);
          const { text } = await runR2(api, resolved, argv, context);
          let refs = [];
          try {
            refs = JSON.parse(text);
          } catch {
            refs = [];
          }
          const lines = refs.slice(0, SUMMARY_LIMIT).map((r) => `${r.type ?? "?"}  ${r.from ?? "?"} -> ${r.to ?? "?"}`);
          return { output: [{ type: "text", text: truncated(`xrefs (${args.direction} ${target}): ${refs.length}
${lines.join("\n") || "(none \u2014 run analysis first)"}`, resolved.maxOutputChars) }] };
        }
      }),
      defineTool({
        name: "r2_cmd",
        description: "Run any raw radare2 command against a binary (escape hatch: flags, graphs, decompilers, patching). One-shot; each call is a fresh r2 process in the conversation's environment. Prefer the curated r2_* tools when they fit.",
        parameters: Type.Object({
          path: Type.String(),
          command: Type.String({ description: "A single r2 command; no newlines" }),
          analyze: Type.Optional(Type.Boolean())
        }),
        // Raw commands may patch the binary: not replay-safe.
        execute: async (args, api, context) => {
          if (/[\r\n]/.test(args.command)) throw new Error("r2 command must not contain newlines (split into separate r2_cmd calls).");
          const argv = r2OneshotArgv(args.path, [...prelude(args.analyze), args.command], resolved.r2Path);
          const { text } = await runR2(api, resolved, argv, context);
          return { output: [{ type: "text", text: truncated(text, resolved.maxOutputChars) }] };
        }
      })
    ]
  });
}
var durable_default = createRadare2DurableExtension;
export {
  createRadare2DurableExtension,
  durable_default as default,
  r2OneshotArgv
};
