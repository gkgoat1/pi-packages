import { createRequire as __createRequire } from 'node:module';const require = __createRequire(import.meta.url);

// extensions/gondolin/index.ts
import path3 from "node:path";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool
} from "@earendil-works/pi-coding-agent";
import { existsSync as existsSync3 } from "node:fs";
import { VM, createHttpHooks } from "@earendil-works/gondolin";

// extensions/gondolin/src/config.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
var DEFAULTS = {
  enabled: false,
  accel: "tcg",
  guestWorkspace: "/workspace",
  envPassthrough: [],
  httpProxy: {
    enabled: true,
    discoverKnownSecrets: true,
    secrets: {}
  },
  mounts: []
};
function skillsHostPaths(home = homedir()) {
  return [join(home, ".pi", "agent", "skills"), join(home, ".agents", "skills")];
}
function defaultSkillsGuestPath(hostPath, home = homedir()) {
  for (const root of skillsHostPaths(home)) {
    if (hostPath === root) return "/root" + hostPath.slice(home.length);
  }
  return void 0;
}
function defaultMounts(home = homedir()) {
  return skillsHostPaths(home).map((hostPath) => ({
    hostPath,
    access: "ro",
    guestPath: defaultSkillsGuestPath(hostPath, home)
  }));
}
function withDefaults() {
  return {
    ...DEFAULTS,
    httpProxy: { ...DEFAULTS.httpProxy, secrets: {} },
    mounts: defaultMounts()
  };
}
function asObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function asStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : void 0;
}
function parseSecretSpec(value) {
  const object = asObject(value);
  if (!object) return void 0;
  const hosts = asStringArray(object.hosts);
  if (!hosts) return void 0;
  if (hosts.length === 0) return null;
  const spec = { hosts };
  if (typeof object.envVar === "string" && object.envVar) spec.envVar = object.envVar;
  return spec;
}
function normalizeHostKey(key, home) {
  if (key === "skills") return skillsHostPaths(home);
  if (key === "~") return [home];
  if (key.startsWith("~/")) return [join(home, key.slice(2))];
  if (key.startsWith("/")) return [key];
  return void 0;
}
function normalizeGuestPath(value, hostPath, home) {
  let guestPath;
  if (typeof value === "string" && value.startsWith("/")) guestPath = value;
  if (!guestPath) {
    guestPath = defaultSkillsGuestPath(hostPath, home) ?? `/mnt/${basename(hostPath)}`;
  }
  const segments = [];
  for (const segment of guestPath.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") return void 0;
    segments.push(segment);
  }
  if (segments.length === 0) return void 0;
  return `/${segments.join("/")}`;
}
function parseMountsValue(raw) {
  const object = asObject(raw);
  if (!object) return [];
  const home = homedir();
  const byHost = /* @__PURE__ */ new Map();
  for (const [key, value] of Object.entries(object)) {
    const paths = normalizeHostKey(key, home);
    if (!paths) continue;
    let access;
    let guestRaw;
    if (value === "ro" || value === "rw") access = value;
    else if (asObject(value)) {
      const accessRaw = asObject(value)?.access;
      if (accessRaw === "ro" || accessRaw === "rw") access = accessRaw;
      else continue;
      guestRaw = asObject(value)?.guestPath;
    } else continue;
    for (const hostPath of paths) {
      const guestPath = normalizeGuestPath(guestRaw, hostPath, home);
      if (!guestPath) continue;
      byHost.set(hostPath, { hostPath, access, guestPath });
    }
  }
  const mounts = [];
  for (const entry of byHost.values()) {
    const clash = mounts.findIndex((existing) => existing.guestPath === entry.guestPath);
    if (clash >= 0) mounts.splice(clash, 1);
    mounts.push(entry);
  }
  return mounts;
}
function parseLayer(value) {
  const root = asObject(value);
  if (!root) return {};
  const layer = {};
  if (typeof root.enabled === "boolean") layer.enabled = root.enabled;
  if (typeof root.accel === "string" && root.accel) layer.accel = root.accel;
  if (typeof root.guestWorkspace === "string" && root.guestWorkspace.startsWith("/")) {
    layer.guestWorkspace = root.guestWorkspace;
  }
  if (typeof root.memory === "string" && root.memory) layer.memory = root.memory;
  if (Number.isInteger(root.cpus) && root.cpus > 0) layer.cpus = root.cpus;
  if (typeof root.image === "string" && root.image) layer.image = root.image;
  if (Number.isInteger(root.startTimeoutMs) && root.startTimeoutMs >= 0) {
    layer.startTimeoutMs = root.startTimeoutMs;
  }
  const allowedHosts = asStringArray(root.allowedHosts);
  if (allowedHosts) layer.allowedHosts = allowedHosts;
  const envPassthrough = asStringArray(root.envPassthrough);
  if (envPassthrough) layer.envPassthrough = envPassthrough;
  const proxy = asObject(root.httpProxy);
  if (proxy) {
    const parsed = {};
    if (typeof proxy.enabled === "boolean") parsed.enabled = proxy.enabled;
    if (typeof proxy.discoverKnownSecrets === "boolean") {
      parsed.discoverKnownSecrets = proxy.discoverKnownSecrets;
    }
    const secretMap = asObject(proxy.secrets);
    if (secretMap) {
      const secrets = {};
      for (const [name, raw] of Object.entries(secretMap)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
        const spec = parseSecretSpec(raw);
        if (spec !== void 0) secrets[name] = spec;
      }
      parsed.secrets = secrets;
    }
    if (Object.keys(parsed).length > 0) layer.httpProxy = parsed;
  }
  if (root.mounts !== void 0) {
    layer.mounts = parseMountsValue(root.mounts);
    layer.mountsExplicit = true;
  }
  return layer;
}
function cloneConfig(base) {
  return { ...base, httpProxy: { ...base.httpProxy, secrets: { ...base.httpProxy.secrets } } };
}
function applyOverride(base, layer) {
  const next = cloneConfig(base);
  if (layer.enabled !== void 0) next.enabled = layer.enabled;
  if (layer.accel) next.accel = layer.accel;
  if (layer.guestWorkspace) next.guestWorkspace = layer.guestWorkspace;
  if (layer.memory) next.memory = layer.memory;
  if (layer.cpus !== void 0) next.cpus = layer.cpus;
  if (layer.image) next.image = layer.image;
  if (layer.startTimeoutMs !== void 0) next.startTimeoutMs = layer.startTimeoutMs;
  if (layer.allowedHosts) next.allowedHosts = [...layer.allowedHosts];
  if (layer.envPassthrough) next.envPassthrough = [...layer.envPassthrough];
  if (layer.httpProxy) {
    if (layer.httpProxy.enabled !== void 0) next.httpProxy.enabled = layer.httpProxy.enabled;
    if (layer.httpProxy.discoverKnownSecrets !== void 0) {
      next.httpProxy.discoverKnownSecrets = layer.httpProxy.discoverKnownSecrets;
    }
    if (layer.httpProxy.secrets) {
      for (const [name, spec] of Object.entries(layer.httpProxy.secrets)) {
        if (spec === null) delete next.httpProxy.secrets[name];
        else next.httpProxy.secrets[name] = { hosts: [...spec.hosts], ...spec.envVar ? { envVar: spec.envVar } : {} };
      }
    }
  }
  if (layer.mountsExplicit) next.mounts = layer.mounts ? layer.mounts.map((m) => ({ ...m })) : [];
  return next;
}
function applyRestricting(base, layer) {
  const next = cloneConfig(base);
  if (layer.allowedHosts) {
    next.allowedHosts = base.allowedHosts ? layer.allowedHosts.filter((host) => base.allowedHosts.includes(host)) : [...layer.allowedHosts];
  }
  if (layer.envPassthrough) {
    const requested = new Set(layer.envPassthrough);
    next.envPassthrough = base.envPassthrough.filter((name) => requested.has(name));
  }
  if (layer.httpProxy) {
    if (layer.httpProxy.enabled === false) next.httpProxy.enabled = false;
    if (layer.httpProxy.discoverKnownSecrets === false) {
      next.httpProxy.discoverKnownSecrets = false;
    }
    if (layer.httpProxy.secrets) {
      for (const [name, spec] of Object.entries(layer.httpProxy.secrets)) {
        const current = next.httpProxy.secrets[name];
        if (!current) continue;
        if (spec === null) {
          delete next.httpProxy.secrets[name];
          continue;
        }
        const hosts = spec.hosts.filter((host) => current.hosts.includes(host));
        if (hosts.length === 0) delete next.httpProxy.secrets[name];
        else next.httpProxy.secrets[name] = { hosts, ...current.envVar ? { envVar: current.envVar } : {} };
      }
    }
  }
  next.mounts = restrictMounts(base.mounts, layer.mounts);
  return next;
}
function restrictMounts(ceiling, requested) {
  if (!requested) return ceiling.map((m) => ({ ...m }));
  const byHost = new Map(ceiling.map((m) => [m.hostPath, m]));
  const out = [];
  for (const request of requested) {
    const cap = byHost.get(request.hostPath);
    if (!cap) continue;
    const access = request.access === "rw" && cap.access === "ro" ? "ro" : request.access;
    out.push({ hostPath: cap.hostPath, guestPath: cap.guestPath, access });
  }
  return out;
}
function applyLayer(base, layer, authority) {
  if (authority === "global" || authority === "env") return applyOverride(base, layer);
  if (authority === "trusted") {
    const overridden = applyOverride(base, { ...layer, mounts: void 0, mountsExplicit: void 0 });
    overridden.mounts = restrictMounts(base.mounts, layer.mounts);
    return overridden;
  }
  return applyRestricting(base, layer);
}
function parseEnablementEnv(value) {
  if (value === void 0) return void 0;
  const compact = value.trim().toLowerCase().replace(/[-_\s]+/g, "");
  if (!compact) return void 0;
  if (["force", "true", "1", "yes", "on"].includes(compact)) return true;
  if (["dangerouslyforcedisable", "false", "0", "no", "off"].includes(compact)) return false;
  return void 0;
}
function envLayer() {
  let layer = {};
  const encoded = process.env.PI_GONDOLIN_CONFIG;
  if (encoded) {
    try {
      layer = parseLayer(JSON.parse(encoded));
    } catch {
      layer = {};
    }
  }
  const enabled = parseEnablementEnv(process.env.PI_GONDOLIN_ENABLED);
  if (enabled !== void 0) layer.enabled = enabled;
  return layer;
}
function readLayer(path4) {
  if (!existsSync(path4)) return {};
  try {
    return parseLayer(JSON.parse(readFileSync(path4, "utf8")));
  } catch {
    return {};
  }
}
function loadConfig(ctx) {
  const globalLayer = readLayer(join(homedir(), ".pi", "agent", "gondolin.json"));
  const repoLayer = readLayer(join(ctx.cwd, CONFIG_DIR_NAME, "gondolin.json"));
  const repoAuthority = ctx.isProjectTrusted() ? "trusted" : "untrusted";
  return applyLayer(
    applyLayer(applyLayer(withDefaults(), globalLayer, "global"), repoLayer, repoAuthority),
    envLayer(),
    "env"
  );
}

