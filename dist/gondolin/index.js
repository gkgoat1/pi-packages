const __filename = 'nope';import { createRequire as __createRequire } from 'node:module';const require = __createRequire(import.meta.url);

// extensions/gondolin/index.ts
import path2 from "node:path";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool
} from "@earendil-works/pi-coding-agent";
import { RealFSProvider, VM, createHttpHooks } from "@earendil-works/gondolin";

// extensions/gondolin/src/config.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  }
};
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
  if (!hosts || hosts.length === 0) return void 0;
  const spec = { hosts };
  if (typeof object.envVar === "string" && object.envVar) spec.envVar = object.envVar;
  return spec;
}
function parseHttpProxy(value) {
  const object = asObject(value);
  if (!object) return void 0;
  const secrets = {};
  const secretMap = asObject(object.secrets);
  if (secretMap) {
    for (const [name, raw] of Object.entries(secretMap)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      const spec = parseSecretSpec(raw);
      if (spec) secrets[name] = spec;
    }
  }
  return {
    enabled: typeof object.enabled === "boolean" ? object.enabled : true,
    discoverKnownSecrets: typeof object.discoverKnownSecrets === "boolean" ? object.discoverKnownSecrets : true,
    secrets
  };
}
function parseConfig(value) {
  const root = asObject(value);
  if (!root || root.enabled !== true) return { ...DEFAULTS, httpProxy: { ...DEFAULTS.httpProxy, secrets: {} } };
  const httpProxy = parseHttpProxy(root.httpProxy) ?? {
    enabled: true,
    discoverKnownSecrets: true,
    secrets: {}
  };
  const config = {
    enabled: true,
    accel: typeof root.accel === "string" && root.accel ? root.accel : DEFAULTS.accel,
    guestWorkspace: typeof root.guestWorkspace === "string" && root.guestWorkspace ? root.guestWorkspace : DEFAULTS.guestWorkspace,
    envPassthrough: asStringArray(root.envPassthrough) ?? DEFAULTS.envPassthrough,
    httpProxy
  };
  if (typeof root.memory === "string" && root.memory) config.memory = root.memory;
  if (Number.isInteger(root.cpus) && root.cpus > 0) config.cpus = root.cpus;
  if (typeof root.image === "string" && root.image) config.image = root.image;
  if (Number.isInteger(root.startTimeoutMs) && root.startTimeoutMs >= 0) {
    config.startTimeoutMs = root.startTimeoutMs;
  }
  const allowedHosts = asStringArray(root.allowedHosts);
  if (allowedHosts) config.allowedHosts = allowedHosts;
  return config;
}
function readConfigFile(path3) {
  if (!existsSync(path3)) return { ...DEFAULTS, httpProxy: { ...DEFAULTS.httpProxy, secrets: {} } };
  try {
    return parseConfig(JSON.parse(readFileSync(path3, "utf8")));
  } catch {
    return { ...DEFAULTS, httpProxy: { ...DEFAULTS.httpProxy, secrets: {} } };
  }
}
function mergeSecrets(base, next) {
  return { ...base, ...next };
}
function mergeConfig(base, next) {
  return {
    enabled: next.enabled ?? base.enabled,
    accel: next.accel ?? base.accel,
    guestWorkspace: next.guestWorkspace ?? base.guestWorkspace,
    memory: next.memory ?? base.memory,
    cpus: next.cpus ?? base.cpus,
    image: next.image ?? base.image,
    startTimeoutMs: next.startTimeoutMs ?? base.startTimeoutMs,
    allowedHosts: next.allowedHosts ?? base.allowedHosts,
    envPassthrough: next.envPassthrough.length > 0 ? next.envPassthrough : base.envPassthrough,
    httpProxy: {
      enabled: next.httpProxy.enabled && base.httpProxy.enabled,
      discoverKnownSecrets: next.httpProxy.discoverKnownSecrets && base.httpProxy.discoverKnownSecrets,
      secrets: mergeSecrets(base.httpProxy.secrets, next.httpProxy.secrets)
    }
  };
}
function parseBool(value) {
  if (value === void 0) return void 0;
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}
function envConfig() {
  let config;
  const encoded = process.env.PI_GONDOLIN_CONFIG;
  if (encoded) {
    try {
      config = parseConfig(JSON.parse(encoded));
    } catch {
      config = void 0;
    }
  }
  const enabled = parseBool(process.env.PI_GONDOLIN_ENABLED);
  if (enabled !== void 0 && config) config.enabled = enabled;
  else if (enabled !== void 0) {
    config = { ...DEFAULTS, httpProxy: { ...DEFAULTS.httpProxy, secrets: {} }, enabled };
  }
  return config ?? { ...DEFAULTS, httpProxy: { ...DEFAULTS.httpProxy, secrets: {} } };
}
function loadConfig(ctx) {
  const globalConfig = readConfigFile(join(homedir(), ".pi", "agent", "gondolin.json"));
  const projectConfig = ctx.isProjectTrusted() ? readConfigFile(join(ctx.cwd, CONFIG_DIR_NAME, "gondolin.json")) : { ...DEFAULTS, httpProxy: { ...DEFAULTS.httpProxy, secrets: {} } };
  return mergeConfig(mergeConfig(globalConfig, projectConfig), envConfig());
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

// extensions/gondolin/index.ts
function gondolinExtension(pi) {
  const localCwd = process.cwd();
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);
  let config = loadConfig({ cwd: localCwd, isProjectTrusted: () => false });
  const state = { vm: null, starting: null, error: void 0, secrets: [] };
  const trustedRef = { value: false };
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
          mounts: {
            [guestWorkspace]: new RealFSProvider(localCwd)
          }
        },
        sessionLabel: `pi-gondolin:${path2.basename(localCwd)}`
      });
      state.vm = created;
      state.error = void 0;
      const stubCount = state.secrets.length;
      const proxyNote = config.httpProxy.enabled ? `; ${stubCount} credential${stubCount === 1 ? "" : "s"} stubbed (real values stay host-side)` : "";
      ctx?.ui.notify(`Gondolin VM ready \u2014 host ${localCwd} mounted at ${guestWorkspace}${proxyNote}`, "info");
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
    const extra = [
      "",
      "## Gondolin sandbox",
      `- You are running inside a micro-VM; host ${localCwd} is mounted read-write at ${config.guestWorkspace}.`,
      ...config.httpProxy.enabled ? [
        "- API keys in the environment are sandbox stubs (they start with `gondolin-stub-`). Do not try to exchange or decode them: outbound HTTP requests that use a stub are transparently replaced with the real credential by the sandbox proxy, but only for that credential's allowed hosts.",
        "- Requests carrying any other credential (including real, non-stub keys you obtain from the user) pass through the proxy unmodified."
      ] : []
    ].join("\n");
    return { systemPrompt: `${modified}${extra}` };
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
        `mount: ${localCwd} \u2192 ${config.guestWorkspace}`
      ];
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
