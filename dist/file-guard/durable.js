import { createRequire as __createRequire } from 'node:module';const require = __createRequire(import.meta.url);

// extensions/file-guard/durable.ts
import { AgentDoc, defineExtension, hook, section, ToolTask } from "@earendil-works/pi-durable";

// extensions/file-guard/src/bash.ts
var KNOWN_SAFE_COMMANDS = /* @__PURE__ */ new Set([
  "echo",
  "printf",
  "pwd",
  "date",
  "uname",
  "whoami",
  "id",
  "groups",
  "hostname",
  "true",
  "false",
  "env",
  "printenv",
  "which",
  "command",
  "type",
  "exit"
]);
var READONLY_FILE_COMMANDS = /* @__PURE__ */ new Set([
  "cat",
  "grep",
  "rg",
  "find",
  "ls",
  "head",
  "tail",
  "less",
  "more",
  "file",
  "stat",
  "du",
  "df",
  "wc",
  "sort",
  "uniq",
  "diff",
  "xargs"
  // conservative: often reads; could mutate, but commonly used with grep.
]);
var MUTATING_FILE_COMMANDS = /* @__PURE__ */ new Set([
  "cp",
  "mv",
  "rm",
  "rmdir",
  "touch",
  "mkdir",
  "chmod",
  "chown",
  "chgrp",
  "ln",
  "tar",
  // can create archives
  "zip",
  "gzip",
  "gunzip"
]);
function splitShellCommands(command) {
  const segments = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (escape) {
      current += c;
      escape = false;
      continue;
    }
    if (c === "\\") {
      current += c;
      escape = true;
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      current += c;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      current += c;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (c === "&" && next === "&" || c === "|" && next === "|") {
        segments.push(current.trim());
        current = "";
        i++;
        continue;
      }
      if (c === ";" || c === "|") {
        segments.push(current.trim());
        current = "";
        continue;
      }
    }
    current += c;
  }
  if (current.trim()) segments.push(current.trim());
  return segments.filter(Boolean);
}
function tokenizeSegment(segment) {
  const tokens = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;
  for (const c of segment) {
    if (escape) {
      current += c;
      escape = false;
      continue;
    }
    if (c === "\\") {
      current += c;
      escape = true;
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      current += c;
      continue;
    }
    if (c === '"' && !inDouble && !inSingle) {
      inDouble = true;
      continue;
    }
    if (c === '"' && inDouble) {
      inDouble = false;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(c)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current) tokens.push(current);
  return tokens;
}
function stripQuotes(token) {
  if (token.startsWith("'") && token.endsWith("'") || token.startsWith('"') && token.endsWith('"')) {
    return token.slice(1, -1);
  }
  return token;
}
function looksLikePath(token) {
  const stripped = stripQuotes(token);
  if (stripped.startsWith("/") || stripped.startsWith("./") || stripped.startsWith("../") || stripped.startsWith("~")) {
    return true;
  }
  if (stripped.includes("/")) return true;
  if (/\.[a-z0-9]{1,10}$/i.test(stripped)) return true;
  return false;
}
function analyseCommand(command) {
  return splitShellCommands(command).map((segment) => {
    const tokens = tokenizeSegment(segment);
    const commandName = stripQuotes(tokens[0] ?? "").replace(/\.\.\//g, "").replace(/\.\//g, "");
    const paths = [];
    let skipNext = false;
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token) continue;
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (/^-[^=]*$/.test(token) && ["-e", "-E", "-c", "-m", "-v", "--version", "--help"].includes(token)) {
        continue;
      }
      if (/^-[^=]*$/.test(token) && i + 1 < tokens.length) {
        const next = stripQuotes(tokens[i + 1] ?? "");
        if (looksLikePath(next)) {
          paths.push(next);
          skipNext = true;
        }
        continue;
      }
      if (token.startsWith("-")) continue;
      const stripped = stripQuotes(token);
      if (looksLikePath(stripped)) {
        paths.push(stripped);
      }
    }
    return {
      command: commandName,
      paths: [...new Set(paths)],
      knownSafe: KNOWN_SAFE_COMMANDS.has(commandName),
      knownFile: READONLY_FILE_COMMANDS.has(commandName) || MUTATING_FILE_COMMANDS.has(commandName)
    };
  });
}
function getBashPaths(command) {
  const analyses = analyseCommand(command);
  const paths = [];
  const reasons = [];
  for (const a of analyses) {
    for (const p of a.paths) paths.push(p);
    if (a.knownSafe && a.paths.length === 0) continue;
    if (READONLY_FILE_COMMANDS.has(a.command)) {
      reasons.push(`${a.command} reads files`);
    } else if (MUTATING_FILE_COMMANDS.has(a.command)) {
      reasons.push(`${a.command} may modify files`);
    } else if (!a.knownSafe) {
      reasons.push(`${a.command} is not a known-safe command`);
    }
  }
  return {
    paths: [...new Set(paths)],
    shouldPrompt: reasons.length > 0,
    reason: reasons.join("; ") || "bash command may touch files"
  };
}

