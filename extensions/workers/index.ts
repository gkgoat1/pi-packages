/**
 * Pi Workers — persistent, transcript-backed subagents with strict per-model routing.
 *
 * A routing tag is relative to its caller model: `models[caller].workers[tag]`
 * is the only authority that selects a child model. Models and prompts never
 * supply a target model as a tool argument.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const CONFIG_FILE = "workers.json";
const WORKER_DIR_PREFIX = "pi-workers-";
const CONTROL_POLL_MS = 250;
const MAX_OUTPUT_CHARS = 12_000;
const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_EVENT_BYTES = 64_000;
const GUEST_EVENTS_PROPERTY = "PI_WORKERS_EVENTS";
const GUEST_EVENTS_SYMBOL = Symbol.for("pi.workers.events");
const EXTENSION_INSTANCE_SYMBOL = Symbol.for("pi.workers.extension.active");
const eventWriteQueues = new Map<string, Promise<void>>();

type Delivery = "steer" | "followUp";

type WorkerStatus = "starting" | "running" | "idle" | "error" | "aborted" | "exited";

interface WorkerRoute {
	model: string;
	/** Maximum uses of this caller-model/tag route in one root → worker path. Defaults to 1. */
	maxPerLineage?: number;
}

interface CallerPolicy {
	workers: Record<string, WorkerRoute>;
}

interface WorkersConfig {
	maxDepth: number;
	maxWorkers: number;
	/** Every key is an exact caller provider/model and owns its own tag namespace. */
	models: Record<string, CallerPolicy>;
}

interface WorkerRecord {
	id: string;
	parentId: string | null;
	depth: number;
	model: string;
	tag: string;
	callerModel: string;
	/** `callerModel#tag` entries, rather than global tag names. */
	lineageRoutes: string[];
	status: WorkerStatus;
	createdAt: string;
	updatedAt: string;
	sessionFile?: string;
	lastOutput?: string;
	error?: string;
	pid?: number;
}

interface ControlMessage {
	id: string;
	type: "prompt" | "abort";
	message?: string;
	delivery?: Delivery;
}

interface WorkerEvent {
	seq: number;
	timestamp: string;
	workerId: string;
	kind: "pi" | "guest" | "lifecycle";
	type: string;
	data: unknown;
}

const SpawnParams = Type.Object({
	tag: Type.String({ description: "Routing tag defined under the active caller model in .pi/workers.json. It exclusively selects the worker model." }),
	task: Type.String({ description: "Initial task for the worker" }),
	name: Type.Optional(Type.String({ description: "Optional human label included in the task" })),
	wait: Type.Optional(Type.Boolean({ description: "Wait until the worker becomes idle before returning (default false)" })),
});

const WorkerIdParams = Type.Object({
	workerId: Type.String({ description: "Worker id returned by workers_spawn, or 'all'" }),
});

const QueryParams = Type.Object({
	workerId: Type.String({ description: "Worker id returned by workers_spawn, or 'all'" }),
	tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum recent transcript entries per worker (default 20)" })),
});

