// env-relay/src/protocol.ts
var RELAY_PROTOCOL_VERSION = 1;

// env-relay/src/relay-env.ts
import {
  err as err2,
  FileError as FileError2,
  ok as ok2
} from "@earendil-works/pi-durable/env";

// env-relay/src/serialize.ts
import { err, ok, ExecutionError, FileError } from "@earendil-works/pi-durable/env";
var BINARY_TAG = "$relay.binary";
function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function encodeValue(value) {
  if (value instanceof Uint8Array) return { [BINARY_TAG]: toBase64(value) };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = encodeValue(item);
    return out;
  }
  return value;
}
function decodeValue(value) {
  return decodeUnknown(value);
}
function decodeUnknown(value) {
  if (Array.isArray(value)) return value.map(decodeUnknown);
  if (value !== null && typeof value === "object") {
    const record = value;
    if (typeof record[BINARY_TAG] === "string" && Object.keys(record).length === 1) return fromBase64(record[BINARY_TAG]);
    const out = {};
    for (const [key, item] of Object.entries(record)) out[key] = decodeUnknown(item);
    return out;
  }
  return value;
}
function deserializeError(serialized) {
  if (serialized.kind === "file") return new FileError(serialized.code, serialized.message, serialized.path);
  if (serialized.kind === "exec") {
    const error = new ExecutionError(serialized.code, serialized.message);
    if (serialized.spillPath !== void 0) error.spillPath = serialized.spillPath;
    return error;
  }
  return new Error(serialized.message);
}
function decodeResult(response) {
  if (response.ok) return ok(decodeValue(response.value));
  return err(deserializeError(response.error ?? { kind: "other", code: "unknown", message: "missing error" }));
}

// env-relay/src/transport.ts
function createLinkedTransports() {
  const ends = [
    { onMessage: void 0, onClose: void 0, closed: false },
    { onMessage: void 0, onClose: void 0, closed: false }
  ];
  const make = (self, peer) => {
    const mine = ends[self];
    const theirs = ends[peer];
    return {
      get onMessage() {
        return mine.onMessage;
      },
      set onMessage(listener) {
        mine.onMessage = listener;
      },
      get onClose() {
        return mine.onClose;
      },
      set onClose(listener) {
        mine.onClose = listener;
      },
      send(frame) {
        if (mine.closed || theirs.closed) throw new RelayConnectionError("transport is closed");
        const copy = JSON.parse(JSON.stringify(frame));
        queueMicrotask(() => theirs.onMessage?.(copy));
      },
      close() {
        if (mine.closed) return;
        mine.closed = true;
        queueMicrotask(() => theirs.onClose?.("peer closed"));
      }
    };
  };
  return [make(0, 1), make(1, 0)];
}
var RelayConnectionError = class extends Error {
  /** False for handshake rejections (auth, protocol, env-id mismatch): reconnecting will not help. */
  retryable;
  constructor(message, options) {
    super(message, options);
    this.name = "RelayConnectionError";
    this.retryable = options?.retryable ?? true;
  }
};