// extensions/file-guard/src/extract-paths.ts
function extractToolPaths(toolName, params, cwd) {
  const input = params ?? {};
  if (toolName === "read" || toolName === "write" || toolName === "edit" || toolName === "grep" || toolName === "find" || toolName === "ls") {
    const rawPath = input.path;
    const paths2 = typeof rawPath === "string" ? [rawPath] : Array.isArray(rawPath) ? rawPath : [];
    if (paths2.length > 0) return { paths: paths2, reason: `${toolName} tool` };
  }
  if (toolName === "bash") {
    const command = String(input.command ?? "");
    const analysis = getBashPaths(command);
    if (!analysis.shouldPrompt && analysis.paths.length === 0) return void 0;
    return { paths: analysis.paths, reason: analysis.reason };
  }
  const paths = [];
  function collect(value) {
    if (typeof value === "string") {
      if (looksLikePath(value)) paths.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(collect);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(collect);
    }
  }
  collect(input);
  if (paths.length > 0) return { paths: [...new Set(paths)], reason: `${toolName} tool references paths` };
  return void 0;
}

// extensions/file-guard/src/paths-pure.ts
function globToRegex(pattern) {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      regex += ".*";
      i += 2;
    } else if (c === "*") {
      regex += "[^/]*";
      i++;
    } else if (c === "?") {
      regex += "[^/]";
      i++;
    } else if ("+.^$|()[]{}\\".includes(c)) {
      regex += "\\" + c;
      i++;
    } else {
      regex += c;
      i++;
    }
  }
  return new RegExp(`^${regex}$`);
}
function globMatch(pattern, target) {
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalizedTarget = target.replace(/\\/g, "/");
  const regex = globToRegex(normalizedPattern);
  if (regex.test(normalizedTarget)) return true;
  if (normalizedPattern.endsWith("/")) {
    const dirRegex = globToRegex(normalizedPattern + "**");
    if (dirRegex.test(normalizedTarget)) return true;
  }
  const asDir = normalizedPattern.endsWith("/") ? normalizedPattern : normalizedPattern + "/";
  const dirPrefixRegex = globToRegex(asDir + "**");
  if (dirPrefixRegex.test(normalizedTarget)) return true;
  return false;
}