const ListenParams = Type.Object({
	workerId: Type.String({ description: "Worker id whose event stream to read" }),
	since: Type.Optional(Type.Integer({ minimum: 0, description: "Exclusive event cursor returned as nextCursor; omit or use 0 for retained history" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum events to return (default 25)" })),
});

const SteerParams = Type.Object({
	workerId: Type.String({ description: "Worker id returned by workers_spawn" }),
	message: Type.String({ description: "Instruction for the live worker" }),
	delivery: Type.Optional(StringEnum(["steer", "followUp"] as const, { default: "steer" })),
});

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelKey(model: unknown): string | undefined {
	if (!isObject(model) || typeof model.provider !== "string" || typeof model.id !== "string") return undefined;
	return `${model.provider}/${model.id}`;
}

function validateModelKey(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(value)) {
		throw new Error(`${label} must be an exact provider/model string.`);
	}
	return value;
}

function validateTag(tag: string, label: string): void {
	if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(tag)) throw new Error(`${label} is not a valid tag.`);
}

function parseConfig(value: unknown): WorkersConfig {
	if (!isObject(value)) throw new Error("workers.json must be a JSON object.");
	const { maxDepth, maxWorkers } = value;
	if (!Number.isInteger(maxDepth) || (maxDepth as number) < 1 || (maxDepth as number) > 32) {
		throw new Error("maxDepth must be an integer from 1 to 32.");
	}
	if (!Number.isInteger(maxWorkers) || (maxWorkers as number) < 1 || (maxWorkers as number) > 256) {
		throw new Error("maxWorkers must be an integer from 1 to 256.");
	}
	if (!isObject(value.models) || Object.keys(value.models).length === 0) {
		throw new Error("models must be a non-empty object keyed by exact provider/model strings.");
	}

	const models: Record<string, CallerPolicy> = {};
	for (const [caller, callerPolicy] of Object.entries(value.models)) {
		validateModelKey(caller, `models.${caller}`);
		if (!isObject(callerPolicy) || !isObject(callerPolicy.workers) || Object.keys(callerPolicy.workers).length === 0) {
			throw new Error(`models.${caller}.workers must be a non-empty object.`);
		}
		const workers: Record<string, WorkerRoute> = {};
		for (const [tag, route] of Object.entries(callerPolicy.workers)) {
			validateTag(tag, `models.${caller}.workers.${tag}`);
			if (!isObject(route)) throw new Error(`models.${caller}.workers.${tag} must be an object.`);
			const maxPerLineage = route.maxPerLineage ?? 1;
			if (!Number.isInteger(maxPerLineage) || (maxPerLineage as number) < 1 || (maxPerLineage as number) > 32) {
				throw new Error(`models.${caller}.workers.${tag}.maxPerLineage must be an integer from 1 to 32.`);
			}
			workers[tag] = {
				model: validateModelKey(route.model, `models.${caller}.workers.${tag}.model`),
				maxPerLineage: maxPerLineage as number,
			};
		}
		models[caller] = { workers };
	}
	return { maxDepth: maxDepth as number, maxWorkers: maxWorkers as number, models };
}

async function loadRootConfig(cwd: string): Promise<WorkersConfig> {
	const file = join(cwd, CONFIG_DIR_NAME, CONFIG_FILE);
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		throw new Error(`Workers needs ${file}. See the installed Workers README.`);
	}
	try {
		return parseConfig(JSON.parse(raw));
	} catch (error) {
		throw new Error(`Invalid ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function configFromEnvironment(): WorkersConfig | undefined {
	const encoded = process.env.PI_WORKERS_CONFIG;
	if (!encoded) return undefined;
	try {
		return parseConfig(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
	} catch (error) {
		throw new Error(`Worker received an invalid locked configuration: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function runtimeDirForRoot(): string {
	return join(tmpdir(), `${WORKER_DIR_PREFIX}${randomUUID()}`);
}

function workerFile(runtimeDir: string, workerId: string): string {
	return join(runtimeDir, "workers", `${workerId}.json`);
}
function controlFile(runtimeDir: string, workerId: string): string {
	return join(runtimeDir, "controls", `${workerId}.jsonl`);
}
function eventFile(runtimeDir: string, workerId: string): string {
	return join(runtimeDir, "events", `${workerId}.jsonl`);
}

async function writeRecord(runtimeDir: string, record: WorkerRecord): Promise<void> {
	await mkdir(join(runtimeDir, "workers"), { recursive: true, mode: 0o700 });
	record.updatedAt = new Date().toISOString();
	await writeFile(workerFile(runtimeDir, record.id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

async function readRecord(runtimeDir: string, workerId: string): Promise<WorkerRecord | undefined> {
	try {
		const record = JSON.parse(await readFile(workerFile(runtimeDir, workerId), "utf8")) as WorkerRecord;
		return record && typeof record.id === "string" ? record : undefined;
	} catch {
		return undefined;
	}
}

async function listRecords(runtimeDir: string): Promise<WorkerRecord[]> {
	try {
		const names = await readdir(join(runtimeDir, "workers"));
		const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readRecord(runtimeDir, name.slice(0, -5))));
		return records.filter((record): record is WorkerRecord => Boolean(record)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	} catch {
		return [];
	}
}

function summarize(record: WorkerRecord): string {
	const session = record.sessionFile ? `\nsession: ${record.sessionFile}` : "\nsession: pending";
	const output = record.lastOutput ? `\nlast assistant text:\n${record.lastOutput.slice(-2000)}` : "";
	const error = record.error ? `\nerror: ${record.error}` : "";
	return `${record.id}  ${record.status}  depth=${record.depth}  ${record.model}  tag=${record.tag}  caller=${record.callerModel}${session}${output}${error}`;
}

function finalText(message: unknown): string | undefined {
	if (!isObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const texts = message.content
		.filter((part): part is Record<string, unknown> => isObject(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string);
	return texts.length > 0 ? texts.join("\n") : undefined;
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && existsSync(script) && !script.startsWith("/$bunfs/root/")) return { command: process.execPath, args: [script, ...args] };
	const executable = process.execPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
	return /^(node|bun)(\.exe)?$/.test(executable) ? { command: "pi", args } : { command: process.execPath, args };
}

function safeEventData(value: unknown): unknown {
	try {
		const text = JSON.stringify(value);
		if (text.length <= MAX_EVENT_BYTES) return JSON.parse(text);
		return { truncated: true, preview: text.slice(0, MAX_EVENT_BYTES), originalBytes: Buffer.byteLength(text) };
	} catch (error) {
		return { unserializable: true, preview: String(value), error: error instanceof Error ? error.message : String(error) };
	}
}

async function appendWorkerEvent(runtimeDir: string, workerId: string, kind: WorkerEvent["kind"], type: string, data: unknown): Promise<void> {
	const key = `${runtimeDir}\u0000${workerId}`;
	const previous = eventWriteQueues.get(key) ?? Promise.resolve();
	const operation = previous.catch(() => undefined).then(async () => {
		await mkdir(join(runtimeDir, "events"), { recursive: true, mode: 0o700 });
		let seq = 1;
		try {
			const current = await readFile(eventFile(runtimeDir, workerId), "utf8");
			const last = current.trimEnd().split("\n").at(-1);
			if (last) {
				const event = JSON.parse(last) as Partial<WorkerEvent>;
				if (Number.isInteger(event.seq)) seq = (event.seq as number) + 1;
			}
		} catch { /* first event */ }
		const event: WorkerEvent = { seq, timestamp: new Date().toISOString(), workerId, kind, type, data: safeEventData(data) };
		await appendFile(eventFile(runtimeDir, workerId), `${JSON.stringify(event)}\n`, { mode: 0o600 });
	});
	eventWriteQueues.set(key, operation);
	try {
		await operation;
	} finally {
		if (eventWriteQueues.get(key) === operation) eventWriteQueues.delete(key);
	}
}

async function readWorkerEvents(runtimeDir: string, workerId: string, since = 0, limit = 25): Promise<{ events: WorkerEvent[]; nextCursor: number }> {
	let lines: string[];
	try {
		lines = (await readFile(eventFile(runtimeDir, workerId), "utf8")).split("\n");
	} catch {
		return { events: [], nextCursor: since };
	}
	const all = lines.flatMap((line) => {
		try { return line ? [JSON.parse(line) as WorkerEvent] : []; } catch { return []; }
	});
	const events = all.filter((event) => Number.isInteger(event.seq) && event.seq > since).slice(0, limit);
	return { events, nextCursor: events.at(-1)?.seq ?? since };
}

async function updateWorkerOutput(runtimeDir: string, workerId: string, output?: string, status?: WorkerStatus, error?: string): Promise<void> {
	const record = await readRecord(runtimeDir, workerId);
	if (!record) return;
	if (output) record.lastOutput = output.slice(-MAX_OUTPUT_CHARS);
	if (status) record.status = status;
	if (error) record.error = error.slice(-4000);
	await writeRecord(runtimeDir, record);
}

function transcriptLine(entry: unknown): string {
	if (!isObject(entry)) return JSON.stringify(entry);
	if (entry.type === "session") return `session ${typeof entry.id === "string" ? entry.id : ""}`;
	if (entry.type === "message" && isObject(entry.message)) {
		const message = entry.message;
		const role = typeof message.role === "string" ? message.role : "message";
		if (role === "assistant") {
			const text = finalText(message);
			const calls = Array.isArray(message.content)
				? message.content.filter((part) => isObject(part) && part.type === "toolCall").map((part) => String(part.name)).join(", ")
				: "";
			return `assistant${calls ? ` tool calls: ${calls}` : ""}${text ? `\n${text}` : ""}`;
		}
		if (role === "toolResult") return `toolResult ${String(message.toolName ?? "tool")}${message.isError ? " (error)" : ""}: ${JSON.stringify(message.content).slice(0, 2000)}`;
		return `${role}: ${JSON.stringify(message.content).slice(0, 3000)}`;
	}
	if (entry.type === "custom_message") return `custom message ${String(entry.customType ?? "")} : ${JSON.stringify(entry.content).slice(0, 3000)}`;
	return `${String(entry.type ?? "entry")}: ${JSON.stringify(entry).slice(0, 3000)}`;
}

async function transcriptSummary(record: WorkerRecord, tail: number): Promise<string> {
	if (!record.sessionFile) return "Transcript is not available yet; the worker has not completed session startup.";
	try {
		const lines = (await readFile(record.sessionFile, "utf8")).trim().split("\n").filter(Boolean);
		const entries = lines.flatMap((line) => {
			try { return [JSON.parse(line) as unknown]; } catch { return []; }
		});
		const rendered = entries.slice(-tail).map(transcriptLine).join("\n\n");
		return rendered.length > MAX_TRANSCRIPT_CHARS ? `…[transcript truncated]\n${rendered.slice(-MAX_TRANSCRIPT_CHARS)}` : rendered || "Transcript contains no entries yet.";
	} catch (error) {
		return `Unable to read transcript ${record.sessionFile}: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function startWorkerProcess(cwd: string, runtimeDir: string, config: WorkersConfig, record: WorkerRecord, task: string, extensionPath: string): ChildProcessWithoutNullStreams {
	// Do NOT use --no-extensions or --no-session. A worker has its own persisted
	// Pi transcript and normal project/global extensions, plus this extension.
	const invocation = piInvocation([
		"--mode", "rpc", "--approve", "--model", record.model, "--name", `worker-${record.id}`,
		"--extension", extensionPath,
	]);
	const proc = spawn(invocation.command, invocation.args, {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			PI_WORKERS_RUNTIME_DIR: runtimeDir,
			PI_WORKERS_WORKER_ID: record.id,
			PI_WORKERS_EXTENSION_PATH: extensionPath,
			// Immutable snapshot: editing .pi/workers.json cannot widen a live tree.
			PI_WORKERS_CONFIG: Buffer.from(JSON.stringify(config)).toString("base64url"),
		},
	});
	void appendWorkerEvent(runtimeDir, record.id, "lifecycle", "process_started", { pid: proc.pid, invocation: [invocation.command, ...invocation.args] });
	let buffer = "";
	proc.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			try {
				const event = JSON.parse(line);
				void appendWorkerEvent(runtimeDir, record.id, "pi", typeof event.type === "string" ? event.type : "unknown", event);
				if (event.type === "message_end") {
					const output = finalText(event.message);
					if (output) void updateWorkerOutput(runtimeDir, record.id, output, "running");
				}
				if (event.type === "agent_settled") void updateWorkerOutput(runtimeDir, record.id, undefined, "idle");
			} catch {
				void appendWorkerEvent(runtimeDir, record.id, "lifecycle", "invalid_stdout", line.slice(0, 2000));
			}
		}
	});
	let stderr = "";
	proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
	proc.on("error", (error) => {
		void appendWorkerEvent(runtimeDir, record.id, "lifecycle", "process_error", { message: error.message });
		void updateWorkerOutput(runtimeDir, record.id, undefined, "error", error.message);
	});
	proc.on("exit", (code, signal) => {
		void appendWorkerEvent(runtimeDir, record.id, "lifecycle", "process_exit", { code, signal, stderr: stderr.slice(-4000) });
		void (async () => {
			const current = await readRecord(runtimeDir, record.id);
			if (!current || current.status === "aborted") return;
			await updateWorkerOutput(runtimeDir, record.id, undefined, code === 0 ? "exited" : "error", stderr || `Worker exited (${signal ?? code ?? "unknown"}).`);
		})();
	});
	proc.stdin.write(`${JSON.stringify({ type: "prompt", id: `initial-${record.id}`, message: task })}\n`);
	return proc;
}

async function sendControl(runtimeDir: string, workerId: string, control: Omit<ControlMessage, "id">): Promise<void> {
	if (!(await readRecord(runtimeDir, workerId))) throw new Error(`Unknown worker: ${workerId}`);
	await mkdir(join(runtimeDir, "controls"), { recursive: true, mode: 0o700 });
	await appendFile(controlFile(runtimeDir, workerId), `${JSON.stringify({ ...control, id: randomUUID() })}\n`, { mode: 0o600 });
}

async function waitForIdle(runtimeDir: string, workerId: string, signal?: AbortSignal): Promise<WorkerRecord | undefined> {
	while (!signal?.aborted) {
		const record = await readRecord(runtimeDir, workerId);
		if (!record || ["idle", "error", "aborted", "exited"].includes(record.status)) return record;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return readRecord(runtimeDir, workerId);
}

class GuestEventMap extends Map<string, unknown> {
	constructor(private readonly report: (type: string, data: unknown) => void) { super(); }
	override set(key: string, value: unknown): this {
		super.set(key, value);
		this.report(key, value);
		return this;
	}
	override delete(key: string): boolean {
		const deleted = super.delete(key);
		if (deleted) this.report(`${key}:deleted`, undefined);
		return deleted;
	}
	override clear(): void {
		const keys = [...this.keys()];
		super.clear();
		for (const key of keys) this.report(`${key}:deleted`, undefined);
	}
}

export default function workersExtension(pi: ExtensionAPI) {
	// A package-installed extension is auto-discovered in the child, while the
	// explicit --extension below keeps temporary/local invocations self-contained.
	// Register only once when both routes load this same extension in one process.
	const processGlobals = globalThis as Record<PropertyKey, unknown>;
	if (processGlobals[EXTENSION_INSTANCE_SYMBOL]) return;
	processGlobals[EXTENSION_INSTANCE_SYMBOL] = true;
	const extensionPath = process.env.PI_WORKERS_EXTENSION_PATH ?? __filename;
	const runtimeDir = process.env.PI_WORKERS_RUNTIME_DIR || runtimeDirForRoot();
	const ownWorkerId = process.env.PI_WORKERS_WORKER_ID;
	const lockedConfig = configFromEnvironment();
	let currentModel: string | undefined;
	let controlsOffset = 0;
	let controlTimer: ReturnType<typeof setInterval> | undefined;
	const childProcesses = new Map<string, ChildProcessWithoutNullStreams>();

	const installGuestEventMap = () => {
		if (!ownWorkerId) return;
		const globals = globalThis as Record<PropertyKey, unknown>;
		if (globals[GUEST_EVENTS_PROPERTY] instanceof Map && globals[GUEST_EVENTS_SYMBOL] instanceof Map) return;
		const guestEvents = new GuestEventMap((type, data) => {
			void appendWorkerEvent(runtimeDir, ownWorkerId, "guest", type, data);
		});
		globals[GUEST_EVENTS_PROPERTY] = guestEvents;
		globals[GUEST_EVENTS_SYMBOL] = guestEvents;
	};
	// Install during extension initialization so other guest extensions can publish
	// from their own session_start handlers regardless of extension load order.
	installGuestEventMap();

	const getConfig = async (cwd: string) => lockedConfig ?? loadRootConfig(cwd);
	const routeFor = (config: WorkersConfig, model: string | undefined, tag: string): WorkerRoute | undefined => model ? config.models[model]?.workers[tag] : undefined;
	const canSpawn = (config: WorkersConfig, model = currentModel) => Boolean(model && Object.keys(config.models[model]?.workers ?? {}).length);

	const launchWorker = async (params: { tag: string; task: string; name?: string; wait?: boolean }, ctx: { cwd: string; model?: unknown; signal?: AbortSignal }): Promise<WorkerRecord | undefined> => {
		const config = await getConfig(ctx.cwd);
		const caller = modelKey(ctx.model) ?? currentModel;
		const route = routeFor(config, caller, params.tag);
		if (!caller || !route) throw new Error(`Model ${caller ?? "(unknown)"} is not authorized to spawn worker tag '${params.tag}'.`);
		const parent = ownWorkerId ? await readRecord(runtimeDir, ownWorkerId) : undefined;
		const depth = parent ? parent.depth + 1 : 1;
		if (depth > config.maxDepth) throw new Error(`Worker depth ${depth} exceeds strict maxDepth ${config.maxDepth}.`);
		const routeKey = `${caller}#${params.tag}`;
		const lineageRoutes = [...(parent?.lineageRoutes ?? []), routeKey];
		const uses = lineageRoutes.filter((entry) => entry === routeKey).length;
		if (uses > (route.maxPerLineage ?? 1)) throw new Error(`Route '${routeKey}' may appear only ${route.maxPerLineage ?? 1} time(s) in one worker lineage.`);
		const existing = await listRecords(runtimeDir);
		if (existing.length >= config.maxWorkers) throw new Error(`Worker cap reached (${config.maxWorkers}).`);

		const workerId = randomUUID().slice(0, 8);
		const record: WorkerRecord = {
			id: workerId, parentId: parent?.id ?? null, depth, model: route.model, tag: params.tag, callerModel: caller, lineageRoutes,
			status: "starting", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		};
		await writeRecord(runtimeDir, record);
		await appendWorkerEvent(runtimeDir, workerId, "lifecycle", "worker_created", { parentId: record.parentId, callerModel: caller, tag: params.tag, model: route.model, depth });
		const task = `${params.name ? `[Worker: ${params.name}]\n` : ""}${params.task}`;
		childProcesses.set(workerId, startWorkerProcess(ctx.cwd, runtimeDir, config, record, task, extensionPath));
		if (params.wait) await waitForIdle(runtimeDir, workerId, ctx.signal);
		return readRecord(runtimeDir, workerId);
	};

	const refreshToolAccess = async (ctx: { cwd: string; model?: unknown }) => {
		currentModel = modelKey(ctx.model) ?? currentModel;
		try {
			const config = await getConfig(ctx.cwd);
			const active = pi.getActiveTools();
			pi.setActiveTools(canSpawn(config) ? [...new Set([...active, "workers_spawn"])] : active.filter((name) => name !== "workers_spawn"));
		} catch {
			pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "workers_spawn"));
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		currentModel = modelKey(ctx.model);
		if (ownWorkerId) {
			const record = await readRecord(runtimeDir, ownWorkerId);
			if (record) {
				record.status = "running";
				record.pid = process.pid;
				record.sessionFile = ctx.sessionManager.getSessionFile();
				await writeRecord(runtimeDir, record);
				await appendWorkerEvent(runtimeDir, ownWorkerId, "lifecycle", "session_started", { sessionFile: record.sessionFile, pid: process.pid });
			}
			installGuestEventMap();
			controlTimer = setInterval(() => {
				void (async () => {
					let contents: string;
					try { contents = await readFile(controlFile(runtimeDir, ownWorkerId), "utf8"); } catch { return; }
					const unread = contents.slice(controlsOffset);
					controlsOffset = contents.length;
					for (const line of unread.split("\n")) {
						if (!line.trim()) continue;
						try {
							const control = JSON.parse(line) as ControlMessage;
							if (control.type === "abort") ctx.abort();
							if (control.type === "prompt" && control.message) pi.sendUserMessage(control.message, { deliverAs: control.delivery ?? "steer" });
						} catch { /* malformed controls fail closed */ }
					}
				})();
			}, CONTROL_POLL_MS);
		}
		await refreshToolAccess(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		const selected = modelKey(event.model);
		if (ownWorkerId) {
			const record = await readRecord(runtimeDir, ownWorkerId);
			// A worker's target model is immutable. Extensions/user controls inside the
			// guest cannot change it and thereby obtain a different routing policy.
			if (record && selected !== record.model) {
				const [provider, id] = record.model.split("/", 2);
				const required = ctx.modelRegistry.find(provider, id);
				if (required) void pi.setModel(required);
				currentModel = record.model;
				await appendWorkerEvent(runtimeDir, ownWorkerId, "lifecycle", "model_change_rejected", { selected, required: record.model });
				await refreshToolAccess({ ...ctx, model: { provider, id } });
				return;
			}
		}
		currentModel = selected;
		await refreshToolAccess(ctx);
	});

	pi.on("message_end", async (event) => {
		if (!ownWorkerId) return;
		const output = finalText(event.message);
		if (output) await updateWorkerOutput(runtimeDir, ownWorkerId, output, "running");
	});
	pi.on("agent_settled", async () => {
		if (ownWorkerId) await updateWorkerOutput(runtimeDir, ownWorkerId, undefined, "idle");
	});
	pi.on("session_shutdown", async () => {
		processGlobals[EXTENSION_INSTANCE_SYMBOL] = undefined;
		if (controlTimer) clearInterval(controlTimer);
		for (const child of childProcesses.values()) child.kill("SIGTERM");
		childProcesses.clear();
		if (ownWorkerId) {
			await appendWorkerEvent(runtimeDir, ownWorkerId, "lifecycle", "session_shutdown", {});
			await updateWorkerOutput(runtimeDir, ownWorkerId, undefined, "exited");
		} else if (!process.env.PI_WORKERS_RUNTIME_DIR) {
			// Worker transcripts themselves are ordinary persisted Pi sessions; only
			// transient control/status/event indexes are removed with the root runtime.
			await rm(runtimeDir, { recursive: true, force: true });
		}
	});

	pi.registerTool({
		name: "workers_spawn", label: "Workers: Spawn",
		description: "Spawn a persistent Pi worker through a tag owned by the active caller model. The tag, depth, route repetition, and total-worker limits are enforced; no model argument exists.",
		promptSnippet: "Spawn persistent, transcript-backed workers through the strict per-model routing policy",
		promptGuidelines: [
			"Use workers_spawn only for a delegated task. Its tag must be authorized for the active model; do not attempt to choose a model directly.",
			"Use workers_query to read a worker transcript and workers_listen to consume its built-in or guest event stream before relying on its progress.",
		],
		parameters: SpawnParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const final = await launchWorker(params, { cwd: ctx.cwd, model: ctx.model, signal });
			return textResult(`Worker ${final?.id ?? "(unknown)"} started: ${final?.model ?? "(unknown)"} via ${final?.callerModel ?? "(unknown)"}#${params.tag}.\n${final ? summarize(final) : ""}`, { worker: final });
		},
	});

	pi.registerTool({
		name: "workers_query", label: "Workers: Query transcript",
		description: "Read a worker's persisted Pi session transcript. This is the authoritative worker conversation, including assistant messages and tool results; pass 'all' for every worker in this tree.",
		parameters: QueryParams,
		async execute(_id, params) {
			const records = params.workerId === "all" ? await listRecords(runtimeDir) : [await readRecord(runtimeDir, params.workerId)].filter((record): record is WorkerRecord => Boolean(record));
			if (records.length === 0) throw new Error(`No worker found for '${params.workerId}'.`);
			const workers = await Promise.all(records.map(async (record) => ({ record, transcript: await transcriptSummary(record, params.tail ?? 20) })));
			return textResult(workers.map(({ record, transcript }) => `${summarize(record)}\n\nTranscript:\n${transcript}`).join("\n\n---\n\n"), { workers });
		},
	});

	pi.registerTool({
		name: "workers_listen", label: "Workers: Listen",
		description: "Read retained live events for a worker. Built-in Pi RPC events (messages, tool calls/results, queue events, etc.) and guest events written to globalThis.PI_WORKERS_EVENTS are multiplexed here. Use nextCursor as since to continue.",
		parameters: ListenParams,
		async execute(_id, params) {
			if (!(await readRecord(runtimeDir, params.workerId))) throw new Error(`Unknown worker: ${params.workerId}`);
			const result = await readWorkerEvents(runtimeDir, params.workerId, params.since ?? 0, params.limit ?? 25);
			const body = result.events.length ? result.events.map((event) => `[${event.seq}] ${event.timestamp} ${event.kind}:${event.type}\n${JSON.stringify(event.data)}`).join("\n\n") : "No events after that cursor.";
			return textResult(`${body}\n\nnextCursor: ${result.nextCursor}`, result);
		},
	});

	pi.registerTool({
		name: "workers_steer", label: "Workers: Steer",
		description: "Send an instruction to any live worker, including a nested worker. 'steer' is delivered after its current tool batch; 'followUp' waits until it settles.",
		parameters: SteerParams,
		async execute(_id, params) {
			await sendControl(runtimeDir, params.workerId, { type: "prompt", message: params.message, delivery: params.delivery ?? "steer" });
			return textResult(`Queued ${params.delivery ?? "steer"} instruction for worker ${params.workerId}.`, { workerId: params.workerId });
		},
	});

	pi.registerCommand("workers", {
		description: "Manage workers: status [id|all], query <id>, listen <id> [cursor], spawn <tag> <task>, steer <id> <message>, abort <id>",
		handler: async (args, ctx) => {
			const [action = "status", first, ...rest] = args.trim().split(/\s+/);
			if (action === "status") {
				const records = first && first !== "all" ? [await readRecord(runtimeDir, first)].filter((record): record is WorkerRecord => Boolean(record)) : await listRecords(runtimeDir);
				ctx.ui.notify(records.length ? records.map(summarize).join("\n\n") : "No workers in this runtime.", "info");
				return;
			}
			if (action === "query") {
				if (!first) throw new Error("Usage: /workers query <worker-id>");
				const record = await readRecord(runtimeDir, first);
				if (!record) throw new Error(`Unknown worker: ${first}`);
				ctx.ui.notify(`${summarize(record)}\n\nTranscript:\n${await transcriptSummary(record, 20)}`, "info");
				return;
			}
			if (action === "listen") {
				if (!first) throw new Error("Usage: /workers listen <worker-id> [cursor]");
				const since = rest[0] ? Number.parseInt(rest[0], 10) : 0;
				const { events, nextCursor } = await readWorkerEvents(runtimeDir, first, Number.isFinite(since) ? since : 0);
				ctx.ui.notify(`${events.map((event) => `[${event.seq}] ${event.kind}:${event.type} ${JSON.stringify(event.data)}`).join("\n") || "No events."}\nnextCursor: ${nextCursor}`, "info");
				return;
			}
			if (action === "steer") {
				if (!first || rest.length === 0) throw new Error("Usage: /workers steer <worker-id> <message>");
				await sendControl(runtimeDir, first, { type: "prompt", message: rest.join(" "), delivery: "steer" });
				ctx.ui.notify(`Steering message queued for ${first}.`, "info");
				return;
			}
			if (action === "abort") {
				if (!first) throw new Error("Usage: /workers abort <worker-id>");
				await sendControl(runtimeDir, first, { type: "abort" });
				await updateWorkerOutput(runtimeDir, first, undefined, "aborted");
				ctx.ui.notify(`Abort requested for ${first}.`, "warning");
				return;
			}
			if (action === "spawn") {
				if (!first || rest.length === 0) throw new Error("Usage: /workers spawn <tag> <task>");
				const worker = await launchWorker({ tag: first, task: rest.join(" ") }, { cwd: ctx.cwd, model: ctx.model });
				ctx.ui.notify(worker ? `Worker started.\n${summarize(worker)}` : "Worker launch failed before a status record was available.", "info");
				return;
			}
			throw new Error("Usage: /workers status [id|all] | query <id> | listen <id> [cursor] | spawn <tag> <task> | steer <id> <message> | abort <id>");
		},
	});
}