// env-relay/src/relay-env.ts
var NOT_WATCHING = err2(
  new FileError2("not_supported", "env relay v1 does not carry file watching; watch through the server's environment directly")
);
var RelayedExecutionEnv = class {
  id;
  cwd;
  options;
  connection;
  connecting;
  constructor(options) {
    this.options = options;
    this.id = options.id;
    this.cwd = options.cwd;
  }
  // ── Connection management ────────────────────────────────────────────────
  async ensureConnected() {
    if (this.connection) return this.connection;
    this.connecting ??= this.handshake().finally(() => {
      this.connecting = void 0;
    });
    return this.connecting;
  }
  async handshake() {
    const transport = await this.options.connect();
    const connection = { transport, nextRequestId: 1, pending: /* @__PURE__ */ new Map(), handles: /* @__PURE__ */ new Map(), nextHandleId: 1 };
    const hello = await new Promise((resolve, reject) => {
      transport.onMessage = (frame) => resolve(frame);
      transport.onClose = (reason) => reject(new RelayConnectionError(`relay closed during handshake: ${reason}`));
      transport.send({
        type: "hello",
        protocol: RELAY_PROTOCOL_VERSION,
        ...this.options.token === void 0 ? {} : { token: this.options.token }
      });
    });
    if (hello.type !== "hello" || hello.protocol !== RELAY_PROTOCOL_VERSION) {
      transport.close();
      throw new RelayConnectionError("relay handshake failed: unexpected reply", { retryable: false });
    }
    if (hello.error !== void 0) {
      transport.close();
      throw new RelayConnectionError(`relay handshake rejected: ${hello.error}`, { retryable: false });
    }
    if (hello.envId !== void 0 && hello.envId !== this.id) {
      transport.close();
      throw new RelayConnectionError(`relay env id mismatch: expected ${this.id}, server reported ${hello.envId}`, { retryable: false });
    }
    transport.onMessage = (frame) => this.dispatch(connection, frame);
    transport.onClose = (reason) => this.drop(connection, new RelayConnectionError(`relay connection closed: ${reason}`));
    this.connection = connection;
    return connection;
  }
  dispatch(connection, frame) {
    if (frame.type === "res") {
      const pending = connection.pending.get(frame.id);
      if (!pending) return;
      connection.pending.delete(frame.id);
      pending.resolve(frame);
    } else if (frame.type === "exec-output") {
      const pending = connection.pending.get(frame.id);
      if (!pending) return;
      pending.touched = true;
      pending.onExecOutput?.(frame.stream, frame.text);
    }
  }
  drop(connection, error) {
    if (this.connection === connection) this.connection = void 0;
    for (const pending of connection.pending.values()) pending.reject(error);
    connection.pending.clear();
  }
  /** One RPC. `pure` calls are retried once over a fresh connection after a pre-answer drop. */
  async call(op, args, context, options) {
    let retried = false;
    for (; ; ) {
      let connection;
      try {
        connection = await this.ensureConnected();
      } catch (error) {
        if (options.pure && !retried && error instanceof RelayConnectionError && error.retryable) {
          retried = true;
          continue;
        }
        throw error;
      }
      const id = connection.nextRequestId++;
      const response = await new Promise((resolve, reject) => {
        const pending = { resolve, reject, touched: false, ...options.onExecOutput ? { onExecOutput: options.onExecOutput } : {} };
        connection.pending.set(id, pending);
        const onAbort = () => {
          connection.pending.delete(id);
          try {
            connection.transport.send({ type: "cancel", id });
          } catch {
          }
          const errorKind = options.errorKind ?? "file";
          resolve({
            type: "res",
            id,
            ok: false,
            error: { kind: errorKind, code: "aborted", message: "operation aborted" }
          });
        };
        if (context.abortSignal?.aborted) {
          onAbort();
          return;
        }
        context.abortSignal?.addEventListener("abort", onAbort, { once: true });
        try {
          connection.transport.send({ type: "req", id, op, args: args.map(encodeValue) });
        } catch (error) {
          connection.pending.delete(id);
          reject(error instanceof Error ? error : new RelayConnectionError(String(error)));
        }
        const cleanup = () => context.abortSignal?.removeEventListener("abort", onAbort);
        const wrappedResolve = pending.resolve;
        pending.resolve = (value) => {
          cleanup();
          wrappedResolve(value);
        };
        const wrappedReject = pending.reject;
        pending.reject = (error) => {
          cleanup();
          wrappedReject(error);
        };
      }).catch((error) => {
        if (options.pure && !retried && error instanceof RelayConnectionError) return void 0;
        throw error;
      });
      if (response === void 0) {
        retried = true;
        continue;
      }
      return decodeResult(response);
    }
  }
  // ── FileSystem ───────────────────────────────────────────────────────────
  absolutePath(path, context) {
    return this.call("absolutePath", [path], context, { pure: true });
  }
  joinPath(parts, context) {
    return this.call("joinPath", [parts], context, { pure: true });
  }
  canonicalPath(path, context) {
    return this.call("canonicalPath", [path], context, { pure: true });
  }
  readTextFile(path, context) {
    return this.call("readTextFile", [path], context, { pure: true });
  }
  readTextLines(path, options, context) {
    return this.call("readTextLines", [path, options], context, { pure: true });
  }
  readBinaryFile(path, context) {
    return this.call("readBinaryFile", [path], context, { pure: true });
  }
  writeFile(path, content, context) {
    return this.call("writeFile", [path, content], context, { pure: false });
  }
  appendFile(path, content, context) {
    return this.call("appendFile", [path, content], context, { pure: false });
  }
  truncateFile(path, size, context) {
    return this.call("truncateFile", [path, size], context, { pure: false });
  }
  flushFile(path, context) {
    return this.call("flushFile", [path], context, { pure: false });
  }
  renameFile(sourcePath, destinationPath, context) {
    return this.call("renameFile", [sourcePath, destinationPath], context, { pure: false });
  }
  fileInfo(path, context) {
    return this.call("fileInfo", [path], context, { pure: true });
  }
  listDir(path, context) {
    return this.call("listDir", [path], context, { pure: true });
  }
  async listFiles(path, options, context) {
    return this.call("listFiles", [path, options], context, { pure: true });
  }
  exists(path, context) {
    return this.call("exists", [path], context, { pure: true });
  }
  createDir(path, options, context) {
    return this.call("createDir", [path, options], context, { pure: false });
  }
  remove(path, options, context) {
    return this.call("remove", [path, options], context, { pure: false });
  }
  createTempDir(prefix, context) {
    return this.call("createTempDir", [prefix], context, { pure: false });
  }
  createTempFile(options, context) {
    return this.call("createTempFile", [options], context, { pure: false });
  }
  watch(_targets, _onChange, _context) {
    return Promise.resolve(NOT_WATCHING);
  }
  // ── Handle-based readers ─────────────────────────────────────────────────
  async openHandle(op, args, context) {
    return this.call(op, args, context, { pure: false });
  }
  remoteReader(handleResult, methods, closeOp, context) {
    if (!handleResult.ok) return handleResult;
    const handle = handleResult.value.handle;
    const api = methods(handle);
    return ok2({
      ...api,
      close: async (closeContext) => {
        await this.call(closeOp, [handle], closeContext ?? context, { pure: true });
      }
    });
  }
  async openBinaryReader(path, options, context) {
    const handle = await this.openHandle("openBinaryReader", [path, options], context);
    return this.remoteReader(
      handle,
      (h) => ({
        info: (ctx) => this.call("binaryReader.info", [h], ctx, { pure: true }),
        read: (offset, length, ctx) => this.call("binaryReader.read", [h, offset, length], ctx, { pure: true }),
        scanLines: (scanOptions, ctx) => this.call("binaryReader.scanLines", [h, scanOptions], ctx, { pure: true })
      }),
      "binaryReader.close",
      context
    );
  }
  async openTextLineReader(path, context) {
    const handle = await this.openHandle("openTextLineReader", [path], context);
    return this.remoteReader(
      handle,
      (h) => ({
        readLine: (ctx) => this.call("textLineReader.readLine", [h], ctx, { pure: true })
      }),
      "textLineReader.close",
      context
    );
  }
  async openDirReader(path, context) {
    const handle = await this.openHandle("openDirReader", [path], context);
    return this.remoteReader(
      handle,
      (h) => ({
        next: (maxEntries, ctx) => this.call("dirReader.next", [h, maxEntries], ctx, { pure: true })
      }),
      "dirReader.close",
      context
    );
  }
  // ── Shell ────────────────────────────────────────────────────────────────
  async exec(command, options, context) {
    const wireOptions = options === void 0 ? void 0 : { ...options, onOutput: void 0 };
    const result = await this.call(
      "exec",
      [typeof command === "string" ? command : [...command], wireOptions],
      context,
      {
        pure: false,
        errorKind: "exec",
        ...options?.onOutput ? {
          onExecOutput: (stream, text) => {
            options.onOutput?.(text, context, { stream });
          }
        } : {}
      }
    );
    return result;
  }
  async cleanup(context) {
    const connection = this.connection;
    if (!connection) return;
    this.connection = void 0;
    try {
      await this.call("cleanup", [], context, { pure: false });
    } catch {
    }
    connection.transport.close();
  }
};