// extensions/file-guard/durable.ts
var HAS_MAGIC = /[*?[\]{}]/;
function normalizeSlashes(p) {
  return p.replace(/\\/g, "/");
}
function isAbsolutePath(p) {
  return p.startsWith("/") || /^[A-Za-z]:\//.test(p);
}
function resolveGuardPath(input, cwd) {
  const slashed = normalizeSlashes(input);
  const joined = isAbsolutePath(slashed) ? slashed : `${normalizeSlashes(cwd).replace(/\/+$/, "")}/${slashed}`;
  const drive = joined.match(/^[A-Za-z]:/)?.[0] ?? "";
  const rest = drive ? joined.slice(drive.length) : joined;
  const absolute = rest.startsWith("/");
  const out = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return `${drive}${absolute ? "/" : ""}${out.join("/")}`;
}
function relativeTo(cwd, absPath) {
  const root = resolveGuardPath(cwd, "/");
  return absPath === root ? "." : absPath.startsWith(`${root}/`) ? absPath.slice(root.length + 1) : void 0;
}
function patternAllows(pattern, absPath, rawInput, cwd) {
  const p = normalizeSlashes(pattern);
  if (!HAS_MAGIC.test(p)) {
    const target = resolveGuardPath(p, cwd);
    return absPath === target || absPath.startsWith(`${target}/`);
  }
  if (globMatch(p, absPath) || globMatch(p, normalizeSlashes(rawInput))) return true;
  const rel = relativeTo(cwd, absPath);
  if (rel !== void 0 && globMatch(p, rel)) return true;
  const base = absPath.split("/").pop();
  return base !== void 0 && globMatch(p, base);
}
function createFileGuardDurableExtension(options = {}) {
  const enabled = options.enabled === true;
  const guardEnabled = options.guardEnabled !== false;
  const viewMode = options.viewMode === true;
  const allowedPaths = options.allowedPaths ?? [];
  const sessions = /* @__PURE__ */ new Map();
  const decisionsFor = (conversationId) => {
    let session = sessions.get(conversationId);
    if (!session) {
      session = { allowed: /* @__PURE__ */ new Set(), denied: /* @__PURE__ */ new Set() };
      sessions.set(conversationId, session);
    }
    return session;
  };
  const emitView = (entry, api, context) => {
    if (!viewMode) return;
    try {
      options.onView?.(entry, api.conversationId, context);
    } catch {
    }
  };
  const cwdOf = async (api, context) => {
    const agent = await api.snapshot(AgentDoc, api.conversationId, context);
    return agent?.cwd ?? "/";
  };
  const extension = defineExtension({
    name: "file-guard",
    sections: [
      section("file-guard", () => {
        if (!enabled || !guardEnabled) return void 0;
        const lines = [
          "Filesystem access is guarded: tool calls may only touch paths matching the allowed patterns below; other paths are blocked or require host approval.",
          "Allowed path patterns:",
          ...allowedPaths.length > 0 ? allowedPaths.map((p) => `- ${p}`) : ["(none)"],
          options.approve ? "Access outside this set may be approved by the host per call or for the session." : "Paths outside this set are blocked; do not retry them with alternate tools."
        ];
        return lines.join("\n");
      })
    ],
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          if (!enabled) return void 0;
          const extracted = extractToolPaths(call.name, call.arguments, "");
          const paths = extracted?.paths ?? [];
          if (!guardEnabled || paths.length === 0) {
            emitView(
              { phase: "decision", tool: call.name, timestamp: Date.now(), paths, decision: "allowed", nested: call.parent !== void 0 },
              api,
              context
            );
            return void 0;
          }
          const cwd = await cwdOf(api, context);
          const session = decisionsFor(api.conversationId);
          const deniedEarlier = [];
          const needsDecision = [];
          for (const raw of paths) {
            const abs = resolveGuardPath(raw, cwd);
            if (session.denied.has(abs)) {
              deniedEarlier.push(raw);
              continue;
            }
            if (session.allowed.has(abs)) continue;
            if (allowedPaths.some((p) => patternAllows(p, abs, raw, cwd))) continue;
            needsDecision.push(raw);
          }
          if (deniedEarlier.length > 0) {
            emitView(
              { phase: "decision", tool: call.name, timestamp: Date.now(), paths: deniedEarlier, decision: "denied", nested: call.parent !== void 0 },
              api,
              context
            );
            return { block: `File Guard: denied earlier this session: ${deniedEarlier.join(", ")}` };
          }
          if (needsDecision.length === 0) {
            emitView(
              { phase: "decision", tool: call.name, timestamp: Date.now(), paths, decision: "allowed", nested: call.parent !== void 0 },
              api,
              context
            );
            return void 0;
          }
          const approver = options.approve;
          if (!approver) {
            emitView(
              { phase: "decision", tool: call.name, timestamp: Date.now(), paths: needsDecision, decision: "blocked", nested: call.parent !== void 0 },
              api,
              context
            );
            return {
              block: `File Guard: ${call.name} touches paths outside the allowed set: ${needsDecision.join(", ")}. No host approval hook is configured, so the call is blocked.`
            };
          }
          const approval = await approver(
            {
              tool: call.name,
              reason: extracted?.reason ?? `${call.name} tool`,
              paths: needsDecision,
              arguments: call.arguments,
              nested: call.parent !== void 0
            },
            api,
            context
          );
          if (approval === true || approval === "session") {
            if (approval === "session") for (const raw of needsDecision) session.allowed.add(resolveGuardPath(raw, cwd));
            emitView(
              { phase: "decision", tool: call.name, timestamp: Date.now(), paths: needsDecision, decision: "approved", nested: call.parent !== void 0 },
              api,
              context
            );
            return void 0;
          }
          for (const raw of needsDecision) session.denied.add(resolveGuardPath(raw, cwd));
          emitView(
            { phase: "decision", tool: call.name, timestamp: Date.now(), paths: needsDecision, decision: "blocked", nested: call.parent !== void 0 },
            api,
            context
          );
          return { block: `File Guard: access denied by the host approval hook: ${needsDecision.join(", ")}` };
        },
        afterTool: (call, result, api, context) => {
          if (!enabled) return void 0;
          const paths = extractToolPaths(call.name, call.arguments, "")?.paths ?? [];
          emitView(
            { phase: "result", tool: call.name, timestamp: Date.now(), paths, isError: result.isError === true, nested: call.parent !== void 0 },
            api,
            context
          );
          return void 0;
        }
      })
    ]
  });
  return extension;
}
var durable_default = createFileGuardDurableExtension;
export {
  createFileGuardDurableExtension,
  durable_default as default,
  resolveGuardPath
};
