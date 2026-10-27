import { createRequire as __createRequire } from 'node:module';const require = __createRequire(import.meta.url);

// extensions/gondolin/durable.ts
import { posix } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";
import {
  err,
  ExecutionError,
  FileError,
  LineScanner,
  ok
} from "@earendil-works/pi-durable/env";

// extensions/gondolin/src/ops.ts
import path from "node:path";

// extensions/gondolin/src/secrets.ts
import { randomBytes } from "node:crypto";

// extensions/gondolin/src/ops.ts
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

// extensions/gondolin/durable.ts
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function toFileError(error, path2) {
  const errno = error?.code ?? error?.errno;
  const message = messageOf(error);
  const text = `${errno ?? ""} ${message}`;
  let code = "unknown";
  if (/ENOENT|not found|no such file/i.test(text)) code = "not_found";
  else if (/EACCES|EPERM|EROFS|permission|read-only/i.test(text)) code = "permission_denied";
  else if (/ENOTDIR/i.test(text)) code = "not_directory";
  else if (/EISDIR/i.test(text)) code = "is_directory";
  else if (/ENOTSUP|ENOSYS|not supported/i.test(text)) code = "not_supported";
  else if (/EINVAL/i.test(text)) code = "invalid";
  else if (/aborted|AbortError/i.test(text)) code = "aborted";
  return new FileError(code, message, path2);
}
async function attempt(fn, path2) {
  try {
    return ok(await fn());
  } catch (error) {
    return err(toFileError(error, path2));
  }
}
function abortedError() {
  return new FileError("aborted", "operation aborted");
}
var GondolinExecutionEnv = class {
  constructor(vm, cwd, options = {}) {
    this.vm = vm;
    this.cwd = cwd;
    this.id = options.id ?? `gondolin:${vm.id}`;
  }
  vm;
  cwd;
  id;
  resolve(path2) {
    return posix.isAbsolute(path2) ? posix.normalize(path2) : posix.normalize(posix.join(this.cwd, path2));
  }
  signalOf(context) {
    return context.abortSignal;
  }
  async absolutePath(path2, _context) {
    return ok(this.resolve(path2));
  }
  async joinPath(parts, _context) {
    return ok(posix.join(...parts));
  }
  async canonicalPath(path2, _context) {
    return ok(this.resolve(path2));
  }
  async readTextFile(path2, context) {
    return attempt(() => this.vm.fs.readFile(this.resolve(path2), { encoding: "utf8", signal: this.signalOf(context) }), path2);
  }
  async readBinaryFile(path2, context) {
    const result = await attempt(() => this.vm.fs.readFile(this.resolve(path2), { encoding: null, signal: this.signalOf(context) }), path2);
    if (!result.ok) return result;
    return ok(new Uint8Array(result.value.buffer, result.value.byteOffset, result.value.byteLength));
  }
  async readTextLines(path2, options, context) {
    const result = await this.readTextFile(path2, context);
    if (!result.ok) return result;
    const lines = result.value.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return ok(options?.maxLines === void 0 ? lines : lines.slice(0, options.maxLines));
  }
  async openTextLineReader(path2, context) {
    const result = await this.readTextFile(path2, context);
    if (!result.ok) return result;
    const rawLines = result.value.split(/(?<=\n)/);
    let index = 0;
    return ok({
      readLine: async () => {
        if (index >= rawLines.length) return ok(void 0);
        const raw = rawLines[index++];
        const terminated = raw.endsWith("\n");
        return ok({ text: terminated ? raw.slice(0, -1) : raw, terminated });
      },
      close: async () => {
      }
    });
  }
  async openBinaryReader(path2, _options, context) {
    const resolved = this.resolve(path2);
    const statResult = await attempt(() => this.vm.fs.stat(resolved, { signal: this.signalOf(context) }), path2);
    if (!statResult.ok) return statResult;
    if (statResult.value.isDirectory()) return err(new FileError("is_directory", `${path2} is a directory`, path2));
    if (!statResult.value.isFile()) return err(new FileError("invalid", `${path2} is not a regular file`, path2));
    const bytes = await this.readBinaryFile(path2, context);
    if (!bytes.ok) return bytes;
    const info = {
      name: posix.basename(resolved),
      path: resolved,
      kind: "file",
      size: statResult.value.size,
      mtimeMs: statResult.value.mtimeMs
    };
    const data = bytes.value;
    return ok({
      info: async () => ok(info),
      read: async (offset, length, readContext) => {
        if (readContext.abortSignal?.aborted) return err(abortedError());
        return ok(data.subarray(offset, offset + length));
      },
      scanLines: async (scanOptions, scanContext) => {
        if (scanContext.abortSignal?.aborted) return err(abortedError());
        const scanner = new LineScanner(scanOptions.startLine, scanOptions.endLine);
        scanner.push(data);
        return ok(scanner.finish());
      },
      close: async () => {
      }
    });
  }
  async writeFile(path2, content, context) {
    return attempt(
      () => this.vm.fs.writeFile(this.resolve(path2), typeof content === "string" ? content : Buffer.from(content), { signal: this.signalOf(context) }),
      path2
    );
  }
  async appendFile(path2, content, context) {
    const existing = await this.readBinaryFile(path2, context);
    let prior;
    if (existing.ok) {
      prior = existing.value;
    } else if (existing.error.code === "not_found") {
      prior = new Uint8Array(0);
    } else {
      return existing;
    }
    const addition = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const combined = new Uint8Array(prior.length + addition.length);
    combined.set(prior, 0);
    combined.set(addition, prior.length);
    return this.writeFile(path2, combined, context);
  }
  async truncateFile(path2, size, context) {
    const existing = await this.readBinaryFile(path2, context);
    if (!existing.ok) return existing;
    const resized = new Uint8Array(size);
    resized.set(existing.value.subarray(0, size));
    return this.writeFile(path2, resized, context);
  }
  async flushFile(_path, _context) {
    return ok(void 0);
  }
  async renameFile(sourcePath, destinationPath, context) {
    return attempt(() => this.vm.fs.rename(this.resolve(sourcePath), this.resolve(destinationPath), { signal: this.signalOf(context) }), sourcePath);
  }
  fileInfoOf(resolved, stat) {
    let kind = "file";
    if (stat.isDirectory()) kind = "directory";
    else if (stat.isSymbolicLink()) kind = "symlink";
    else if (!stat.isFile()) kind = "file";
    return {
      name: posix.basename(resolved),
      path: resolved,
      kind,
      size: stat.size,
      mtimeMs: stat.mtimeMs
    };
  }
  async fileInfo(path2, context) {
    const resolved = this.resolve(path2);
    const result = await attempt(() => this.vm.fs.stat(resolved, { signal: this.signalOf(context) }), path2);
    if (!result.ok) return result;
    return ok(this.fileInfoOf(resolved, result.value));
  }
  async listDir(path2, context) {
    const resolved = this.resolve(path2);
    const names = await attempt(() => this.vm.fs.listDir(resolved, { signal: this.signalOf(context) }), path2);
    if (!names.ok) return names;
    const entries = [];
    for (const name of names.value) {
      const childPath = posix.join(resolved, name);
      const stat = await attempt(() => this.vm.fs.stat(childPath, { signal: this.signalOf(context) }), childPath);
      if (!stat.ok) continue;
      entries.push(this.fileInfoOf(childPath, stat.value));
    }
    return ok(entries);
  }
  async openDirReader(path2, context) {
    const listing = await this.listDir(path2, context);
    if (!listing.ok) return listing;
    const entries = listing.value;
    let offset = 0;
    return ok({
      next: async (maxEntries, nextContext) => {
        if (nextContext.abortSignal?.aborted) return err(abortedError());
        const page = entries.slice(offset, offset + maxEntries);
        offset += page.length;
        return ok({ entries: page, done: offset >= entries.length });
      },
      close: async () => {
      }
    });
  }
  async watch(_targets, _onChange, _context) {
    return err(new FileError("not_supported", "GondolinExecutionEnv does not watch files; watch the host mounts instead"));
  }
  async exists(path2, context) {
    try {
      await this.vm.fs.access(this.resolve(path2), { signal: this.signalOf(context) });
      return ok(true);
    } catch (error) {
      const fileError = toFileError(error, path2);
      if (fileError.code === "not_found" || fileError.code === "permission_denied") return ok(false);
      return err(fileError);
    }
  }
  async createDir(path2, options, context) {
    return attempt(() => this.vm.fs.mkdir(this.resolve(path2), { recursive: options?.recursive ?? false, signal: this.signalOf(context) }), path2);
  }
  async remove(path2, options, context) {
    return attempt(
      () => this.vm.fs.deleteFile(this.resolve(path2), { recursive: options?.recursive ?? false, force: options?.force ?? false, signal: this.signalOf(context) }),
      path2
    );
  }
  async createTempDir(prefix, context) {
    const path2 = posix.join("/tmp", `${prefix ?? "pi-gondolin-"}${crypto.randomUUID()}`);
    const result = await this.createDir(path2, { recursive: true }, context);
    return result.ok ? ok(path2) : result;
  }
  async createTempFile(options, context) {
    const path2 = posix.join("/tmp", `${options?.prefix ?? "pi-gondolin-"}${crypto.randomUUID()}${options?.suffix ?? ""}`);
    const result = await this.writeFile(path2, new Uint8Array(0), context);
    return result.ok ? ok(path2) : result;
  }
  async exec(command, options, context) {
    const timeout = options?.timeout;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    context.abortSignal?.addEventListener("abort", onAbort, { once: true });
    const timer = timeout === void 0 ? void 0 : setTimeout(() => controller.abort(), timeout);
    const spill = options?.spill;
    let buffered = "";
    let bufferedBytes = 0;
    let bufferedLines = 0;
    try {
      const proc = this.vm.exec(command, {
        cwd: options?.cwd ?? this.cwd,
        env: options?.env,
        stdout: "pipe",
        stderr: "pipe",
        signal: controller.signal
      });
      const reader = (async () => {
        for await (const chunk of proc.output()) {
          options?.onOutput?.(chunk.text, context, { stream: chunk.stream });
          if (spill) {
            buffered += chunk.text;
            bufferedBytes += chunk.text.length;
            bufferedLines += (chunk.text.match(/\n/g) ?? []).length;
          }
        }
      })();
      const [result] = await Promise.all([proc.result, reader]);
      let spillPath;
      if (spill && (bufferedBytes > spill.afterBytes || bufferedLines > spill.afterLines)) {
        const temp = await this.createTempFile({ prefix: "pi-gondolin-spill-" }, context);
        if (temp.ok) {
          const written = await this.writeFile(temp.value, buffered, context);
          if (written.ok) spillPath = temp.value;
        }
      }
      return ok({ exitCode: result.exitCode, ...spillPath === void 0 ? {} : { spillPath } });
    } catch (error) {
      let code = "unknown";
      if (controller.signal.aborted) {
        code = timer !== void 0 && !context.abortSignal?.aborted ? "timeout" : "aborted";
      }
      return err(new ExecutionError(code, messageOf(error), error instanceof Error ? error : void 0));
    } finally {
      if (timer) clearTimeout(timer);
      context.abortSignal?.removeEventListener("abort", onAbort);
    }
  }
  async cleanup(_context) {
  }
};
function createGondolinDurableExtension(config, localCwd) {
  return defineExtension({
    name: "gondolin",
    sections: [
      section("gondolin", () => {
        if (!config.enabled) return void 0;
        return buildSandboxPromptAddendum(config, localCwd).trim();
      })
    ]
  });
}
var durable_default = createGondolinDurableExtension;
export {
  GondolinExecutionEnv,
  createGondolinDurableExtension,
  durable_default as default
};