// env-relay/src/fallback.ts
import {
  FileError as FileError3
} from "@earendil-works/pi-durable/env";
function isConnectionFailure(error) {
  return error instanceof RelayConnectionError;
}
var FallbackExecutionEnv = class {
  options;
  backend = "primary";
  failures = 0;
  openedAt = 0;
  constructor(options) {
    this.options = options;
  }
  get id() {
    return this.active().id;
  }
  get cwd() {
    return this.active().cwd;
  }
  /** Which backend currently serves operations. */
  get activeBackend() {
    return this.backend;
  }
  active() {
    return this.backend === "primary" ? this.options.primary : this.options.fallback;
  }
  noteFailure(error) {
    if (!isConnectionFailure(error)) return;
    this.failures += 1;
    const threshold = this.options.failureThreshold ?? 1;
    if (this.backend === "primary" && this.failures >= threshold) {
      this.backend = "fallback";
      this.openedAt = Date.now();
      this.options.onSwitch?.("fallback", error);
    }
  }
  noteSuccess() {
    this.failures = 0;
    if (this.backend === "fallback") {
      this.backend = "primary";
      this.options.onSwitch?.("primary", void 0);
    }
  }
  /** Half-open: after the probe interval, try the primary for one operation. */
  pick() {
    if (this.backend === "fallback" && Date.now() - this.openedAt >= (this.options.probeIntervalMs ?? 3e4)) {
      return this.options.primary;
    }
    return this.active();
  }
  /** Run a pure read, retrying once on the fallback after a connection failure. */
  async read(op) {
    const first = this.pick();
    let result;
    try {
      result = await op(first);
    } catch (error) {
      this.noteFailure(error);
      if (!isConnectionFailure(error) || first !== this.options.primary) throw error;
      const second = await op(this.options.fallback);
      return second;
    }
    if (first === this.options.primary && result.ok) this.noteSuccess();
    if (!result.ok && first === this.options.primary && result.error.message.includes("relay")) {
      return op(this.options.fallback);
    }
    return result;
  }
  /** Run a mutating op or exec: fail over the circuit, never replay. */
  async write(op) {
    const target = this.pick();
    try {
      const result = await op(target);
      if (target === this.options.primary && result.ok) this.noteSuccess();
      return result;
    } catch (error) {
      this.noteFailure(error);
      throw error;
    }
  }
  // ── FileSystem ───────────────────────────────────────────────────────────
  absolutePath(path, context) {
    return this.read((env) => env.absolutePath(path, context));
  }
  joinPath(parts, context) {
    return this.read((env) => env.joinPath(parts, context));
  }
  canonicalPath(path, context) {
    return this.read((env) => env.canonicalPath(path, context));
  }
  readTextFile(path, context) {
    return this.read((env) => env.readTextFile(path, context));
  }
  readTextLines(path, options, context) {
    return this.read((env) => env.readTextLines(path, options, context));
  }
  readBinaryFile(path, context) {
    return this.read((env) => env.readBinaryFile(path, context));
  }
  fileInfo(path, context) {
    return this.read((env) => env.fileInfo(path, context));
  }
  listDir(path, context) {
    return this.read((env) => env.listDir(path, context));
  }
  listFiles(path, options, context) {
    return this.read((env) => {
      if (typeof env.listFiles !== "function") {
        return Promise.resolve({ ok: false, error: new FileError3("not_supported", "environment does not implement listFiles") });
      }
      return env.listFiles(path, options, context);
    });
  }
  exists(path, context) {
    return this.read((env) => env.exists(path, context));
  }
  openBinaryReader(path, options, context) {
    return this.read((env) => env.openBinaryReader(path, options, context));
  }
  openTextLineReader(path, context) {
    return this.read((env) => env.openTextLineReader(path, context));
  }
  openDirReader(path, context) {
    return this.read((env) => env.openDirReader(path, context));
  }
  watch(targets, onChange, context) {
    return this.read((env) => env.watch(targets, onChange, context));
  }
  writeFile(path, content, context) {
    return this.write((env) => env.writeFile(path, content, context));
  }
  appendFile(path, content, context) {
    return this.write((env) => env.appendFile(path, content, context));
  }
  truncateFile(path, size, context) {
    return this.write((env) => env.truncateFile(path, size, context));
  }
  flushFile(path, context) {
    return this.write((env) => env.flushFile(path, context));
  }
  renameFile(sourcePath, destinationPath, context) {
    return this.write((env) => env.renameFile(sourcePath, destinationPath, context));
  }
  createDir(path, options, context) {
    return this.write((env) => env.createDir(path, options, context));
  }
  remove(path, options, context) {
    return this.write((env) => env.remove(path, options, context));
  }
  createTempDir(prefix, context) {
    return this.write((env) => env.createTempDir(prefix, context));
  }
  createTempFile(options, context) {
    return this.write((env) => env.createTempFile(options, context));
  }
  exec(command, options, context) {
    return this.write((env) => env.exec(command, options, context));
  }
  async cleanup(context) {
    await this.options.primary.cleanup(context).catch(() => {
    });
    await this.options.fallback.cleanup(context).catch(() => {
    });
  }
};

// env-relay/src/websocket.ts
function webSocketTransport(socket) {
  const transport = {
    onMessage: void 0,
    onClose: void 0,
    send(frame) {
      if (socket.readyState !== 1) throw new RelayConnectionError("websocket is not open");
      socket.send(JSON.stringify(frame));
    },
    close() {
      socket.close(1e3, "env relay done");
    }
  };
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    transport.onMessage?.(JSON.parse(event.data));
  });
  socket.addEventListener("close", (event) => {
    transport.onClose?.(event.reason ?? "websocket closed");
  });
  socket.addEventListener("error", () => {
    transport.onClose?.("websocket error");
  });
  return transport;
}
function connectWebSocketRelay(url, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new RelayConnectionError(`websocket connect to ${url} timed out`));
    }, options.timeoutMs ?? 1e4);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(webSocketTransport(socket));
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new RelayConnectionError(`websocket connect to ${url} failed`));
    });
  });
}
export {
  FallbackExecutionEnv,
  RELAY_PROTOCOL_VERSION,
  RelayConnectionError,
  RelayedExecutionEnv,
  connectWebSocketRelay,
  createLinkedTransports,
  webSocketTransport
};
