import { createRequire as __createRequire } from 'node:module';const require = __createRequire(import.meta.url);

// extensions/file-guard/index.ts
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool
} from "@earendil-works/pi-coding-agent";

// extensions/file-guard/src/config.ts
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
function defaultEnrichment() {
  return {
    enabled: false,
    useModel: false,
    maxContextLength: 2e3,
    timeoutMs: 2e3,
    riskPatterns: [
      "*secret*",
      "*token*",
      "*.key",
      "*.pem",
      "*.env*",
      ".bashrc",
      ".zshrc",
      ".ssh/*",
      "**/.git/**"
    ]
  };
}
var DEFAULT_CONFIG = {
  enabled: false,
  guardEnabled: false,
  viewMode: false,
  globalIncludeFiles: [path.join(os.homedir(), ".piinclude")],
  globalModelIncludeFiles: {},
  projectIncludeFiles: [".piinclude"],
  projectModelIncludeFiles: {},
  defaultPolicy: "prompt",
  wrapAllTools: true,
  viewEnrichment: defaultEnrichment()
};
function parseModes(value) {
  if (typeof value === "string") {
    const modes = value.split(",").map((m) => m.trim().toLowerCase());
    return {
      guard: modes.includes("guard"),
      view: modes.includes("view")
    };
  }
  if (Array.isArray(value)) {
    const modes = value.filter((v) => typeof v === "string").map((m) => m.toLowerCase());
    return {
      guard: modes.includes("guard"),
      view: modes.includes("view")
    };
  }
  return {};
}
function parseModelIncludeMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, val] of Object.entries(value)) {
    if (Array.isArray(val) && val.every((entry) => typeof entry === "string")) {
      result[key] = val;
    }
  }
  return result;
}
function sanitizeRiskPatterns(value) {
  if (!Array.isArray(value)) return void 0;
  const patterns = value.filter((v) => typeof v === "string");
  return patterns.length > 0 ? patterns : void 0;
}
function parseEnrichmentModelRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const obj = value;
  const provider = typeof obj.provider === "string" ? obj.provider : void 0;
  const id = typeof obj.id === "string" ? obj.id : void 0;
  if (provider && id) return { provider, id };
  if (id) return { id };
  if (provider) return { provider };
  return void 0;
}
function parseViewEnrichment(enrich) {
  if (typeof enrich === "boolean") {
    return enrich ? { ...defaultEnrichment(), enabled: true } : void 0;
  }
  if (!enrich || typeof enrich !== "object" || Array.isArray(enrich)) return void 0;
  const obj = enrich;
  const base = defaultEnrichment();
  const model = parseEnrichmentModelRef(obj.model) ?? base.model;
  return {
    enabled: obj.enabled !== void 0 ? Boolean(obj.enabled) : true,
    useModel: obj.useModel !== void 0 ? Boolean(obj.useModel) : base.useModel,
    model,
    maxContextLength: typeof obj.maxContextLength === "number" && obj.maxContextLength > 0 ? Math.min(obj.maxContextLength, 8e3) : base.maxContextLength,
    timeoutMs: typeof obj.timeoutMs === "number" && obj.timeoutMs > 0 ? obj.timeoutMs : base.timeoutMs,
    riskPatterns: sanitizeRiskPatterns(obj.riskPatterns) ?? base.riskPatterns
  };
}
function applyConfigFile(filePath, target) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.enabled !== void 0) target.guardEnabled = Boolean(parsed.enabled);
    if (parsed.guardEnabled !== void 0) target.guardEnabled = Boolean(parsed.guardEnabled);
    if (parsed.viewMode !== void 0) target.viewMode = Boolean(parsed.viewMode);
    const fileModes = parseModes(parsed.modes);
    if (fileModes.guard !== void 0) target.guardEnabled = fileModes.guard;
    if (fileModes.view !== void 0) target.viewMode = fileModes.view;
    if (Array.isArray(parsed.globalIncludeFiles)) target.globalIncludeFiles = parsed.globalIncludeFiles;
    if (Array.isArray(parsed.projectIncludeFiles)) {
      target.projectIncludeFiles = parsed.projectIncludeFiles;
    } else if (typeof parsed.projectIncludeFile === "string") {
      target.projectIncludeFiles = [parsed.projectIncludeFile];
    }
    if (parsed.globalModelIncludeFiles !== void 0) {
      target.globalModelIncludeFiles = {
        ...target.globalModelIncludeFiles,
        ...parseModelIncludeMap(parsed.globalModelIncludeFiles)
      };
    }
    if (parsed.projectModelIncludeFiles !== void 0) {
      target.projectModelIncludeFiles = {
        ...target.projectModelIncludeFiles,
        ...parseModelIncludeMap(parsed.projectModelIncludeFiles)
      };
    }
    if (parsed.defaultPolicy === "allow" || parsed.defaultPolicy === "deny" || parsed.defaultPolicy === "prompt") {
      target.defaultPolicy = parsed.defaultPolicy;
    }
    if (parsed.wrapAllTools !== void 0) target.wrapAllTools = Boolean(parsed.wrapAllTools);
    if (parsed.viewEnrichment !== void 0) {
      const parsedEnrichment = parseViewEnrichment(parsed.viewEnrichment);
      if (parsedEnrichment) target.viewEnrichment = parsedEnrichment;
    }
  } catch {
  }
}
function loadConfig(cwd) {
  let guardEnabled = DEFAULT_CONFIG.guardEnabled;
  let viewMode = DEFAULT_CONFIG.viewMode;
  const envEnabled = process.env.PI_FILE_GUARD_ENABLED;
  if (envEnabled === "1" || envEnabled?.toLowerCase() === "true") guardEnabled = true;
  if (envEnabled === "0" || envEnabled?.toLowerCase() === "false") guardEnabled = false;
  const envView = process.env.PI_FILE_GUARD_VIEW;
  if (envView === "1" || envView?.toLowerCase() === "true") viewMode = true;
  if (envView === "0" || envView?.toLowerCase() === "false") viewMode = false;
  const envModes = parseModes(process.env.PI_FILE_GUARD_MODES);
  if (envModes.guard !== void 0) guardEnabled = envModes.guard;
  if (envModes.view !== void 0) viewMode = envModes.view;
  const enrichment = { ...defaultEnrichment() };
  const envEnrich = process.env.PI_FILE_GUARD_ENRICH;
  if (envEnrich === "1" || envEnrich?.toLowerCase() === "true") enrichment.enabled = true;
  if (envEnrich === "0" || envEnrich?.toLowerCase() === "false") enrichment.enabled = false;
  const envEnrichModel = process.env.PI_FILE_GUARD_ENRICH_MODEL;
  if (envEnrichModel) {
    const [provider, id] = envEnrichModel.includes("/") ? envEnrichModel.split("/", 2) : [void 0, envEnrichModel];
    enrichment.model = { provider, id };
    enrichment.useModel = true;
  }
  const envTimeout = process.env.PI_FILE_GUARD_ENRICH_TIMEOUT;
  if (envTimeout) {
    const parsedTimeout = Number(envTimeout);
    if (!Number.isNaN(parsedTimeout) && parsedTimeout > 0) enrichment.timeoutMs = parsedTimeout;
  }
  const envMax = process.env.PI_FILE_GUARD_ENRICH_MAX_CONTEXT;
  if (envMax) {
    const parsedMax = Number(envMax);
    if (!Number.isNaN(parsedMax) && parsedMax > 0) enrichment.maxContextLength = Math.min(parsedMax, 8e3);
  }
  const config = {
    ...DEFAULT_CONFIG,
    guardEnabled,
    viewMode,
    globalIncludeFiles: [...DEFAULT_CONFIG.globalIncludeFiles],
    globalModelIncludeFiles: { ...DEFAULT_CONFIG.globalModelIncludeFiles },
    projectIncludeFiles: [...DEFAULT_CONFIG.projectIncludeFiles],
    projectModelIncludeFiles: { ...DEFAULT_CONFIG.projectModelIncludeFiles },
    viewEnrichment: enrichment
  };
  const globalDir = path.join(os.homedir(), ".pi", "agent", "extensions", "file-guard");
  applyConfigFile(path.join(globalDir, "config.json"), config);
  applyConfigFile(path.join(cwd, CONFIG_DIR_NAME, "file-guard.json"), config);
  if (!config.viewEnrichment) config.viewEnrichment = enrichment;
  return config;
}