// extensions/gondolin/src/secrets.ts
import { randomBytes } from "node:crypto";
var KNOWN_SECRET_HOSTS = {
  // LLM / AI providers
  ANTHROPIC_API_KEY: ["api.anthropic.com"],
  ANTHROPIC_AUTH_TOKEN: ["api.anthropic.com"],
  OPENAI_API_KEY: ["api.openai.com"],
  GEMINI_API_KEY: ["generativelanguage.googleapis.com"],
  GOOGLE_API_KEY: ["generativelanguage.googleapis.com"],
  GOOGLE_GENERATIVE_AI_API_KEY: ["generativelanguage.googleapis.com"],
  GROQ_API_KEY: ["api.groq.com"],
  MISTRAL_API_KEY: ["api.mistral.ai"],
  OPENROUTER_API_KEY: ["openrouter.ai"],
  DEEPSEEK_API_KEY: ["api.deepseek.com"],
  TOGETHER_API_KEY: ["api.together.xyz"],
  TOGETHER_AI_API_KEY: ["api.together.xyz"],
  FIREWORKS_API_KEY: ["api.fireworks.ai"],
  COHERE_API_KEY: ["api.cohere.com"],
  XAI_API_KEY: ["api.x.ai"],
  GROK_API_KEY: ["api.x.ai"],
  PERPLEXITY_API_KEY: ["api.perplexity.ai"],
  CEREBRAS_API_KEY: ["api.cerebras.ai"],
  // Model hubs
  HF_TOKEN: ["huggingface.co"],
  HUGGINGFACE_HUB_TOKEN: ["huggingface.co"],
  HUGGING_FACE_HUB_TOKEN: ["huggingface.co"],
  HF_API_TOKEN: ["huggingface.co"],
  // Code / package registries
  GITHUB_TOKEN: ["api.github.com", "github.com"],
  GH_TOKEN: ["api.github.com", "github.com"],
  GH_PAT: ["api.github.com", "github.com"],
  GITLAB_TOKEN: ["gitlab.com"],
  GITLAB_PAT: ["gitlab.com"],
  NPM_TOKEN: ["registry.npmjs.org"],
  CARGO_REGISTRY_TOKEN: ["crates.io", "static.crates.io", "index.crates.io"],
  GEM_HOST_API_KEY: ["rubygems.org"],
  PYPI_TOKEN: ["upload.pypi.org", "pypi.org"],
  POETRY_PYPI_TOKEN_PYPI: ["upload.pypi.org", "pypi.org"],
  TWINE_PASSWORD: ["upload.pypi.org", "pypi.org"],
  // Cloud / infra
  CLOUDFLARE_API_TOKEN: ["api.cloudflare.com"],
  CF_API_TOKEN: ["api.cloudflare.com"],
  CLOUDFLARE_API_KEY: ["api.cloudflare.com"],
  VERCEL_TOKEN: ["api.vercel.com"],
  NETLIFY_AUTH_TOKEN: ["api.netlify.com"],
  DIGITALOCEAN_ACCESS_TOKEN: ["api.digitalocean.com"],
  SENTRY_AUTH_TOKEN: ["sentry.io"],
  DATADOG_API_KEY: ["api.datadoghq.com"],
  DD_API_KEY: ["api.datadoghq.com"],
  STRIPE_SECRET_KEY: ["api.stripe.com"],
  STRIPE_API_KEY: ["api.stripe.com"]
};
var DENYLIST = /* @__PURE__ */ new Set([
  "",
  "test",
  "dummy",
  "placeholder",
  "changeme",
  "example",
  "xxx",
  "todo",
  "secret",
  "your_api_key",
  "your_token",
  "your_api_key_here",
  "your_token_here"
]);
function looksLikeSecretValue(value) {
  if (typeof value !== "string") return false;
  if (value.length < 8) return false;
  if (/\s/.test(value)) return false;
  if (DENYLIST.has(value.toLowerCase())) return false;
  return true;
}
var cryptoRandomSource = {
  hex(length) {
    const bytes = Math.ceil(length / 2);
    return randomBytes(bytes).toString("hex").slice(0, length);
  }
};
function makePlaceholder(name, random) {
  return `gondolin-stub-${name}-${random.hex(16)}`;
}
function candidates(config) {
  const map = /* @__PURE__ */ new Map();
  if (config.httpProxy.discoverKnownSecrets) {
    for (const [name, hosts] of Object.entries(KNOWN_SECRET_HOSTS)) {
      map.set(name, { name, envVar: name, hosts });
    }
  }
  for (const [name, spec] of Object.entries(config.httpProxy.secrets)) {
    map.set(name, { name, envVar: spec.envVar ?? name, hosts: spec.hosts });
  }
  return map;
}
function discoverSecrets(env, config, random = cryptoRandomSource) {
  if (!config.httpProxy.enabled) return [];
  const seen = /* @__PURE__ */ new Map();
  for (const candidate of candidates(config).values()) {
    const value = env[candidate.envVar];
    if (!looksLikeSecretValue(value)) continue;
    if (candidate.envVar.startsWith("PI_GONDOLIN_")) continue;
    seen.set(candidate.name, {
      name: candidate.name,
      envVar: candidate.envVar,
      hosts: candidate.hosts,
      value,
      placeholder: makePlaceholder(candidate.name, random)
    });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function buildSecretDefinitions(secrets) {
  const out = {};
  for (const secret of secrets) out[secret.name] = { hosts: secret.hosts, value: secret.value, placeholder: secret.placeholder };
  return out;
}
function buildStubEnv(secrets) {
  const env = {};
  for (const secret of secrets) env[secret.name] = secret.placeholder;
  return env;
}
function scrubValue(value, secrets) {
  if (secrets.length === 0) return value;
  const ordered = [...secrets].sort((a, b) => b.value.length - a.value.length);
  let result = value;
  for (const secret of ordered) {
    if (result.includes(secret.value)) {
      result = result.split(secret.value).join(secret.placeholder);
    }
  }
  return result;
}
function sanitizeGuestEnv(hostEnv, secrets, passthrough) {
  const out = {};
  if (!hostEnv) return out;
  const allow = new Set(passthrough);
  for (const name of passthrough) {
    const value = hostEnv[name];
    if (typeof value === "string") out[name] = scrubValue(value, secrets);
  }
  return out;
}

// extensions/gondolin/src/ops.ts
import path from "node:path";
var GUEST_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
function shQuote(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
function toGuestPath(localCwd, localPath, guestWorkspace) {
  const rel = path.relative(localCwd, localPath);
  if (rel === "") return guestWorkspace;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${localPath}`);
  }
  const posixRel = rel.split(path.sep).join(path.posix.sep);
  return path.posix.join(guestWorkspace, posixRel);
}
var GUEST_BASE_ENV = {
  PATH: GUEST_PATH,
  HOME: "/root",
  TERM: "xterm",
  LANG: "C.UTF-8"
};
function buildGuestEnv(options) {
  return sanitizeGuestEnv(options.hostEnv, options.secrets, options.passthrough);
}
function createReadOps(vm, localCwd, guestWorkspace) {
  return {
    readFile: async (p) => {
      const guestPath = toGuestPath(localCwd, p, guestWorkspace);
      const r = await vm.exec(["/bin/cat", guestPath]);
      if (!r.ok) {
        throw new Error(`cat failed (${r.exitCode}): ${r.stderr}`);
      }
      return r.stdoutBuffer;
    },
    access: async (p) => {
      const guestPath = toGuestPath(localCwd, p, guestWorkspace);
      const r = await vm.exec(["/bin/sh", "-lc", `test -r ${shQuote(guestPath)}`]);
      if (!r.ok) {
        throw new Error(`not readable: ${p}`);
      }
    },
    detectImageMimeType: async (p) => {
      const guestPath = toGuestPath(localCwd, p, guestWorkspace);
      try {
        const r = await vm.exec(["/bin/sh", "-lc", `file --mime-type -b ${shQuote(guestPath)}`]);
        if (!r.ok) return null;
        const m = r.stdout.trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
      } catch {
        return null;
      }
    }
  };
}
function createWriteOps(vm, localCwd, guestWorkspace) {
  return {
    writeFile: async (p, content) => {
      const guestPath = toGuestPath(localCwd, p, guestWorkspace);
      const dir = path.posix.dirname(guestPath);
      const b64 = Buffer.from(content).toString("base64");
      const script = [
        `set -eu`,
        `mkdir -p ${shQuote(dir)}`,
        `echo ${shQuote(b64)} | base64 -d > ${shQuote(guestPath)}`
      ].join("\n");
      const r = await vm.exec(["/bin/sh", "-lc", script]);
      if (!r.ok) {
        throw new Error(`write failed (${r.exitCode}): ${r.stderr}`);
      }
    },
    mkdir: async (dir) => {
      const guestDir = toGuestPath(localCwd, dir, guestWorkspace);
      const r = await vm.exec(["/bin/mkdir", "-p", guestDir]);
      if (!r.ok) {
        throw new Error(`mkdir failed (${r.exitCode}): ${r.stderr}`);
      }
    }
  };
}
function createEditOps(vm, localCwd, guestWorkspace) {
  const r = createReadOps(vm, localCwd, guestWorkspace);
  const w = createWriteOps(vm, localCwd, guestWorkspace);
  return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}
function buildSandboxPromptAddendum(config, localCwd) {
  const lines = [
    "",
    "## Gondolin sandbox",
    `- You are running inside a micro-VM; host ${localCwd} is mounted read-write at ${config.guestWorkspace}.`
  ];
  for (const mount of config.mounts) {
    const access = mount.access === "ro" ? "read-only" : "read-write";
    lines.push(
      `- Host ${mount.hostPath} is mounted ${access} at ${mount.guestPath}: host paths under ${mount.hostPath} resolve to ${mount.guestPath} inside the sandbox${mount.access === "ro" ? " (writes there fail with EROFS)" : ""}.`
    );
  }
  if (config.httpProxy.enabled) {
    lines.push(
      "- API keys in the environment are sandbox stubs (they start with `gondolin-stub-`). Do not try to exchange or decode them: outbound HTTP requests that use a stub are transparently replaced with the real credential by the sandbox proxy, but only for that credential's allowed hosts.",
      "- Requests carrying any other credential (including real, non-stub keys you obtain from the user) pass through the proxy unmodified."
    );
  }
  return lines.join("\n");
}
function createGondolinReadOps(vm, localCwd, guestWorkspace) {
  return createReadOps(vm, localCwd, guestWorkspace);
}
function createGondolinWriteOps(vm, localCwd, guestWorkspace) {
  return createWriteOps(vm, localCwd, guestWorkspace);
}
function createGondolinEditOps(vm, localCwd, guestWorkspace) {
  return createEditOps(vm, localCwd, guestWorkspace);
}
function createGondolinBashOps(vm, localCwd, guestWorkspace, envOptions) {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const guestCwd = toGuestPath(localCwd, cwd, guestWorkspace);
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      const timer = timeout && timeout > 0 ? setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, timeout * 1e3) : void 0;
      try {
        const proc = vm.exec(["/bin/bash", "-lc", command], {
          cwd: guestCwd,
          signal: ac.signal,
          env: buildGuestEnv({ ...envOptions, hostEnv: env }),
          stdout: "pipe",
          stderr: "pipe"
        });
        for await (const chunk of proc.output()) {
          onData(chunk.data);
        }
        const r = await proc;
        return { exitCode: r.exitCode };
      } catch (err) {
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }
  };
}

// extensions/gondolin/src/shared.ts
import { existsSync as existsSync2 } from "node:fs";
import path2 from "node:path";
import { ReadonlyProvider, RealFSProvider, SandboxVfsProvider } from "@earendil-works/gondolin";
var GONDOLIN_SHARED_KEY = /* @__PURE__ */ Symbol.for("pi-packages.gondolin.shared");
var SKIP_FS_OPS = /* @__PURE__ */ new Set([
  "read",
  "readSync",
  "write",
  "writeSync",
  "release",
  "releaseSync",
  "close",
  "closeSync",
  "fsync",
  "fsyncSync",
  "flush",
  "statfs",
  "statfsSync",
  "watch",
  "watchAsync",
  "watchFile",
  "unwatchFile",
  "readlink",
  "readlinkSync",
  "realpath",
  "realpathSync"
]);
var WRITE_FS_OPS = /* @__PURE__ */ new Set([
  "create",
  "mknod",
  "mkdir",
  "mkdirSync",
  "rmdir",
  "rmdirSync",
  "unlink",
  "unlinkSync",
  "rename",
  "renameSync",
  "link",
  "linkSync",
  "symlink",
  "symlinkSync",
  "truncate",
  "truncateSync",
  "writeFile",
  "writeFileSync",
  "setattr",
  "utimens",
  "chmod",
  "chown"
]);
var O_ACCMODE = 3;
function isWriteFsOp(op, flags) {
  if (WRITE_FS_OPS.has(op)) return true;
  if (op !== "open" && op !== "openSync") return false;
  if (typeof flags === "number") return (flags & O_ACCMODE) !== 0;
  return typeof flags === "string" ? /[wa+]/.test(flags) : false;
}
function toHostPath(hostCwd, guestWorkspace, vfsPath) {
  let p = vfsPath;
  if (guestWorkspace && (p === guestWorkspace || p.startsWith(`${guestWorkspace}/`))) {
    p = p.slice(guestWorkspace.length);
  }
  p = p.replace(/^\/+/, "");
  if (p === "" || p === ".") return hostCwd;
  return path2.resolve(hostCwd, p);
}
function hostPathToGuestPath(hostCwd, guestWorkspace, hostPath) {
  const rel = path2.relative(hostCwd, hostPath);
  if (rel === "") return guestWorkspace;
  if (rel.startsWith("..") || path2.isAbsolute(rel)) return void 0;
  return path2.posix.join(guestWorkspace, rel.split(path2.sep).join("/"));
}
function createEaccesError(syscall, vfsPath, reason) {
  const error = new Error(`File Guard: ${reason}`);
  error.errno = 13;
  error.code = "EACCES";
  error.syscall = syscall;
  error.path = vfsPath;
  return error;
}
function createGuardedWorkspaceProvider(backend, guards, hostCwd, guestWorkspace) {
  const requestFor = (op, vfsPath, write) => ({
    op,
    guestPath: vfsPath,
    hostPath: toHostPath(hostCwd, guestWorkspace, vfsPath),
    write
  });
  return new SandboxVfsProvider(backend, {
    before: async (hook) => {
      if (SKIP_FS_OPS.has(hook.op)) return;
      const write = isWriteFsOp(hook.op, hook.flags);
      const paths = [hook.path, hook.oldPath, hook.newPath].filter(
        (p) => typeof p === "string" && p.length > 0
      );
      const unique = [...new Set(paths)];
      for (const p of unique) {
        const request = requestFor(hook.op, p, write);
        for (const guard of guards) {
          const decision = await guard.before?.(request);
          if (decision) throw createEaccesError(hook.op, p, decision.reason);
        }
      }
    },
    after: async (hook) => {
      if (SKIP_FS_OPS.has(hook.op)) return;
      const paths = [hook.path, hook.oldPath, hook.newPath].filter(
        (p) => typeof p === "string" && p.length > 0
      );
      const write = isWriteFsOp(hook.op, hook.flags);
      for (const p of new Set(paths)) {
        const request = requestFor(hook.op, p, write);
        for (const guard of guards) {
          void guard.after?.(request).catch(() => {
          });
        }
      }
    }
  });
}
function stubifyEnv(env, secrets) {
  if (secrets.length === 0) return env;
  const byValue = new Map(secrets.map((secret) => [secret.value, secret.placeholder]));
  const byName = new Map(secrets.map((secret) => [secret.name, secret.placeholder]));
  const stubbed = {};
  for (const [key, value] of Object.entries(env)) {
    stubbed[key] = byValue.get(value) ?? byName.get(key) ?? value;
  }
  return stubbed;
}
function launchGuestProcess(vm, spec, secrets, guestWorkspace) {
  const quoted = [spec.command, ...spec.args ?? []].map(shQuote).join(" ");
  const env = {
    ...GUEST_BASE_ENV,
    ...buildStubEnv(secrets),
    ...stubifyEnv(spec.env ?? {}, secrets)
  };
  return vm.exec(["/bin/sh", "-c", `exec ${quoted}`], {
    cwd: spec.cwd ?? guestWorkspace,
    env,
    stdin: true,
    stdout: "pipe",
    stderr: "pipe",
    ...spec.signal ? { signal: spec.signal } : {}
  });
}
function mapHostToGuestPath(hostCwd, guestWorkspace, mounts, hostPath) {
  const viaWorkspace = hostPathToGuestPath(hostCwd, guestWorkspace, hostPath);
  if (viaWorkspace) return viaWorkspace;
  for (const mount of mounts) {
    const rel = path2.relative(mount.hostPath, hostPath);
    if (rel === "") return mount.guestPath;
    if (!rel.startsWith("..") && !path2.isAbsolute(rel)) {
      return path2.posix.join(mount.guestPath, rel.split(path2.sep).join("/"));
    }
  }
  return void 0;
}
function buildExtraMountProviders(configMounts, guards, opts) {
  const exists = opts?.exists ?? existsSync2;
  const mounts = {};
  const skipped = [];
  for (const mount of configMounts) {
    if (mounts[mount.guestPath]) {
      skipped.push({ hostPath: mount.hostPath, guestPath: mount.guestPath, reason: "duplicate guest path" });
      continue;
    }
    if (!exists(mount.hostPath)) {
      skipped.push({ hostPath: mount.hostPath, guestPath: mount.guestPath, reason: "host path does not exist" });
      continue;
    }
    const guarded = createGuardedWorkspaceProvider(
      new RealFSProvider(mount.hostPath),
      guards,
      mount.hostPath,
      mount.guestPath
    );
    mounts[mount.guestPath] = mount.access === "ro" ? new ReadonlyProvider(guarded) : guarded;
  }
  return { mounts, skipped };
}
function installGondolinShared(handle) {
  globalThis[GONDOLIN_SHARED_KEY] = handle;
}

// extensions/gondolin/index.ts
function gondolinExtension(pi) {
  const localCwd = process.cwd();
  const fsGuards = /* @__PURE__ */ new Set();
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);
  let config = loadConfig({ cwd: localCwd, isProjectTrusted: () => false });
  const state = { vm: null, starting: null, error: void 0, secrets: [] };
  const trustedRef = { value: false };
  const shared = {
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
    }
  };
  installGondolinShared(shared);
  function statusLine(ctx, text, tone = "accent") {
    ctx.ui.setStatus("gondolin", ctx.ui.theme.fg(tone, `Gondolin: ${text}`));
  }
  async function ensureVm(ctx) {
    if (state.vm) return state.vm;
    if (state.starting) return state.starting;
    state.starting = (async () => {
      config = loadConfig({ cwd: localCwd, isProjectTrusted: () => trustedRef.value });
      state.secrets = discoverSecrets(process.env, config);
      const guestWorkspace = config.guestWorkspace;
      ctx?.ui.setStatus("gondolin", ctx.ui.theme.fg("accent", `Gondolin: starting (accel ${config.accel}, mount ${guestWorkspace})`));
      const extraMounts = buildExtraMountProviders(config.mounts, fsGuards);
      const vfsMounts = {
        [guestWorkspace]: createGuardedWorkspaceProvider(
          new RealFSProvider(localCwd),
          fsGuards,
          localCwd,
          guestWorkspace
        )
      };
      Object.assign(vfsMounts, extraMounts.mounts);
      const httpHooks = config.httpProxy.enabled ? createHttpHooks({
        // Omitted = allow all hosts; requests without stubs always pass through.
        ...config.allowedHosts ? { allowedHosts: config.allowedHosts } : {},
        secrets: buildSecretDefinitions(state.secrets)
      }).httpHooks : void 0;
      const created = await VM.create({
        env: { ...GUEST_BASE_ENV, ...buildStubEnv(state.secrets) },
        ...httpHooks ? { httpHooks } : {},
        ...config.memory ? { memory: config.memory } : {},
        ...config.cpus ? { cpus: config.cpus } : {},
        ...config.startTimeoutMs !== void 0 ? { startTimeoutMs: config.startTimeoutMs } : {},
        sandbox: {
          // Software emulation only: required for nested VMs and the
          // explicit default of this extension.
          accel: config.accel,
          ...config.image ? { imagePath: config.image } : {}
        },
        vfs: {
          // The host workspace is mounted through a guardable provider so
          // other extensions (File Guard) can enforce policy at the VM
          // filesystem layer instead of restricting the tools themselves.
          // Extra host mounts (skills, user folders) are added alongside.
          mounts: vfsMounts
        },
        sessionLabel: `pi-gondolin:${path3.basename(localCwd)}`
      });
      state.vm = created;
      state.error = void 0;
      const stubCount = state.secrets.length;
      const proxyNote = config.httpProxy.enabled ? `; ${stubCount} credential${stubCount === 1 ? "" : "s"} stubbed (real values stay host-side)` : "";
      const mountCount = Object.keys(extraMounts.mounts).length;
      const mountNote = mountCount > 0 ? `; ${mountCount} extra mount${mountCount === 1 ? "" : "s"}` : "";
      const skipNote = extraMounts.skipped.length > 0 ? `; ${extraMounts.skipped.length} mount${extraMounts.skipped.length === 1 ? "" : "s"} skipped` : "";
      ctx?.ui.notify(
        `Gondolin VM ready \u2014 host ${localCwd} mounted at ${guestWorkspace}${mountNote}${skipNote}${proxyNote}`,
        "info"
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
  pi.on("session_start", async (_event, ctx) => {
    trustedRef.value = ctx.isProjectTrusted();
    config = loadConfig({ cwd: ctx.cwd, isProjectTrusted: () => trustedRef.value });
    if (!config.enabled) return;
    await ensureVm(ctx).catch(() => {
    });
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
  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      if (!config.enabled) return localRead.execute(id, params, signal, onUpdate);
      const activeVm = await ensureVm(ctx);
      return createReadTool(localCwd, {
        operations: createGondolinReadOps(activeVm, localCwd, config.guestWorkspace)
      }).execute(id, params, signal, onUpdate);
    }
  });
  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      if (!config.enabled) return localWrite.execute(id, params, signal, onUpdate);
      const activeVm = await ensureVm(ctx);
      return createWriteTool(localCwd, {
        operations: createGondolinWriteOps(activeVm, localCwd, config.guestWorkspace)
      }).execute(id, params, signal, onUpdate);
    }
  });
  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      if (!config.enabled) return localEdit.execute(id, params, signal, onUpdate);
      const activeVm = await ensureVm(ctx);
      return createEditTool(localCwd, {
        operations: createGondolinEditOps(activeVm, localCwd, config.guestWorkspace)
      }).execute(id, params, signal, onUpdate);
    }
  });
  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      if (!config.enabled) return localBash.execute(id, params, signal, onUpdate);
      const activeVm = await ensureVm(ctx);
      return createBashTool(localCwd, {
        operations: createGondolinBashOps(activeVm, localCwd, config.guestWorkspace, {
          secrets: state.secrets,
          passthrough: config.envPassthrough
        })
      }).execute(id, params, signal, onUpdate);
    }
  });
  pi.on("user_bash", async (_event) => {
    if (!config.enabled) return;
    const activeVm = await ensureVm();
    return {
      operations: createGondolinBashOps(activeVm, localCwd, config.guestWorkspace, {
        secrets: state.secrets,
        passthrough: config.envPassthrough
      })
    };
  });
  pi.on("before_agent_start", async (event) => {
    if (!config.enabled) return;
    await ensureVm().catch(() => {
    });
    const modified = event.systemPrompt.replace(
      `Current working directory: ${localCwd}`,
      `Current working directory: ${config.guestWorkspace} (Gondolin VM, host mount: ${localCwd})`
    );
    return { systemPrompt: `${modified}${buildSandboxPromptAddendum(config, localCwd)}` };
  });
  pi.registerCommand("gondolin", {
    description: "Show Gondolin VM status, QEMU accel mode, and stubbed credential hosts",
    handler: async (_args, ctx) => {
      if (!config.enabled) {
        ctx.ui.notify(
          'Gondolin is disabled. Set "enabled": true in gondolin.json or PI_GONDOLIN_ENABLED=true to enable it.',
          "info"
        );
        return;
      }
      const lines = [
        `vm: ${state.vm ? "running" : state.starting ? "starting" : state.error ? `failed \u2014 ${state.error}` : "not started"}`,
        `accel: ${config.accel} (QEMU; "tcg" = software emulation, nested-VM safe)`,
        `mount: ${localCwd} \u2192 ${config.guestWorkspace} (read-write)`
      ];
      for (const mount of config.mounts) {
        const missing = existsSync3(mount.hostPath) ? "" : " (host path does not exist; not mounted)";
        lines.push(`mount: ${mount.hostPath} \u2192 ${mount.guestPath} (${mount.access})${missing}`);
      }
      lines.push(`shared handle: published (fs guards: ${fsGuards.size})`);
      if (config.httpProxy.enabled) {
        const allowedHosts = config.allowedHosts ? config.allowedHosts.join(", ") || "(deny all)" : "(allow all hosts)";
        lines.push(`http proxy: enabled; allowedHosts ${allowedHosts}`);
        if (state.secrets.length === 0) {
          lines.push("credentials: none discovered in host environment");
        } else {
          lines.push(`credentials (${state.secrets.length}):`);
          for (const secret of state.secrets) {
            lines.push(`  ${secret.name} (${secret.envVar}) \u2192 ${secret.hosts.join(", ")}`);
          }
        }
        lines.push(`env passthrough: ${config.envPassthrough.join(", ") || "(none)"}`);
      } else {
        lines.push("http proxy: disabled (no stubs; guest network is unmediated)");
      }
      ctx.ui.notify(lines.join("\n"), state.error ? "warning" : "info");
    }
  });
}
export {
  gondolinExtension as default
};