// extensions/file-guard/src/context.ts
import * as fs3 from "node:fs";

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

// extensions/file-guard/src/paths.ts
import * as fs2 from "node:fs";
import * as os2 from "node:os";
import * as path2 from "node:path";

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

// extensions/file-guard/src/paths.ts
function expandHome(input) {
  if (input === "~" || input.startsWith("~/")) {
    return path2.join(os2.homedir(), input.slice(1));
  }
  return input;
}
function normalizePath(input, cwd) {
  let p = expandHome(input);
  if (!path2.isAbsolute(p)) {
    p = path2.resolve(cwd, p);
  }
  try {
    return fs2.realpathSync(p);
  } catch {
    return path2.resolve(p);
  }
}
function shortenPath(input, cwd) {
  const home = os2.homedir();
  if (path2.isAbsolute(input) && pathWithin(cwd, input)) {
    return path2.relative(cwd, input).replace(/\\/g, "/") || ".";
  }
  if (input.startsWith(home)) {
    return `~${input.slice(home.length)}`;
  }
  return input.replace(/\\/g, "/");
}
function pathWithin(parent, child) {
  const rel = path2.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path2.isAbsolute(rel);
}

// extensions/file-guard/src/context.ts
function extractToolContext(toolName, params, cwd) {
  const input = params ?? {};
  const rawPath = input.path;
  const paths = typeof rawPath === "string" ? [rawPath] : Array.isArray(rawPath) ? rawPath.filter((p) => typeof p === "string") : [];
  switch (toolName) {
    case "read": {
      const filePath = String(input.path ?? "");
      const offset = input.offset;
      const limit = input.limit;
      const range = offset !== void 0 || limit !== void 0 ? `:${offset ?? 1}${limit !== void 0 ? `-${(offset ?? 1) + limit - 1}` : ""}` : "";
      const short = filePath ? shortenPath(normalizePath(filePath, cwd), cwd) : "...";
      return {
        toolName,
        paths: filePath ? [filePath] : [],
        summary: `read ${short}${range}`,
        detail: filePath ? `Reading ${filePath}${range || ""}` : "Reading file"
      };
    }
    case "write": {
      const filePath = String(input.path ?? "");
      const content = String(input.content ?? "");
      const lines = content.split("\n").length;
      const short = filePath ? shortenPath(normalizePath(filePath, cwd), cwd) : "...";
      const changed = filePath ? (() => {
        try {
          const before = fs3.statSync(normalizePath(filePath, cwd));
          return before.isFile() ? " (overwrite)" : "";
        } catch {
          return " (new file)";
        }
      })() : "";
      return {
        toolName,
        paths: filePath ? [filePath] : [],
        summary: `write ${short} (${lines} lines${changed ? `, ${changed.trim()}` : ""})`,
        detail: filePath ? `Writing ${lines} lines to ${filePath}${changed ? ` ${changed.trim()}` : ""}` : "Writing file"
      };
    }
    case "edit": {
      const filePath = String(input.path ?? "");
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const short = filePath ? shortenPath(normalizePath(filePath, cwd), cwd) : "...";
      return {
        toolName,
        paths: filePath ? [filePath] : [],
        summary: `edit ${short} (${edits.length} change${edits.length === 1 ? "" : "s"})`,
        detail: filePath ? `Editing ${filePath} with ${edits.length} change${edits.length === 1 ? "" : "s"}` : "Editing file"
      };
    }
    case "ls": {
      const filePath = String(input.path ?? ".");
      const short = shortenPath(normalizePath(filePath, cwd), cwd);
      return {
        toolName,
        paths: [filePath],
        summary: `ls ${short}`,
        detail: `Listing ${filePath}`
      };
    }
    case "find": {
      const pattern = String(input.pattern ?? "*");
      const filePath = String(input.path ?? ".");
      return {
        toolName,
        paths: [filePath],
        summary: `find ${pattern} in ${shortenPath(normalizePath(filePath, cwd), cwd)}`,
        detail: `Find "${pattern}" in ${filePath}`
      };
    }
    case "grep": {
      const pattern = String(input.pattern ?? "");
      const filePath = String(input.path ?? ".");
      const short = shortenPath(normalizePath(filePath, cwd), cwd);
      return {
        toolName,
        paths: [filePath],
        summary: `grep /${pattern}/ in ${short}`,
        detail: `Grep "${pattern}" in ${filePath}`
      };
    }
    case "bash": {
      const command = String(input.command ?? "");
      const analysis = getBashPaths(command);
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return {
        toolName,
        paths: analysis.paths,
        summary: `bash ${preview}`,
        detail: `$ ${command}`
      };
    }
    default: {
      if (paths.length > 0) {
        const short = shortenPath(normalizePath(paths[0], cwd), cwd);
        return {
          toolName,
          paths,
          summary: `${toolName} ${short}`,
          detail: `${toolName} referencing ${paths.join(", ")}`
        };
      }
      return void 0;
    }
  }
}
function resultSnippet(result, maxLen = 120) {
  if (!result) return "";
  let text = "";
  for (const block of result.content) {
    if (block && typeof block === "object" && "type" in block && block.type === "text" && typeof block.text === "string") {
      text += block.text;
      if (text.length >= maxLen) break;
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > maxLen) return `${text.slice(0, maxLen)}\u2026`;
  return text;
}

// extensions/file-guard/src/enrich.ts
import { complete } from "@earendil-works/pi-ai/compat";
import * as fs4 from "node:fs";
import * as path3 from "node:path";
var HIGH_RISK_COMMANDS = /* @__PURE__ */ new Set([
  "rm",
  "rmdir",
  "chmod",
  "chown",
  "mv",
  "mkfs",
  "dd",
  "curl",
  "wget",
  "shred",
  "format"
]);
var SENSITIVE_CONTENT_PATTERNS = [
  /password\s*[:=]/i,
  /api[_-]?key\s*[:=]/i,
  /secret\s*[:=]/i,
  /token\s*[:=]/i,
  /private[_-]?key/i,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/
];
function truncate(str, max) {
  if (str.length <= max) return str;
  return `${str.slice(0, max)}\u2026`;
}
function* matchRiskPatterns(filePath, cwd, patterns = []) {
  if (patterns.length === 0) return;
  const abs = normalizePath(filePath, cwd);
  const base = path3.basename(abs);
  for (const p of patterns) {
    const regex = globToRegex2(p);
    if (regex.test(base) || regex.test(abs)) yield p;
  }
}
function globToRegex2(pattern) {
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
  return new RegExp(regex, "i");
}
function readFilePreview(filePath, charBudget) {
  try {
    const raw = fs4.readFileSync(filePath, "utf-8");
    return truncate(raw, charBudget);
  } catch {
    return void 0;
  }
}
function fileExists(filePath) {
  try {
    fs4.accessSync(filePath, fs4.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
function looksSensitive(text) {
  return SENSITIVE_CONTENT_PATTERNS.some((re) => re.test(text));
}
function classifyBashRisk(command) {
  const analyses = analyseCommand(command);
  const notes = [];
  let risk = "safe";
  for (const a of analyses) {
    if (HIGH_RISK_COMMANDS.has(a.command)) {
      risk = "mutate";
      notes.push(`uses ${a.command}`);
    } else if (a.command === "cp" || a.command === "touch" || a.command === "mkdir") {
      if (risk === "safe") risk = "write";
      notes.push(`${a.command} creates or overwrites files`);
    } else if (a.command === "tar" || a.command === "zip") {
      if (risk === "safe") risk = "write";
      notes.push(`${a.command} may write archives`);
    } else if (a.knownFile && !a.knownSafe) {
      if (risk === "safe") risk = "read";
    } else if (!a.knownSafe && a.command) {
      if (risk === "safe") risk = "unknown";
      notes.push(`${a.command} is not a known-safe command`);
    }
  }
  if (/[><|]/.test(command) && risk === "safe") {
    risk = "write";
    notes.push("shell redirection may write files");
  }
  return { risk, notes };
}
function buildEnrichmentPrompt(toolName, params, deterministic, cwd) {
  const input = params ?? {};
  const rawParams = truncate(JSON.stringify(input), 3e3);
  let contextBlock = `Operation: ${toolName}
`;
  contextBlock += `Deterministic risk: ${deterministic.risk}
`;
  contextBlock += `Affected files: ${deterministic.affectedFiles.join(", ") || "(none)"}
`;
  if (deterministic.notes.length > 0) {
    contextBlock += `Notes: ${deterministic.notes.join("; ")}
`;
  }
  contextBlock += `Params: ${rawParams}
`;
  if ((toolName === "write" || toolName === "edit") && typeof input.path === "string") {
    const abs = normalizePath(input.path, cwd);
    if (fileExists(abs)) {
      const before = readFilePreview(abs, deterministic.affectedFiles.length > 0 ? 1200 : 2e3);
      if (before !== void 0) contextBlock += `Existing file content:
\`\`\`
${before}
\`\`\`
`;
    } else {
      contextBlock += "The target file does not exist yet.\n";
    }
    if (toolName === "edit" && Array.isArray(input.edits)) {
      contextBlock += `Edits:
${JSON.stringify(input.edits).slice(0, 1e3)}
`;
    } else if (typeof input.content === "string") {
      contextBlock += `New content preview:
${truncate(input.content, 1200)}
`;
    }
  }
  if (toolName === "bash" && typeof input.command === "string") {
    contextBlock += `Bash command: ${input.command}
`;
  }
  return `${contextBlock}
Return ONLY valid JSON matching this schema (no markdown, no prose):
{ "risk": "safe|read|write|mutate", "intent": "one-line summary", "notes": ["..."], "affectedFiles": ["..."], "snippet": "up to 150 chars" }`;
}
async function callEnrichmentModel(ctx, config, prompt) {
  if (!ctx.model) return void 0;
  const target = config.model?.id ? ctx.modelRegistry.find(config.model.provider ?? ctx.model.provider, config.model.id) ?? ctx.model : ctx.model;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(target);
  if (!auth.ok || !auth.apiKey) return void 0;
  const userMessage = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now()
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await complete(
      target,
      {
        systemPrompt: "You are a concise security classifier. Given a file operation and its parameters, classify risk and summarize intent. Output valid JSON only. Keep all fields short.",
        messages: [userMessage]
      },
      { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: controller.signal, timeoutMs: config.timeoutMs }
    );
    if (response.stopReason !== "stop") return void 0;
    const raw = response.content.filter((c) => c.type === "text").map((c) => c.text).join("").trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return void 0;
    const parsed = JSON.parse(jsonMatch[0]);
    const riskStr = String(parsed.risk ?? "").toLowerCase();
    const result = {};
    if (["safe", "read", "write", "mutate", "unknown"].includes(riskStr)) {
      result.risk = riskStr;
    }
    if (typeof parsed.intent === "string") result.intent = parsed.intent;
    if (Array.isArray(parsed.notes)) {
      result.notes = parsed.notes.filter((n) => typeof n === "string");
    }
    if (Array.isArray(parsed.affectedFiles)) {
      result.affectedFiles = parsed.affectedFiles.filter((f) => typeof f === "string");
    }
    if (typeof parsed.snippet === "string") result.snippet = parsed.snippet;
    return result;
  } catch {
    return void 0;
  } finally {
    clearTimeout(timeout);
  }
}
function deterministicEnrichment(toolName, params, cwd, config) {
  const input = params ?? {};
  const notes = [];
  const affectedFiles = [];
  let risk = "unknown";
  let snippet;
  let diff;
  const patterns = config?.riskPatterns ?? [];
  function touchPath(p, role) {
    affectedFiles.push(p);
    for (const _ of matchRiskPatterns(p, cwd, patterns)) {
      notes.push(`touches sensitive path ${shortenPath(normalizePath(p, cwd), cwd)}`);
    }
  }
  switch (toolName) {
    case "read": {
      risk = "read";
      const filePath = String(input.path ?? "");
      if (filePath) {
        touchPath(filePath, "source");
        const preview = readFilePreview(normalizePath(filePath, cwd), 120);
        snippet = preview !== void 0 ? `first lines: ${preview.slice(0, 120)}` : "file not found or unreadable";
      }
      break;
    }
    case "write": {
      risk = "write";
      const filePath = String(input.path ?? "");
      const content = String(input.content ?? "");
      if (filePath) {
        touchPath(filePath, "target");
        const abs = normalizePath(filePath, cwd);
        if (fileExists(abs)) {
          notes.push("overwrites existing file");
          const before = readFilePreview(abs, 400);
          diff = before !== void 0 ? `existing content:
${truncate(before, 400)}` : "existing file unreadable";
        } else {
          notes.push("creates new file");
        }
      }
      if (content) {
        if (looksSensitive(content)) notes.push("new content contains credential-like patterns");
        snippet = `new content preview: ${truncate(content, 200)}`;
      }
      break;
    }
    case "edit": {
      risk = "write";
      const filePath = String(input.path ?? "");
      const edits = Array.isArray(input.edits) ? input.edits : [];
      if (filePath) {
        touchPath(filePath, "target");
        const abs = normalizePath(filePath, cwd);
        const before = readFilePreview(abs, 600);
        if (before !== void 0) snippet = `current file preview: ${truncate(before, 300)}`;
      }
      const editPreviews = [];
      for (const edit of edits) {
        if (!edit || typeof edit !== "object") continue;
        const e = edit;
        const oldText = String(e.oldText ?? "");
        const newText = String(e.newText ?? "");
        if (oldText || newText) {
          editPreviews.push(`- ${truncate(oldText, 80)} \u2192 ${truncate(newText, 80)}`);
        }
        if (looksSensitive(newText)) notes.push("edit introduces credential-like patterns");
      }
      if (editPreviews.length > 0) diff = `edits:
${editPreviews.join("\n")}`;
      break;
    }
    case "bash": {
      const command = String(input.command ?? "");
      const classification = classifyBashRisk(command);
      risk = classification.risk;
      notes.push(...classification.notes);
      snippet = truncate(command, 200);
      for (const a of analyseCommand(command)) {
        for (const p of a.paths) touchPath(p, "target");
      }
      break;
    }
    case "grep":
    case "find":
    case "ls": {
      risk = "read";
      const filePath = String(input.path ?? ".");
      touchPath(filePath, "source");
      break;
    }
    default: {
      risk = "unknown";
      const rawPath = input.path;
      const paths = typeof rawPath === "string" ? [rawPath] : Array.isArray(rawPath) ? rawPath : [];
      for (const p of paths) if (typeof p === "string") touchPath(p, "target");
    }
  }
  return {
    risk,
    notes,
    intent: void 0,
    snippet,
    diff,
    affectedFiles: [...new Set(affectedFiles)],
    modelEnriched: false
  };
}
function formatEnrichedSummary(enriched, baseSummary) {
  const lines = [];
  if (baseSummary) lines.push(baseSummary);
  lines.push(`risk: ${enriched.risk}${enriched.modelEnriched ? " (model)" : ""}`);
  if (enriched.intent) lines.push(`intent: ${enriched.intent}`);
  if (enriched.notes.length > 0) lines.push(enriched.notes.join("; "));
  if (enriched.snippet) lines.push(`preview: ${enriched.snippet}`);
  else if (enriched.diff) lines.push(`preview: ${enriched.diff}`);
  return lines.join("\n");
}
var ContextEnricher = class {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
  }
  ctx;
  config;
  cache = /* @__PURE__ */ new Map();
  updateContext(ctx) {
    this.ctx = ctx;
  }
  shouldEnrich() {
    return Boolean(this.config?.enabled);
  }
  enrichKey(toolCallId, toolName) {
    return toolCallId ?? `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  enrich(toolCallId, toolName, params) {
    if (!this.shouldEnrich()) {
      return Promise.resolve(deterministicEnrichment(toolName, params, this.ctx.cwd, this.config));
    }
    const key = this.enrichKey(toolCallId, toolName);
    let promise = this.cache.get(key);
    if (promise) return promise;
    promise = this.doEnrich(toolName, params);
    this.cache.set(key, promise);
    promise.finally(() => {
      setTimeout(() => this.cache.delete(key), 6e4);
    });
    return promise;
  }
  async doEnrich(toolName, params) {
    const deterministic = deterministicEnrichment(toolName, params, this.ctx.cwd, this.config);
    if (!this.config?.useModel) return deterministic;
    try {
      const prompt = buildEnrichmentPrompt(toolName, params, deterministic, this.ctx.cwd);
      const modelResult = await callEnrichmentModel(this.ctx, this.config, prompt);
      if (!modelResult) return deterministic;
      return {
        risk: modelResult.risk ?? deterministic.risk,
        notes: modelResult.notes && modelResult.notes.length > 0 ? [...deterministic.notes, "model: " + modelResult.notes.join("; ")] : deterministic.notes,
        intent: modelResult.intent,
        snippet: modelResult.snippet ?? deterministic.snippet,
        diff: deterministic.diff,
        affectedFiles: modelResult.affectedFiles && modelResult.affectedFiles.length > 0 ? [.../* @__PURE__ */ new Set([...deterministic.affectedFiles, ...modelResult.affectedFiles])] : deterministic.affectedFiles,
        modelEnriched: true
      };
    } catch {
      return deterministic;
    }
  }
};

// extensions/file-guard/src/guard.ts
import { Text as Text2 } from "@earendil-works/pi-tui";

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

// extensions/file-guard/src/results.ts
function resultToText(result) {
  return result.content.map((block) => {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
    return "";
  }).join("\n");
}
function buildPendingResult(toolName, toolCallId, paths) {
  return {
    content: [
      {
        type: "text",
        text: `[File Guard pending] ${toolName} on ${paths.join(", ")} is awaiting approval (tool call ${toolCallId}).`
      }
    ],
    details: { fileGuard: "pending", toolCallId, paths }
  };
}
function buildBlockedResult(toolName, toolCallId, paths, reason) {
  return {
    content: [
      {
        type: "text",
        text: `[File Guard blocked] ${toolName} on ${paths.join(", ")}: ${reason} (tool call ${toolCallId}).`
      }
    ],
    details: { fileGuard: "blocked", toolCallId, paths, reason },
    isError: true
  };
}
function buildErrorResult(toolName, toolCallId, error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `[File Guard error] ${toolName}: ${message} (tool call ${toolCallId}).` }],
    details: { fileGuard: "error", toolCallId, error: message },
    isError: true
  };
}
function sendDeferredResult(pi, toolCallId, toolName, result, blocked) {
  const text = resultToText(result);
  const header = blocked ? `[File Guard blocked tool call ${toolCallId} (${toolName})]` : `[File Guard result for tool call ${toolCallId} (${toolName})]`;
  const message = `${header}
${text}`;
  try {
    pi.sendUserMessage(message, { deliverAs: "steer" });
  } catch {
    pi.sendUserMessage(message);
  }
}

// extensions/file-guard/src/view.ts
import { Box, Text } from "@earendil-works/pi-tui";
var ViewLogger = class {
  constructor(pi, cwd, enricher) {
    this.pi = pi;
    this.cwd = cwd;
    this.enricher = enricher;
  }
  pi;
  cwd;
  enricher;
  append(entry) {
    try {
      this.pi.appendEntry("file-guard-view", entry);
    } catch {
    }
  }
  logContext(toolName, toolCallId, params, ctx) {
    if (!this.enricher) return;
    void this.enricher.enrich(toolCallId, toolName, params).then((enriched) => {
      this.append({
        timestamp: Date.now(),
        toolName,
        toolCallId,
        phase: "context",
        summary: enriched.intent ?? `risk: ${enriched.risk}`,
        paths: enriched.affectedFiles,
        risk: enriched.risk,
        intent: enriched.intent,
        snippet: enriched.snippet ?? enriched.diff,
        modelEnriched: enriched.modelEnriched,
        note: enriched.notes.length > 0 ? enriched.notes.join("; ") : void 0
      });
    }).catch(() => {
    });
  }
  logStart(toolName, toolCallId, params, ctx) {
    const context = extractToolContext(toolName, params, ctx.cwd);
    if (!context) return;
    this.append({
      timestamp: Date.now(),
      toolName,
      toolCallId,
      phase: "start",
      summary: context.summary,
      detail: context.detail,
      paths: context.paths
    });
    this.logContext(toolName, toolCallId, params, ctx);
  }
  logGuard(toolName, toolCallId, status, params, ctx, note) {
    const context = extractToolContext(toolName, params, ctx.cwd);
    this.append({
      timestamp: Date.now(),
      toolName,
      toolCallId,
      phase: status === "allowed" || status === "auto-allowed" ? "allowed" : status,
      summary: context?.summary ?? `${toolName} ${status}`,
      detail: context?.detail,
      paths: context?.paths,
      guardStatus: status,
      note
    });
  }
  logComplete(toolName, toolCallId, params, ctx, result, durationMs) {
    const context = extractToolContext(toolName, params, ctx.cwd);
    if (!context && !result) return;
    const snippet = resultSnippet(result);
    this.append({
      timestamp: Date.now(),
      toolName,
      toolCallId,
      phase: result.isError ? "error" : "complete",
      summary: context?.summary ?? `${toolName} complete`,
      detail: snippet ? `${context?.detail ?? ""}
${snippet}`.trim() : context?.detail,
      paths: context?.paths,
      durationMs,
      isError: result.isError
    });
  }
};
function registerViewRenderer(pi) {
  pi.registerEntryRenderer("file-guard-view", (entry, { expanded }, theme) => {
    const data = entry.data;
    if (!data) return void 0;
    const icon = data.phase === "start" ? theme.fg("warning", "\u23F3") : data.phase === "blocked" || data.phase === "error" ? theme.fg("error", "\u2717") : data.phase === "pending" ? theme.fg("warning", "\u{1F6E1}") : theme.fg("success", "\u2713");
    const guardBadge = data.guardStatus ? theme.fg("warning", ` [${data.guardStatus}]`) : "";
    const header = `${icon} ${theme.fg("toolTitle", theme.bold(data.toolName))}${guardBadge} ${theme.fg("accent", data.summary)}`;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(header, 0, 0));
    if (expanded) {
      if (data.risk) {
        const riskColor = data.risk === "mutate" || data.risk === "write" ? "error" : data.risk === "read" ? "warning" : "dim";
        box.addChild(new Text(theme.fg(riskColor, `risk: ${data.risk}${data.modelEnriched ? " (model)" : ""}`), 0, 0));
      }
      if (data.intent) {
        box.addChild(new Text(theme.fg("accent", `intent: ${data.intent}`), 0, 0));
      }
      if (data.snippet) {
        box.addChild(new Text(theme.fg("dim", data.snippet), 0, 0));
      }
      if (data.detail) {
        box.addChild(new Text(theme.fg("dim", data.detail), 0, 0));
      }
      if (data.durationMs !== void 0) {
        box.addChild(new Text(theme.fg("dim", `took ${data.durationMs}ms`), 0, 0));
      }
      if (data.note) {
        box.addChild(new Text(theme.fg("warning", data.note), 0, 0));
      }
    }
    return box;
  });
}

// extensions/file-guard/src/guard.ts
async function handleGuardedTool(pi, allowedSet, promptQueue, viewLogger, enricher, config, toolName, params, toolCallId, executeAllowed, ctx) {
  const guardInfo = extractToolPaths(toolName, params, ctx.cwd);
  const context = extractToolContext(toolName, params, ctx.cwd);
  if (!guardInfo) {
    try {
      const start = Date.now();
      const result = await executeAllowed();
      if (config.viewMode && viewLogger) {
        viewLogger.logComplete(toolName, toolCallId, params, ctx, result, Date.now() - start);
      }
      return result;
    } catch (err) {
      if (config.viewMode && viewLogger) {
        viewLogger.logGuard(toolName, toolCallId, "blocked", params, ctx, String(err));
      }
      return buildErrorResult(toolName, toolCallId, err);
    }
  }
  const nonAllowedPaths = guardInfo.paths.filter((p) => !allowedSet.isAllowed(p));
  if (nonAllowedPaths.length === 0) {
    try {
      const start = Date.now();
      const result = await executeAllowed();
      if (config.viewMode && viewLogger) {
        viewLogger.logComplete(toolName, toolCallId, params, ctx, result, Date.now() - start);
      }
      return result;
    } catch (err) {
      if (config.viewMode && viewLogger) {
        viewLogger.logGuard(toolName, toolCallId, "blocked", params, ctx, String(err));
      }
      return buildErrorResult(toolName, toolCallId, err);
    }
  }
  if (nonAllowedPaths.every((p) => allowedSet.isDenied(p))) {
    if (config.viewMode && viewLogger) {
      viewLogger.logGuard(toolName, toolCallId, "blocked", params, ctx, "previously denied");
    }
    return buildBlockedResult(toolName, toolCallId, nonAllowedPaths, "previously denied");
  }
  if (!ctx.hasUI) {
    if (config.defaultPolicy === "allow") {
      try {
        const start = Date.now();
        const result = await executeAllowed();
        if (config.viewMode && viewLogger) {
          viewLogger.logComplete(toolName, toolCallId, params, ctx, result, Date.now() - start);
        }
        return result;
      } catch (err) {
        if (config.viewMode && viewLogger) {
          viewLogger.logGuard(toolName, toolCallId, "blocked", params, ctx, String(err));
        }
        return buildErrorResult(toolName, toolCallId, err);
      }
    }
    if (config.viewMode && viewLogger) {
      viewLogger.logGuard(toolName, toolCallId, "blocked", params, ctx, "non-interactive mode");
    }
    return buildBlockedResult(toolName, toolCallId, nonAllowedPaths, "non-interactive mode");
  }
  let contextSummary = context?.summary;
  if (enricher) {
    try {
      const enriched = await enricher.enrich(toolCallId, toolName, params);
      contextSummary = formatEnrichedSummary(enriched, contextSummary);
    } catch {
    }
  }
  promptQueue.requestCallback(
    toolName,
    `${guardInfo.reason}: ${nonAllowedPaths.join(", ")}`,
    nonAllowedPaths,
    async (approved) => {
      if (approved) {
        if (config.viewMode && viewLogger) {
          viewLogger.logGuard(toolName, toolCallId, "allowed", params, ctx);
        }
        try {
          const start = Date.now();
          const result = await executeAllowed();
          if (config.viewMode && viewLogger) {
            viewLogger.logComplete(toolName, toolCallId, params, ctx, result, Date.now() - start);
          }
          sendDeferredResult(pi, toolCallId, toolName, result, false);
        } catch (err) {
          if (config.viewMode && viewLogger) {
            viewLogger.logGuard(toolName, toolCallId, "blocked", params, ctx, String(err));
          }
          sendDeferredResult(pi, toolCallId, toolName, buildErrorResult(toolName, toolCallId, err), true);
        }
      } else {
        if (config.viewMode && viewLogger) {
          viewLogger.logGuard(toolName, toolCallId, "user-denied", params, ctx);
        }
        sendDeferredResult(
          pi,
          toolCallId,
          toolName,
          buildBlockedResult(toolName, toolCallId, nonAllowedPaths, "user denied"),
          true
        );
      }
    },
    contextSummary
  );
  if (config.viewMode && viewLogger) {
    viewLogger.logGuard(toolName, toolCallId, "pending", params, ctx);
  }
  return buildPendingResult(toolName, toolCallId, nonAllowedPaths);
}
function wrapTool(pi, allowedSet, promptQueue, viewLogger, enricher, config, localTool) {
  const originalExecute = localTool.execute.bind(localTool);
  return {
    ...localTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (config.viewMode && viewLogger) {
        viewLogger.logStart(localTool.name, toolCallId, params, ctx);
      }
      if (!config.guardEnabled || !allowedSet || !promptQueue) {
        try {
          const start = Date.now();
          const result = await originalExecute(toolCallId, params, signal, onUpdate, ctx);
          if (config.viewMode && viewLogger) {
            viewLogger.logComplete(localTool.name, toolCallId, params, ctx, result, Date.now() - start);
          }
          return result;
        } catch (err) {
          if (config.viewMode && viewLogger) {
            viewLogger.logGuard(localTool.name, toolCallId, "blocked", params, ctx, String(err));
          }
          return buildErrorResult(localTool.name, toolCallId, err);
        }
      }
      return handleGuardedTool(
        pi,
        allowedSet,
        promptQueue,
        viewLogger,
        enricher,
        config,
        localTool.name,
        params,
        toolCallId,
        () => originalExecute(toolCallId, params, signal, onUpdate, ctx),
        ctx
      );
    },
    renderResult: (result, options, theme, context) => {
      const details = result.details;
      if (details?.fileGuard) {
        const text = resultToText(result);
        const color = details.fileGuard === "pending" ? "warning" : "error";
        return new Text2(theme.fg(color, text), 0, 0);
      }
      if (localTool.renderResult) {
        return localTool.renderResult(result, options, theme, context);
      }
      return new Text2(theme.fg("muted", resultToText(result)), 0, 0);
    }
  };
}

// extensions/file-guard/src/gondolin.ts
import { relative as relative2 } from "node:path";
var GONDOLIN_SHARED_KEY = /* @__PURE__ */ Symbol.for("pi-packages.gondolin.shared");
function getGondolinHandle() {
  const value = globalThis[GONDOLIN_SHARED_KEY];
  if (typeof value !== "object" || value === null) return void 0;
  const handle = value;
  return handle.version === 1 ? handle : void 0;
}
var VM_TOOLS = ["read", "write", "edit", "bash"];
function isVmTool(toolName) {
  return VM_TOOLS.includes(toolName);
}
function createVmFsGuard(deps) {
  const ctxLike = { cwd: deps.cwd };
  const paramsFor = (request) => ({
    op: request.op,
    path: request.guestPath,
    write: request.write
  });
  return {
    async before(request) {
      const relPath = relative2(deps.cwd, request.hostPath);
      const relInside = relPath !== "" && !relPath.startsWith("..") && !relPath.includes(":");
      if (!request.write && !relInside && request.hostPath !== deps.cwd) return void 0;
      const allowed = deps.isAllowed(request.hostPath) || relInside && deps.isAllowed(relPath);
      if (allowed) return void 0;
      let reason;
      let status;
      if (deps.isDenied(request.hostPath) || relInside && deps.isDenied(relPath)) {
        reason = `${request.hostPath} was previously denied`;
        status = "blocked";
      } else if (!deps.hasUI) {
        if (deps.defaultPolicy === "allow") return void 0;
        reason = `no UI available to confirm ${request.op} on ${request.hostPath}`;
        status = "blocked";
      } else {
        const description = `${request.op} ${request.guestPath}${request.write ? " (write)" : ""}`;
        const approved = await deps.prompt("vm-fs", description, [request.hostPath]);
        if (approved) {
          deps.view?.logGuard(
            `vm-fs:${request.op}`,
            void 0,
            "allowed",
            paramsFor(request),
            ctxLike,
            "user allowed via prompt"
          );
          return void 0;
        }
        reason = `user denied ${request.hostPath}`;
        status = "user-denied";
      }
      deps.view?.logGuard(`vm-fs:${request.op}`, void 0, status, paramsFor(request), ctxLike, reason);
      deps.notify?.(
        `File Guard blocked ${request.op} ${request.guestPath} in the sandbox VM: ${reason}`,
        "warning"
      );
      return { reason };
    },
    async after(request) {
      if (!deps.view || !request.write) return;
      deps.view.logGuard(
        `vm-fs:${request.op}`,
        void 0,
        "auto-allowed",
        paramsFor(request),
        ctxLike,
        "sandbox VM filesystem"
      );
    }
  };
}
function isInterceptionActive(gondolinEnabled, guardEnabled) {
  return gondolinEnabled && guardEnabled;
}

// extensions/file-guard/src/includes.ts
import * as fs5 from "node:fs";
import * as path4 from "node:path";
function fileExists2(filePath) {
  try {
    fs5.accessSync(filePath, fs5.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
function modelKey(model) {
  return `${model.provider}/${model.id}`;
}
function lookupModelIncludeFiles(map, model) {
  if (!model) return void 0;
  return map[modelKey(model)];
}
function loadPiInclude(filePath, cwd) {
  const absPath = normalizePath(filePath, cwd);
  const patterns = [];
  try {
    const content = fs5.readFileSync(absPath, "utf-8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      patterns.push(expandHome(trimmed));
    }
  } catch {
  }
  return patterns;
}
var AllowedSet = class {
  constructor(cwd, config) {
    this.cwd = cwd;
    this.config = config;
    this.reload(void 0);
  }
  cwd;
  config;
  patterns = [];
  resolvedDirs = /* @__PURE__ */ new Set();
  explicitAllows = /* @__PURE__ */ new Set();
  explicitDenials = /* @__PURE__ */ new Set();
  dirty = false;
  loadedSources = {
    global: [],
    project: [],
    globalOverride: false,
    projectOverride: false
  };
  isDirty() {
    return this.dirty;
  }
  getLoadedSources() {
    return { ...this.loadedSources };
  }
  reload(model) {
    this.patterns = [];
    this.resolvedDirs.clear();
    this.loadedSources = {
      global: [],
      project: [],
      modelKey: model ? modelKey(model) : void 0,
      globalOverride: false,
      projectOverride: false
    };
    const globalResult = this.loadTier(
      this.config.globalIncludeFiles,
      this.config.globalModelIncludeFiles,
      model
    );
    this.loadedSources.global = globalResult.files;
    this.loadedSources.globalOverride = globalResult.usedModelTier;
    const projectResult = this.loadTier(
      this.config.projectIncludeFiles,
      this.config.projectModelIncludeFiles,
      model
    );
    this.loadedSources.project = projectResult.files;
    this.loadedSources.projectOverride = projectResult.usedModelTier;
  }
  loadTier(baseFiles, modelMap, model) {
    const modelFiles = lookupModelIncludeFiles(modelMap, model);
    const useModelTier = modelFiles !== void 0 && modelFiles.length > 0 && modelFiles.some((p) => fileExists2(normalizePath(p, this.cwd)));
    const filesToLoad = useModelTier ? modelFiles : baseFiles;
    for (const file of filesToLoad) this.addPiInclude(file);
    return { files: filesToLoad, usedModelTier: useModelTier };
  }
  addPiInclude(filePath) {
    for (const p of loadPiInclude(filePath, this.cwd)) {
      this.patterns.push(p);
      const abs = normalizePath(p, this.cwd);
      try {
        const stat = fs5.statSync(abs);
        if (stat.isDirectory()) {
          this.resolvedDirs.add(abs);
        }
      } catch {
      }
    }
  }
  recordDecision(pathOrPattern, allowed) {
    if (allowed) {
      if (!this.explicitAllows.has(pathOrPattern)) this.dirty = true;
      this.explicitAllows.add(pathOrPattern);
      if (this.explicitDenials.delete(pathOrPattern)) this.dirty = true;
    } else {
      if (!this.explicitDenials.has(pathOrPattern)) this.dirty = true;
      this.explicitDenials.add(pathOrPattern);
      if (this.explicitAllows.delete(pathOrPattern)) this.dirty = true;
    }
  }
  isAllowed(inputPath) {
    if (!inputPath) return true;
    const absPath = normalizePath(inputPath, this.cwd);
    if (this.explicitDenials.has(absPath) || this.explicitDenials.has(inputPath)) return false;
    if (this.explicitAllows.has(absPath) || this.explicitAllows.has(inputPath)) return true;
    for (const dir of this.resolvedDirs) {
      if (pathWithin2(dir, absPath) || absPath === dir) return true;
    }
    for (const pattern of this.patterns) {
      if (globMatch(pattern, absPath)) return true;
      if (globMatch(pattern, inputPath)) return true;
      if (globMatch(pattern, path4.basename(absPath))) return true;
    }
    return false;
  }
  isDenied(inputPath) {
    if (!inputPath) return false;
    const absPath = normalizePath(inputPath, this.cwd);
    return this.explicitDenials.has(absPath) || this.explicitDenials.has(inputPath);
  }
  getAllowedPatterns() {
    return [...this.patterns, ...this.explicitAllows];
  }
  restore(state) {
    for (const p of state.allowedPaths ?? []) this.explicitAllows.add(p);
    for (const p of state.deniedPaths ?? []) this.explicitDenials.add(p);
    this.dirty = false;
  }
  serialize() {
    this.dirty = false;
    return {
      allowedPaths: [...this.explicitAllows],
      deniedPaths: [...this.explicitDenials]
    };
  }
};
function pathWithin2(parent, child) {
  const rel = path4.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path4.isAbsolute(rel);
}

// extensions/file-guard/src/prompts.ts
var PromptQueue = class {
  constructor(ctx, allowedSet) {
    this.ctx = ctx;
    this.allowedSet = allowedSet;
  }
  ctx;
  allowedSet;
  current = [];
  processing = false;
  postponed = [];
  request(toolName, description, paths, contextSummary) {
    return new Promise((resolve2) => {
      this.add({
        id: `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        toolName,
        description,
        contextSummary,
        paths: [...paths],
        resolve: resolve2
      });
    });
  }
  requestCallback(toolName, description, paths, callback, contextSummary) {
    this.add({
      id: `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      toolName,
      description,
      contextSummary,
      paths: [...paths],
      resolve: callback
    });
  }
  add(req) {
    if (this.processing) {
      this.postponed.push(req);
    } else {
      this.current.push(req);
      void this.process();
    }
  }
  async process() {
    if (this.processing || this.current.length === 0) return;
    this.processing = true;
    const batch = this.current;
    this.current = [];
    const { ctx, allowedSet } = this;
    if (!ctx.hasUI) {
      for (const req of batch) {
        for (const p of req.paths) allowedSet.recordDecision(p, false);
        req.resolve(false);
      }
      this.finishBatch();
      return;
    }
    const lines = batch.map((req, i) => {
      const ctxLine = req.contextSummary ? `
    ${req.contextSummary}` : "";
      return `${i + 1}. ${req.description}${ctxLine}`;
    });
    const toggles = new Array(batch.length).fill(false);
    const buildOptions = () => {
      const itemOptions = lines.map((line, i) => {
        const marker = toggles[i] ? "[x]" : "[ ]";
        return `${marker} ${line}`;
      });
      return ["\u2713 Confirm selections", "Allow all", "Deny all", ...itemOptions];
    };
    while (true) {
      const choice = await ctx.ui.select("File Guard: allow agent access?", buildOptions());
      if (choice === void 0 || choice === "Deny all") {
        for (const req of batch) {
          for (const p of req.paths) allowedSet.recordDecision(p, false);
          req.resolve(false);
        }
        break;
      }
      if (choice === "Allow all") {
        for (const req of batch) {
          for (const p of req.paths) allowedSet.recordDecision(p, true);
          req.resolve(true);
        }
        break;
      }
      if (choice === "\u2713 Confirm selections") {
        for (let i = 0; i < batch.length; i++) {
          const req = batch[i];
          for (const p of req.paths) allowedSet.recordDecision(p, toggles[i]);
          req.resolve(toggles[i]);
        }
        break;
      }
      const toggleIndex = buildOptions().indexOf(choice) - 3;
      if (toggleIndex >= 0 && toggleIndex < batch.length) {
        toggles[toggleIndex] = !toggles[toggleIndex];
      }
    }
    this.finishBatch();
  }
  finishBatch() {
    this.processing = false;
    this.current = this.postponed;
    this.postponed = [];
    if (this.current.length > 0) {
      void this.process();
    }
  }
};

// extensions/file-guard/src/compress.ts
import * as fs6 from "node:fs";
import * as path5 from "node:path";
function buildSegmentTree(paths) {
  const roots = [];
  for (const p of paths) {
    const parts = p.split(/[\\/]+/).filter(Boolean);
    if (parts.length === 0) continue;
    let level = roots;
    for (const segment of parts) {
      let node = level.find((n) => n.segment === segment);
      if (!node) {
        node = { segment, children: [] };
        level.push(node);
      }
      level = node.children;
    }
  }
  return roots;
}
function commonPrefix(strs) {
  if (strs.length === 0) return "";
  let prefix = strs[0];
  for (const s of strs.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}
function renderTree(nodes) {
  if (nodes.length === 0) return "";
  nodes.sort((a, b) => a.segment.localeCompare(b.segment));
  const leaves = nodes.filter((n) => n.children.length === 0);
  const branches = nodes.filter((n) => n.children.length > 0);
  const parts = leaves.map((n) => n.segment);
  if (branches.length > 0) {
    const rendered = branches.map((n) => {
      const child = renderTree(n.children);
      return child ? `${n.segment}/${child}` : `${n.segment}/`;
    });
    if (rendered.length === 1) {
      parts.push(rendered[0]);
    } else {
      const prefix = commonPrefix(rendered);
      if (prefix.length > 0) {
        parts.push(`${prefix}{${rendered.map((r) => r.slice(prefix.length)).join(",")}}`);
      } else {
        parts.push(`{${rendered.join(",")}}`);
      }
    }
  }
  if (parts.length === 1) return parts[0];
  return `{${parts.join(",")}}`;
}
function* walkDir(dir, remaining) {
  if (remaining <= 0) return;
  let entries = [];
  try {
    entries = fs6.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".piinclude") continue;
    const full = path5.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(full, remaining - 1);
    } else {
      yield full;
      remaining--;
      if (remaining <= 0) return;
    }
  }
}
function compressAllowedPaths(allowedSet, cwd) {
  const patterns = allowedSet.getAllowedPatterns();
  const resolved = [];
  for (const pattern of patterns) {
    const abs = normalizePath(pattern, cwd);
    try {
      const stat = fs6.statSync(abs);
      if (stat.isDirectory()) {
        for (const f of walkDir(abs, 500)) {
          resolved.push(path5.relative(cwd, f).replace(/\\/g, "/") || ".");
        }
      } else {
        resolved.push(path5.relative(cwd, abs).replace(/\\/g, "/") || ".");
      }
    } catch {
      resolved.push(pattern.replace(/\\/g, "/"));
    }
  }
  const unique = [...new Set(resolved)].sort();
  if (unique.length === 0) return "";
  if (unique.length > 200) {
    return `{${unique.slice(0, 200).join(",")},... (${unique.length - 200} more)}`;
  }
  return renderTree(buildSegmentTree(unique));
}

// extensions/file-guard/index.ts
var OVERRIDDEN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];
function modelsEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.provider === b.provider && a.id === b.id;
}
function formatIncludeTier(label, files, override) {
  return `${label} (${override ? "model override" : "base"}): ${files.join(", ") || "(none)"}`;
}
function fileGuardExtension(pi) {
  let config;
  let allowedSet;
  let promptQueue;
  let viewLogger;
  let enricher;
  let currentModel;
  let gondolinHandle;
  let gondolinVmActive = false;
  let interception = false;
  let unregisterVmGuard;
  const pendingToolDefs = [];
  const wrappedToolNames = /* @__PURE__ */ new Set();
  const originalRegisterTool = pi.registerTool.bind(pi);
  function anyModeActive() {
    return config.guardEnabled || config.viewMode;
  }
  function maybeWrapTool(toolDef) {
    if (!anyModeActive() || !config.wrapAllTools || !allowedSet || !promptQueue || !viewLogger) return toolDef;
    if (!toolDef?.name) return toolDef;
    if (gondolinVmActive && isVmTool(toolDef.name)) return toolDef;
    wrappedToolNames.add(toolDef.name);
    return wrapTool(pi, allowedSet, promptQueue, viewLogger, enricher, config, toolDef);
  }
  pi.registerTool = (toolDef) => {
    if (!config) {
      pendingToolDefs.push(toolDef);
      return;
    }
    if (!anyModeActive()) {
      originalRegisterTool(toolDef);
      return;
    }
    if (!allowedSet) {
      pendingToolDefs.push(toolDef);
      return;
    }
    originalRegisterTool(maybeWrapTool(toolDef));
  };
  function reloadIncludes(model) {
    allowedSet?.reload(model);
  }
  function reinitialize(ctx) {
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
        const data = entry.data;
        if (data) allowedSet.restore(data);
      }
    }
  }
  function formatStatusLines(model) {
    if (!allowedSet) return [];
    const sources = allowedSet.getLoadedSources();
    return [
      `Guard mode: ${config.guardEnabled}`,
      `View mode: ${config.viewMode}`,
      `Wrap all tools: ${config.wrapAllTools}`,
      `Model: ${model ? modelKey(model) : "(none)"}`,
      formatIncludeTier("Global includes", sources.global, sources.globalOverride),
      formatIncludeTier("Project includes", sources.project, sources.projectOverride),
      `Default policy (non-interactive): ${config.defaultPolicy}`
    ];
  }
  function persist() {
    if (allowedSet?.isDirty()) {
      pi.appendEntry("file-guard-state", allowedSet.serialize());
    }
  }
  registerViewRenderer(pi);
  pi.on("tool_call", async (event, ctx) => {
    if (!anyModeActive()) return void 0;
    if (!allowedSet || !promptQueue) {
      reinitialize(ctx);
      currentModel = ctx.model;
      reloadIncludes(ctx.model);
    }
    if (gondolinVmActive && isVmTool(event.toolName)) return void 0;
    if (OVERRIDDEN_TOOLS.includes(event.toolName) || wrappedToolNames.has(event.toolName)) return void 0;
    if (!config.guardEnabled) return void 0;
    const guardInfo = extractToolPaths(event.toolName, event.input, ctx.cwd);
    if (!guardInfo) return void 0;
    const nonAllowedPaths = guardInfo.paths.filter((p) => !allowedSet.isAllowed(p));
    if (nonAllowedPaths.length === 0) return void 0;
    if (nonAllowedPaths.every((p) => allowedSet.isDenied(p))) {
      if (config.viewMode && viewLogger) {
        viewLogger.logGuard(event.toolName, event.toolCallId, "blocked", event.input, ctx, "previously denied");
      }
      return { block: true, reason: `File Guard: ${nonAllowedPaths.join(", ")} was previously denied.` };
    }
    if (!ctx.hasUI) {
      if (config.defaultPolicy === "allow") return void 0;
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
      }
    }
    const approved = await promptQueue.request(
      event.toolName,
      `${guardInfo.reason}: ${nonAllowedPaths.join(", ")}`,
      nonAllowedPaths,
      contextSummary
    );
    if (!approved) {
      if (config.viewMode && viewLogger) {
        viewLogger.logGuard(event.toolName, event.toolCallId, "user-denied", event.input, ctx);
      }
      return { block: true, reason: `File Guard: user denied ${nonAllowedPaths.join(", ")}.` };
    }
    return void 0;
  });
  pi.on("session_start", async (_event, ctx) => {
    reinitialize(ctx);
    currentModel = ctx.model;
    reloadIncludes(ctx.model);
    gondolinHandle = getGondolinHandle();
    gondolinVmActive = gondolinHandle ? gondolinHandle.refreshTrust(ctx.isProjectTrusted()) : false;
    interception = isInterceptionActive(gondolinVmActive, config.guardEnabled);
    if (gondolinHandle && gondolinVmActive && (config.guardEnabled || config.viewMode) && allowedSet && promptQueue) {
      const guard = createVmFsGuard({
        cwd: ctx.cwd,
        isAllowed: (p) => allowedSet.isAllowed(p),
        isDenied: (p) => allowedSet.isDenied(p),
        prompt: (toolName, description, paths, contextSummary) => promptQueue.request(toolName, description, paths, contextSummary),
        ...viewLogger ? { view: viewLogger } : {},
        ...ctx.hasUI ? { notify: (message, level) => ctx.ui.notify(message, level) } : {},
        hasUI: ctx.hasUI,
        defaultPolicy: config.defaultPolicy
      });
      unregisterVmGuard?.();
      unregisterVmGuard = gondolinHandle.registerFsGuard(guard);
    }
    for (const toolDef of pendingToolDefs.splice(0)) {
      originalRegisterTool(maybeWrapTool(toolDef));
    }
    if (!anyModeActive()) return;
    if (config.guardEnabled || config.viewMode) {
      const localGrep = createGrepTool(ctx.cwd);
      const localFind = createFindTool(ctx.cwd);
      const localLs = createLsTool(ctx.cwd);
      const hostTools = gondolinVmActive ? [localGrep, localFind, localLs] : [
        createReadTool(ctx.cwd),
        createWriteTool(ctx.cwd),
        createEditTool(ctx.cwd),
        createBashTool(ctx.cwd),
        localGrep,
        localFind,
        localLs
      ];
      for (const tool of hostTools) {
        originalRegisterTool(wrapTool(pi, allowedSet, promptQueue, viewLogger, enricher, config, tool));
      }
    }
    if (ctx.hasUI) {
      const parts = [];
      if (config.guardEnabled) parts.push(interception ? "guard (VM interception)" : "guard");
      if (config.viewMode) parts.push("view");
      if (parts.length > 0) {
        ctx.ui.notify(`File Guard active (${parts.join(" + ")}) \u2014 use \`/file-guard\` to inspect.`, "info");
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
      ctx.ui.notify(`File Guard reloaded for ${modelKey(event.model)}.
${lines.slice(2, 4).join("\n")}`, "info");
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
        `Gondolin interception: ${interception ? "active (policy enforced at the VM filesystem layer)" : gondolinHandle ? "inactive (Gondolin " + (gondolinVmActive ? "enabled but guard mode off" : "disabled") + ")" : "not installed"}`,
        `Allowed paths: ${compressed || "(none)"}`
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (!anyModeActive() || !allowedSet) return void 0;
    if (!modelsEqual(ctx.model, currentModel)) {
      currentModel = ctx.model;
      reloadIncludes(ctx.model);
    }
    const compressed = compressAllowedPaths(allowedSet, ctx.cwd);
    const lines = [];
    lines.push("## File Guard");
    if (config.guardEnabled) {
      if (interception) {
        lines.push(
          "Filesystem access is enforced inside the sandbox VM: operations on paths outside the allowed set fail with `EACCES` (Permission denied)."
        );
        lines.push(
          "The user may be prompted when a tool touches a path outside the allowed set; granted access persists for the session. Denied paths fail immediately."
        );
      } else {
        lines.push(
          "The agent may only access files listed in configured `.piinclude` files and paths the user has explicitly allowed during this session."
        );
        lines.push(
          "Model-specific include files may override base includes per tier when configured in `.pi/file-guard.json`."
        );
        lines.push("");
        lines.push(
          "Tool results may be deferred while the user reviews file access. A result starting with `[File Guard pending]` is a placeholder."
        );
        lines.push(
          "The real result or a block notice will arrive as a user message starting with `[File Guard result for tool call <id>]` or `[File Guard blocked tool call <id>]`."
        );
        lines.push("Treat that follow-up message as the result for the matching tool call; do not act on the pending placeholder.");
      }
    }
    if (config.viewMode) {
      if (config.guardEnabled) lines.push("");
      lines.push(
        interception ? "File Guard view mode is active: mutating filesystem operations inside the sandbox VM and host-side search tools are logged as timeline entries." : "File Guard view mode is active: reads, writes, edits, bash, grep, find, and ls operations are logged as timeline entries with extracted context."
      );
    }
    if (compressed) {
      lines.push("");
      lines.push("Allowed paths:");
      lines.push(compressed);
    }
    return { systemPrompt: `${event.systemPrompt}

${lines.join("\n")}` };
  });
  pi.on("turn_end", async () => {
    persist();
  });
  pi.on("session_shutdown", async () => {
    persist();
    unregisterVmGuard?.();
    unregisterVmGuard = void 0;
  });
}
export {
  fileGuardExtension as default
};
