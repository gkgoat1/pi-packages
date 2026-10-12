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
import { fileURLToPath } from "node:url";
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
const recordMutationQueues = new Map<string, Promise<void>>();

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
	/** The initial task, kept so a pre-persistence crash stays distinguishable from a settled worker. */
	initialTask?: string;
	/** True once the child accepted the initial prompt; a resume must not send it again. */
	initialTaskPersisted?: boolean;
	/** Process attempts, counting the original launch; incremented by each resume. */
	attempts?: number;
	lastResumedAt?: string;
	lastOutput?: string;
	error?: string;
	pid?: number;
}

interface ControlMessage {
	id: string;
	type: "prompt" | "abort" | "forward";
	message?: string;
	delivery?: Delivery;
	/** `forward` only: the nested worker this control is relayed to. */
	targetWorkerId?: string;
	inner?: { type: "steer" | "follow_up" | "prompt" | "abort" | "ui_response"; message?: string; requestId?: string; response?: Record<string, unknown> };
}

interface ControlAck {
	id: string;
	outcome: "applied" | "rejected";
	detail?: string;
}

interface ControlRead {
	entries: ControlMessage[];
	malformed: number;
	nextOffset: number;
	clamped: boolean;
}

interface WorkerEvent {
	seq: number;
	timestamp: string;
	workerId: string;
	kind: "pi" | "guest" | "lifecycle" | "ui";
	type: string;
	data: unknown;
}

const SpawnParams = Type.Object({
	tag: Type.String({ description: "Routing tag defined under the active caller model in .pi/workers.json. It exclusively selects the worker model." }),
	task: Type.String({ description: "Initial task for the worker" }),
	name: Type.Optional(Type.String({ description: "Optional human label included in the task" })),
	wait: Type.Optional(Type.Boolean({ description: "Wait until the worker becomes idle before returning (default false)" })),
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

const ReplyParams = Type.Object({
	workerId: Type.String({ description: "Worker id returned by workers_spawn, including a finished or errored one" }),
	message: Type.String({ description: "Follow-up message for the worker" }),
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
function controlFileFor(runtimeDir: string, workerId: string): string {
	return controlFile(runtimeDir, workerId);
}
function offsetFileFor(runtimeDir: string, workerId: string): string {
	return join(runtimeDir, "controls", `${workerId}.offset`);
}
function eventFile(runtimeDir: string, workerId: string): string {
	return join(runtimeDir, "events", `${workerId}.jsonl`);
}
function sessionFileFor(runtimeDir: string, workerId: string): string {
	return join(runtimeDir, "sessions", `${workerId}.jsonl`);
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

/**
 * Serialize read-modify-write cycles per worker. Concurrent stdout handlers
 * (prompt response, message end, settle, exit) otherwise clobber each other's
 * fields by writing back stale snapshots.
 */
async function mutateRecord(runtimeDir: string, workerId: string, mutate: (record: WorkerRecord) => void): Promise<WorkerRecord | undefined> {
	const key = `${runtimeDir}\u0000${workerId}`;
	const previous = recordMutationQueues.get(key) ?? Promise.resolve();
	let result: WorkerRecord | undefined;
	const operation = previous.catch(() => undefined).then(async () => {
		const record = await readRecord(runtimeDir, workerId);
		if (!record) return;
		mutate(record);
		await writeRecord(runtimeDir, record);
		result = record;
	});
	recordMutationQueues.set(key, operation);
	try {
		await operation;
	} finally {
		if (recordMutationQueues.get(key) === operation) recordMutationQueues.delete(key);
	}
	return result;
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
	// Test seam: point at a deterministic RPC fixture instead of the real CLI.
	const fixture = process.env.PI_WORKERS_PI_SCRIPT;
	if (fixture) return { command: process.execPath, args: [fixture, ...args] };
	const script = process.argv[1];
	if (script && existsSync(script) && !script.startsWith("/$bunfs/root/")) return { command: process.execPath, args: [script, ...args] };
	const executable = process.execPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
	return /^(node|bun)(\.exe)?$/.test(executable) ? { command: "pi", args } : { command: process.execPath, args };
}

/**
 * CLI arguments for one worker attempt. `--session` pins the append-only Pi
 * transcript to a path derived from the worker id, so a restarted attempt
 * reopens the same conversation instead of starting a new one.
 */
function workerInvocationArgs(record: WorkerRecord, extensionPath: string): string[] {
	if (!record.sessionFile) throw new Error(`Worker ${record.id} has no session file; records must carry a stable session path before launch.`);
	return [
		"--mode", "rpc", "--approve", "--model", record.model, "--name", `worker-${record.id}`,
		"--session", record.sessionFile,
		"--extension", extensionPath,
	];
}

type SafeEventData = string | number | boolean | null | unknown[] | { [key: string]: unknown };

const UI_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const UI_NOTIFY_METHODS = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);
const MAX_PENDING_DIALOGS = 64;

interface PendingUiDialog {
	workerId: string;
	requestId: string;
	method: string;
	createdAt: string;
	title?: string;
}

/** Per-worker pending dialogs, owned by the process reading that worker's stdout. */
const pendingDialogs = new Map<string, Map<string, PendingUiDialog>>();

function pendingKey(runtimeDir: string, workerId: string): string {
	return `${runtimeDir}\u0000${workerId}`;
}

async function pendingDialogsFor(runtimeDir: string, workerId: string): Promise<PendingUiDialog[]> {
	const store = pendingDialogs.get(pendingKey(runtimeDir, workerId));
	return store ? [...store.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : [];
}

/**
 * Register a dialog request as pending. Overflows auto-cancel back to the
 * child immediately so it never hangs on a dialog nobody can answer, and a
 * duplicate id replaces the older entry with a note.
 */
async function registerPendingDialog(runtimeDir: string, workerId: string, payload: Record<string, unknown>, proc?: ChildProcessWithoutNullStreams): Promise<void> {
	const requestId = typeof payload.id === "string" ? payload.id : undefined;
	const method = typeof payload.method === "string" ? payload.method : "unknown";
	if (!requestId) {
		await appendWorkerEvent(runtimeDir, workerId, "ui", "ui_rejected", { method, reason: "dialog request is missing an id" });
		return;
	}
	const key = pendingKey(runtimeDir, workerId);
	let store = pendingDialogs.get(key);
	if (!store) {
		store = new Map();
		pendingDialogs.set(key, store);
	}
	if (store.has(requestId)) {
		store.delete(requestId);
		await appendWorkerEvent(runtimeDir, workerId, "ui", "ui_answered", { id: requestId, method, outcome: "replaced", reason: "duplicate request id" });
	}
	if (store.size >= MAX_PENDING_DIALOGS) {
		if (proc && processIsLive(proc)) {
			try { proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: requestId, cancelled: true })}\n`); } catch { /* dead stdin */ }
		}
		await appendWorkerEvent(runtimeDir, workerId, "ui", "ui_answered", { id: requestId, method, outcome: "cancelled", reason: `pending dialog cap (${MAX_PENDING_DIALOGS})` });
		return;
	}
	store.set(requestId, {
		workerId,
		requestId,
		method,
		createdAt: new Date().toISOString(),
		...(typeof payload.title === "string" ? { title: payload.title } : {}),
	});
}

/** Remove a pending dialog and record the outcome on the worker's event stream. */
async function resolvePendingDialog(runtimeDir: string, workerId: string, requestId: string, outcome: "answered" | "cancelled" | "replaced", detail?: string): Promise<boolean> {
	const store = pendingDialogs.get(pendingKey(runtimeDir, workerId));
	const entry = store?.get(requestId);
	if (!entry) return false;
	store!.delete(requestId);
	await appendWorkerEvent(runtimeDir, workerId, "ui", "ui_answered", {
		id: requestId,
		method: entry.method,
		outcome,
		...(detail ? { detail: detail.slice(0, 500) } : {}),
	});
	return true;
}

type UiDialogResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

/** Shape-check an answer against the dialog method per the RPC extension UI contract. */
function uiResponseForMethod(method: string, response: UiDialogResponse): Record<string, unknown> | undefined {
	if ("cancelled" in response && response.cancelled === true) return { cancelled: true };
	if (method === "confirm") return "confirmed" in response && typeof response.confirmed === "boolean" ? { confirmed: response.confirmed } : undefined;
	if (["select", "input", "editor"].includes(method)) return "value" in response && typeof response.value === "string" ? { value: response.value } : undefined;
	return undefined;
}

/** Derive dialog state from the shared event stream (works for nested workers too). */
async function dialogPendingInEvents(runtimeDir: string, workerId: string, requestId: string): Promise<{ method: string } | undefined> {
	const { events } = await readWorkerEvents(runtimeDir, workerId, 0, 100);
	let method: string | undefined;
	for (const event of events) {
		if (event.kind !== "ui") continue;
		if (event.type === "ui_request" && isObject(event.data) && event.data.id === requestId && typeof event.data.method === "string") method = event.data.method;
		if (event.type === "ui_answered" && isObject(event.data) && event.data.id === requestId) method = undefined;
	}
	return method ? { method } : undefined;
}

/**
 * Answer a pending dialog. Own children get the extension_ui_response on their
 * stdin; nested workers relay through the process owner. Stale ids and wrong
 * shapes are rejected before any write.
 */
async function deliverUiAnswer(runtimeDir: string, workerId: string, requestId: string, response: UiDialogResponse, deps: DeliveryDeps): Promise<DeliveryOutcome> {
	const record = await readRecord(runtimeDir, workerId);
	if (!record) throw new Error(`Unknown worker: ${workerId}`);
	const ownChild = record.parentId === deps.ownWorkerId || (!deps.ownWorkerId && record.parentId === null);

	let method: string | undefined;
	if (ownChild) {
		const entry = pendingDialogs.get(pendingKey(runtimeDir, workerId))?.get(requestId);
		method = entry?.method ?? (await dialogPendingInEvents(runtimeDir, workerId, requestId))?.method;
	} else {
		method = (await dialogPendingInEvents(runtimeDir, workerId, requestId))?.method;
	}
	if (!method) return { kind: "rejected", detail: `No pending dialog ${requestId} on worker ${workerId} (stale or already answered).` };
	const shaped = uiResponseForMethod(method, response);
	if (!shaped) return { kind: "rejected", detail: `Answer shape does not match the ${method} dialog on worker ${workerId}.` };

	if (!ownChild && record.parentId) {
		const parent = await readRecord(runtimeDir, record.parentId);
		if (!parent) return { kind: "rejected", detail: `Parent worker ${record.parentId} is unknown; cannot reach ${workerId}.` };
		const parentProc = ownedProcesses.get(ownedKey(runtimeDir, parent.id));
		if (terminalStatus(parent) && !processIsLive(parentProc)) {
			return { kind: "rejected", detail: `Parent ${parent.id} is ${parent.status}; dialog ${requestId} is gone with its child process.` };
		}
		await appendControl(runtimeDir, parent.id, {
			type: "forward",
			targetWorkerId: workerId,
			inner: { type: "ui_response", requestId, response: shaped },
		});
		return { kind: "queued", detail: `Relayed dialog answer ${requestId} to ${workerId} through its parent ${parent.id}.` };
	}

	const proc = ownedProcesses.get(ownedKey(runtimeDir, workerId));
	if (!processIsLive(proc)) return { kind: "rejected", detail: `Worker ${workerId} is not running; dialog ${requestId} is gone.` };
	try {
		proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: requestId, ...shaped })}\n`);
	} catch (error) {
		return { kind: "rejected", detail: `Failed to write the dialog answer: ${error instanceof Error ? error.message : String(error)}` };
	}
	const cancelled = shaped.cancelled === true;
	await resolvePendingDialog(runtimeDir, workerId, requestId, cancelled ? "cancelled" : "answered", cancelled ? "cancelled by dashboard" : `${method} answered`);
	return { kind: "sent", detail: `Dialog ${requestId} on ${workerId} ${cancelled ? "cancelled" : "answered"}.` };
}

type UiCategory = "dialog" | "fireAndForget" | "unsupported";

interface UiClassification {
	category: UiCategory;
	id?: string;
	method?: string;
	/** Renderable payload; id and method survive even when the rest is truncated. */
	payload: Record<string, unknown>;
}

/**
 * Classify a raw `extension_ui_request` record against the RPC-supported method
 * set. Anything outside the allowlist is unsupported — never treated as a
 * dialog, so no worker can block on a record the dashboard cannot answer.
 */
function classifyUiRequest(record: Record<string, unknown>): UiClassification {
	const id = typeof record.id === "string" ? record.id : undefined;
	const method = typeof record.method === "string" ? record.method : undefined;
	const category: UiCategory = method && UI_DIALOG_METHODS.has(method) ? "dialog"
		: method && UI_NOTIFY_METHODS.has(method) ? "fireAndForget"
		: "unsupported";
	if (category === "unsupported") {
		return { category, id, method, payload: { id, method, reason: "unsupported extension UI method" } };
	}
	const { type: _type, id: _id, method: _method, ...fields } = record;
	const bounded = safeEventData(fields);
	const payload = isObject(bounded) && bounded.truncated === true
		// Keep the identity fields readable by shrinking the preview far below the
		// outer 64 KiB event cap, which would otherwise re-truncate and drop them.
		? { id, method, category, truncated: true, originalBytes: bounded.originalBytes, preview: typeof bounded.preview === "string" ? bounded.preview.slice(0, 2000) : "" }
		: isObject(bounded)
			? { id, method, category, ...bounded }
			: { id, method, category, value: bounded };
	return { category, id, method, payload };
}

function safeEventData(value: unknown): SafeEventData {
	try {
		const text = JSON.stringify(value);
		if (text.length <= MAX_EVENT_BYTES) return JSON.parse(text) as SafeEventData;
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
	await mutateRecord(runtimeDir, workerId, (record) => {
		if (output) record.lastOutput = output.slice(-MAX_OUTPUT_CHARS);
		if (status) record.status = status;
		if (error) record.error = error.slice(-4000);
	});
}

async function markInitialTaskPersisted(runtimeDir: string, workerId: string): Promise<void> {
	await mutateRecord(runtimeDir, workerId, (record) => {
		record.initialTaskPersisted = true;
	});
}

/** Settle to idle only from a live state, so an abort wins over a late settle. */
async function settleWorker(runtimeDir: string, workerId: string): Promise<void> {
	await mutateRecord(runtimeDir, workerId, (record) => {
		if (record.status === "starting" || record.status === "running") record.status = "idle";
	});
}

/** Mark a worker aborted and notify its process; the status survives the exit. */
async function abortWorker(runtimeDir: string, workerId: string): Promise<void> {
	await appendControl(runtimeDir, workerId, { type: "abort" });
	await mutateRecord(runtimeDir, workerId, (record) => {
		record.status = "aborted";
	});
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

interface WorkerChannel {
	readonly closed: boolean;
	send(command: Record<string, unknown>): Promise<Record<string, unknown>>;
	handleRecord(record: Record<string, unknown>): void;
	failAll(reason: string): void;
}

/** Correlate stdin commands to stdout `response` records for one child process. */
function createWorkerChannel(proc: ChildProcessWithoutNullStreams): WorkerChannel {
	const pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
	let closed = false;
	const channel: WorkerChannel = {
		get closed() { return closed; },
		send(command) {
			if (closed || proc.exitCode !== null || proc.signalCode !== null) {
				return Promise.reject(new Error("Worker process is not running; the command cannot be delivered."));
			}
			const id = typeof command.id === "string" ? command.id : `rpc-${randomUUID()}`;
			const record = { ...command, id };
			return new Promise((resolve, reject) => {
				pending.set(id, { resolve, reject });
				proc.stdin.write(`${JSON.stringify(record)}\n`, (error) => {
					if (error) {
						pending.delete(id);
						reject(error);
					}
				});
			});
		},
		handleRecord(record) {
			if (record.type !== "response" || typeof record.id !== "string") return;
			const waiter = pending.get(record.id);
			if (!waiter) return;
			pending.delete(record.id);
			waiter.resolve(record);
		},
		failAll(reason) {
			closed = true;
			for (const waiter of pending.values()) waiter.reject(new Error(reason));
			pending.clear();
		},
	};
	return channel;
}

const channelByProcess = new WeakMap<ChildProcessWithoutNullStreams, WorkerChannel>();
function channelForProcess(proc: ChildProcessWithoutNullStreams): WorkerChannel | undefined {
	return channelByProcess.get(proc);
}

type ControlMode = "reply" | "steer";

interface DeliveryOutcome {
	/** sent = live RPC delivery; queued = relayed to the owner process; resumed = restarted and delivered; rejected = refused. */
	kind: "sent" | "queued" | "resumed" | "rejected";
	detail: string;
}

interface DeliveryDeps {
	cwd: string;
	config: WorkersConfig;
	extensionPath: string;
	/** The current worker id when this process is itself a worker (root: undefined). */
	ownWorkerId?: string;
}

function terminalStatus(record: WorkerRecord): boolean {
	return ["error", "aborted", "exited"].includes(record.status);
}

/** Kill every worker process this process owns; used by session shutdown and test cleanup. */
async function stopWorkerProcesses(): Promise<void> {
	const live = [...ownedProcesses.values()];
	for (const proc of live) {
		if (processIsLive(proc)) proc.kill("SIGTERM");
	}
	await Promise.all(live.map((proc) => (
		proc.exitCode === null && proc.signalCode === null
			? new Promise((resolve) => proc.once("exit", resolve))
			: undefined
	)));
}

/**
 * The single validator behind workers_reply, workers_steer, and the /workers
 * command. Own children are addressed over their RPC channel; nested workers
 * are reached by a forward control to the process that owns their stdin.
 */
async function deliverToWorker(runtimeDir: string, workerId: string, message: string, mode: ControlMode, deps: DeliveryDeps): Promise<DeliveryOutcome> {
	if (message.length > MAX_OUTPUT_CHARS) return { kind: "rejected", detail: `Message exceeds ${MAX_OUTPUT_CHARS} characters.` };
	const record = await readRecord(runtimeDir, workerId);
	if (!record) throw new Error(`Unknown worker: ${workerId}`);
	const terminal = terminalStatus(record);

	const ownChild = record.parentId === deps.ownWorkerId || (!deps.ownWorkerId && record.parentId === null);
	if (!ownChild && record.parentId) {
		// Nested: the parent process owns the child's stdin. Steer on an ended
		// worker is meaningless; relay the rest and let the owner resume it.
		if (mode === "steer" && terminal) {
			return { kind: "rejected", detail: `Worker ${workerId} is ${record.status}; nothing to steer. Use workers_reply to resume it.` };
		}
		const parent = await readRecord(runtimeDir, record.parentId);
		if (!parent) return { kind: "rejected", detail: `Parent worker ${record.parentId} is unknown; cannot reach ${workerId}.` };
		const parentProc = ownedProcesses.get(ownedKey(runtimeDir, parent.id));
		if (terminalStatus(parent) && !processIsLive(parentProc)) {
			// Revive the parent (no message) so its poll loop picks up the control —
			// but only when this process owns it. A dead grandparent must be revived
			// from its own nearest live ancestor, never resurrected wholesale here.
			const parentIsOwnChild = parent.parentId === deps.ownWorkerId || (!deps.ownWorkerId && parent.parentId === null);
			if (!parentIsOwnChild) {
				return { kind: "rejected", detail: `Worker ${workerId} is unreachable: parent ${parent.id} is ${parent.status} and not a direct child of this process. Revive ${parent.id} first.` };
			}
			await resumeWorker(runtimeDir, parent.id, { cwd: deps.cwd, config: deps.config, extensionPath: deps.extensionPath });
		}
		await appendControl(runtimeDir, parent.id, {
			type: "forward",
			targetWorkerId: workerId,
			inner: { type: mode === "steer" ? "steer" : terminal ? "prompt" : "follow_up", message },
		});
		return { kind: "queued", detail: `Relayed ${mode} to ${workerId} through its parent ${parent.id}.` };
	}

	const proc = ownedProcesses.get(ownedKey(runtimeDir, workerId));
	if (processIsLive(proc)) {
		const channel = channelForProcess(proc);
		if (!channel) return { kind: "rejected", detail: `Worker ${workerId} has no RPC channel.` };
		const streaming = record.status === "starting" || record.status === "running";
		const command: Record<string, unknown> = mode === "steer" && streaming
			? { type: "steer", message }
			: streaming
				? { type: "follow_up", message }
				: { type: "prompt", message };
		const response = await channel.send(command);
		if (response.success !== true) return { kind: "rejected", detail: `Worker ${workerId} rejected the command: ${String(response.error ?? "unknown")}` };
		const disposition = isObject(response.data) && typeof response.data.disposition === "string" ? response.data.disposition : "accepted";
		return { kind: "sent", detail: `${String(command.type)} delivered to ${workerId} (${disposition}).` };
	}
	if (mode === "steer" && terminal) {
		return { kind: "rejected", detail: `Worker ${workerId} is ${record.status}; nothing to steer. Use workers_reply to resume it.` };
	}
	const resumed = await resumeWorker(runtimeDir, workerId, { cwd: deps.cwd, config: deps.config, extensionPath: deps.extensionPath, message });
	return { kind: "resumed", detail: `Resumed ${workerId} (attempt ${resumed.record.attempts ?? "?"}) and delivered the ${mode}.` };
}

interface ForwardOutcome {
	kind: "applied" | "rejected";
	detail: string;
}

/**
 * Apply a control relayed to one of this process's own children. Live children
 * get the native RPC command on their channel; ended children are resumed on
 * their pinned session for message controls. Every outcome is acked on the
 * owner worker's event stream.
 */
async function applyForwardControl(runtimeDir: string, ownerId: string, control: ControlMessage, deps: { cwd: string; config: WorkersConfig; extensionPath: string; trackProcess?: (proc: ChildProcessWithoutNullStreams) => void }): Promise<ForwardOutcome> {
	const target = typeof control.targetWorkerId === "string" ? control.targetWorkerId : undefined;
	const inner = control.inner;
	const fail = async (detail: string): Promise<ForwardOutcome> => {
		await acknowledgeControl(runtimeDir, ownerId, { id: control.id, outcome: "rejected", detail });
		return { kind: "rejected", detail };
	};
	if (!target) return fail("forward control is missing targetWorkerId");
	if (!inner || !["steer", "follow_up", "prompt", "abort", "ui_response"].includes(inner.type)) return fail(`forward to ${target}: unsupported inner control type`);
	if (inner.message !== undefined && inner.message.length > MAX_OUTPUT_CHARS) return fail(`forward to ${target}: message exceeds ${MAX_OUTPUT_CHARS} characters`);
	const record = await readRecord(runtimeDir, target);
	if (!record || record.parentId !== ownerId) return fail(`forward target ${target} is not a child of ${ownerId}`);

	if (inner.type === "ui_response") {
		const requestId = typeof inner.requestId === "string" ? inner.requestId : undefined;
		if (!requestId || !isObject(inner.response)) return fail(`forward to ${target}: ui_response needs a requestId and a response`);
		const childProc = ownedProcesses.get(ownedKey(runtimeDir, target));
		if (!processIsLive(childProc)) return fail(`forward target ${target} is not running; dialog ${requestId} is gone`);
		const pending = pendingDialogs.get(pendingKey(runtimeDir, target))?.get(requestId);
		if (!pending) return fail(`no pending dialog ${requestId} on ${target}`);
		try {
			childProc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: requestId, ...inner.response })}\n`);
		} catch (error) {
			return fail(`forward to ${target} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const cancelled = inner.response.cancelled === true;
		await resolvePendingDialog(runtimeDir, target, requestId, cancelled ? "cancelled" : "answered", `relayed by ${ownerId}`);
		const detail = `dialog ${requestId} ${cancelled ? "cancelled" : "answered"} on ${target}`;
		await acknowledgeControl(runtimeDir, ownerId, { id: control.id, outcome: "applied", detail });
		return { kind: "applied", detail };
	}

	const proc = ownedProcesses.get(ownedKey(runtimeDir, target));
	if (processIsLive(proc)) {
		const channel = channelForProcess(proc);
		if (!channel) return fail(`forward target ${target} has no RPC channel`);
		try {
			const command: Record<string, unknown> = inner.type === "abort"
				? { type: "abort" }
				: { type: inner.type, message: inner.message ?? "" };
			const response = await channel.send(command);
			const disposition = isObject(response.data) && typeof response.data.disposition === "string" ? response.data.disposition : undefined;
			const detail = response.success === true
				? `${inner.type} delivered to ${target}${disposition ? ` (${disposition})` : ""}`
				: `${inner.type} rejected by ${target}: ${String(response.error ?? "unknown")}`;
			await acknowledgeControl(runtimeDir, ownerId, { id: control.id, outcome: response.success === true ? "applied" : "rejected", detail });
			return { kind: response.success === true ? "applied" : "rejected", detail };
		} catch (error) {
			return fail(`forward to ${target} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (inner.type === "abort") return fail(`forward target ${target} is not running; nothing to abort`);
	const resumed = await resumeWorker(runtimeDir, target, { cwd: deps.cwd, config: deps.config, extensionPath: deps.extensionPath, message: inner.message });
	deps.trackProcess?.(resumed.process);
	const detail = `resumed ${target} (attempt ${resumed.record.attempts ?? "?"}) and delivered ${inner.type}`;
	await acknowledgeControl(runtimeDir, ownerId, { id: control.id, outcome: "applied", detail });
	return { kind: "applied", detail };
}

interface ResumeOptions {
	cwd: string;
	config: WorkersConfig;
	extensionPath: string;
	/** Optional reply to deliver once the worker is running again. */
	message?: string;
	/** Caller-known live handle; resuming a live worker is a caller bug. */
	liveProcess?: ChildProcessWithoutNullStreams;
}

interface ResumeResult {
	/** "resumed" = a new process attempt started; "sent" = the message delivered into an existing one. */
	outcome: "resumed" | "sent";
	process: ChildProcessWithoutNullStreams;
	record: WorkerRecord;
}

const ownedProcesses = new Map<string, ChildProcessWithoutNullStreams>();
const resumesInFlight = new Map<string, Promise<ResumeResult>>();

function processIsLive(proc: ChildProcessWithoutNullStreams | undefined): proc is ChildProcessWithoutNullStreams {
	return Boolean(proc && proc.exitCode === null && proc.signalCode === null);
}

function ownedKey(runtimeDir: string, workerId: string): string {
	return `${runtimeDir}\u0000${workerId}`;
}

/**
 * Restart an ended worker on its own pinned session and optionally deliver a
 * reply. Never replays an already-persisted initial task, never creates a
 * second process while one attempt is live or starting.
 */
async function resumeWorker(runtimeDir: string, workerId: string, options: ResumeOptions): Promise<ResumeResult> {
	const key = ownedKey(runtimeDir, workerId);
	const owned = ownedProcesses.get(key);
	if (processIsLive(owned) || processIsLive(options.liveProcess)) {
		const proc = (processIsLive(owned) ? owned : options.liveProcess)!;
		if (processIsLive(options.liveProcess) && !processIsLive(owned)) {
			throw new Error(`Worker ${workerId} is live (pid ${proc.pid}); steer or reply through the live channel instead of resuming.`);
		}
		if (options.message) await channelForProcess(proc)?.send({ type: "prompt", id: `reply-${randomUUID()}`, message: options.message });
		const record = await readRecord(runtimeDir, workerId);
		return { outcome: "sent", process: proc, record: record! };
	}
	const inFlight = resumesInFlight.get(key);
	if (inFlight) {
		const started = await inFlight;
		if (options.message) await channelForProcess(started.process)?.send({ type: "prompt", id: `reply-${randomUUID()}`, message: options.message });
		return { ...started, outcome: "sent" };
	}
	const record = await readRecord(runtimeDir, workerId);
	if (!record) throw new Error(`Unknown worker: ${workerId}`);
	if (record.status === "starting" || record.status === "running") {
		throw new Error(`Worker ${workerId} is ${record.status}; steer or reply through the live channel instead of resuming.`);
	}
	const resume = (async (): Promise<ResumeResult> => {
		const attempts = (record.attempts ?? 1) + 1;
		const updated = await mutateRecord(runtimeDir, workerId, (current) => {
			current.status = "starting";
			current.attempts = attempts;
			current.lastResumedAt = new Date().toISOString();
		});
		await appendWorkerEvent(runtimeDir, workerId, "lifecycle", "worker_resumed", { attempt: attempts, message: options.message ? true : false });
		// Replaying an accepted initial task would duplicate it in the transcript;
		// an unpersisted one must be delivered or the worker never got its task.
		const task = record.initialTaskPersisted ? undefined : record.initialTask;
		const proc = startWorkerProcess(options.cwd, runtimeDir, options.config, updated ?? record, task, options.extensionPath);
		if (options.message) {
			const channel = channelForProcess(proc);
			// The original task goes as the initial prompt; the reply queues behind it.
			const command = task === undefined
				? { type: "prompt", id: `reply-${randomUUID()}`, message: options.message }
				: { type: "follow_up", id: `reply-${randomUUID()}`, message: options.message };
			await channel?.send(command);
		}
		return { outcome: "resumed", process: proc, record: (await readRecord(runtimeDir, workerId)) ?? record };
	})();
	resumesInFlight.set(key, resume);
	try {
		return await resume;
	} finally {
		if (resumesInFlight.get(key) === resume) resumesInFlight.delete(key);
	}
}

function startWorkerProcess(cwd: string, runtimeDir: string, config: WorkersConfig, record: WorkerRecord, task: string | undefined, extensionPath: string): ChildProcessWithoutNullStreams {
	// Do NOT use --no-session or --no-extensions. A worker has its own persisted
	// Pi transcript and normal project/global extensions, plus this extension.
	// The initial task goes over stdin only on the first attempt; a resume with
	// `task === undefined` reopens `--session` and must not replay it.
	const invocation = piInvocation(workerInvocationArgs(record, extensionPath));
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
	const channel = createWorkerChannel(proc);
	channelByProcess.set(proc, channel);
	const key = ownedKey(runtimeDir, record.id);
	ownedProcesses.set(key, proc);
	proc.on("exit", () => {
		if (ownedProcesses.get(key) === proc) ownedProcesses.delete(key);
	});
	void appendWorkerEvent(runtimeDir, record.id, "lifecycle", "process_started", { pid: proc.pid, invocation: [invocation.command, ...invocation.args] });
	let buffer = "";
	proc.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			try {
				const event = JSON.parse(line);
				channel.handleRecord(event);
				if (event.type === "extension_ui_request") {
					const ui = classifyUiRequest(event);
					if (ui.category === "unsupported") {
						void appendWorkerEvent(runtimeDir, record.id, "ui", "ui_rejected", ui.payload);
					} else {
						void appendWorkerEvent(runtimeDir, record.id, "ui", "ui_request", ui.payload);
						if (ui.category === "dialog") void registerPendingDialog(runtimeDir, record.id, ui.payload, proc);
					}
					continue;
				}
				void appendWorkerEvent(runtimeDir, record.id, "pi", typeof event.type === "string" ? event.type : "unknown", event);
				if (event.type === "response" && event.command === "prompt" && event.id === `initial-${record.id}`) {
					if (event.success === true) void markInitialTaskPersisted(runtimeDir, record.id);
					else void updateWorkerOutput(runtimeDir, record.id, undefined, "error", `Initial prompt rejected: ${String(event.error ?? "unknown error")}`);
				}
				if (event.type === "message_end") {
					const output = finalText(event.message);
					if (output) void updateWorkerOutput(runtimeDir, record.id, output, "running");
					// Provider failures surface on the final assistant message, not on
					// the command response; retain the detail so the worker is resumable.
					if (isObject(event.message) && event.message.stopReason === "error" && typeof event.message.errorMessage === "string") {
						void updateWorkerOutput(runtimeDir, record.id, undefined, undefined, event.message.errorMessage);
					}
				}
				if (event.type === "agent_settled") void settleWorker(runtimeDir, record.id);
			} catch {
				void appendWorkerEvent(runtimeDir, record.id, "lifecycle", "invalid_stdout", line.slice(0, 2000));
			}
		}
	});
	let stderr = "";
	proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
	proc.on("error", (error) => {
		channel.failAll(`Worker process errored: ${error.message}`);
		void appendWorkerEvent(runtimeDir, record.id, "lifecycle", "process_error", { message: error.message });
		void updateWorkerOutput(runtimeDir, record.id, undefined, "error", error.message);
	});
	proc.on("exit", (code, signal) => {
		channel.failAll(`Worker process exited (${signal ?? code ?? "unknown"}); outstanding commands were not answered.`);
		void appendWorkerEvent(runtimeDir, record.id, "lifecycle", "process_exit", { code, signal, stderr: stderr.slice(-4000) });
		void (async () => {
			await mutateRecord(runtimeDir, record.id, (current) => {
				if (current.status === "aborted") return;
				const cleanExit = code === 0 || (signal !== null && ["idle", "error", "exited"].includes(current.status));
				current.status = cleanExit ? "exited" : "error";
				if (!cleanExit) current.error = (stderr || `Worker exited (${signal ?? code ?? "unknown"}).`).slice(-4000);
			});
		})();
	});
	proc.stdin.on("error", () => { /* surfaced via process error/exit handlers */ });
	if (task !== undefined) {
		proc.stdin.write(`${JSON.stringify({ type: "prompt", id: `initial-${record.id}`, message: task })}\n`);
		void appendWorkerEvent(runtimeDir, record.id, "lifecycle", "initial_prompt_sent", { id: `initial-${record.id}` });
	}
	return proc;
}

async function appendControl(runtimeDir: string, workerId: string, control: Omit<ControlMessage, "id">): Promise<ControlMessage> {
	if (!(await readRecord(runtimeDir, workerId))) throw new Error(`Unknown worker: ${workerId}`);
	await mkdir(join(runtimeDir, "controls"), { recursive: true, mode: 0o700 });
	const entry: ControlMessage = { ...control, id: randomUUID() };
	await appendFile(controlFile(runtimeDir, workerId), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
	return entry;
}

/** Read controls after a byte offset; malformed lines are counted, not fatal. */
async function readAppliedControls(runtimeDir: string, workerId: string, offset: number): Promise<ControlRead> {
	let contents: string;
	try {
		contents = await readFile(controlFile(runtimeDir, workerId), "utf8");
	} catch {
		return { entries: [], malformed: 0, nextOffset: 0, clamped: offset > 0 };
	}
	const clamped = offset > contents.length;
	const unread = clamped ? "" : contents.slice(offset);
	const entries: ControlMessage[] = [];
	let malformed = 0;
	for (const line of unread.split("\n")) {
		if (!line.trim()) continue;
		try {
			const control = JSON.parse(line) as ControlMessage;
			if (typeof control.id === "string" && typeof control.type === "string") entries.push(control);
			else malformed += 1;
		} catch {
			malformed += 1;
		}
	}
	return { entries, malformed, nextOffset: contents.length, clamped };
}

async function readControlOffset(runtimeDir: string, workerId: string): Promise<number> {
	try {
		const parsed = Number.parseInt(await readFile(offsetFileFor(runtimeDir, workerId), "utf8"), 10);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
	} catch {
		return 0;
	}
}

async function writeControlOffset(runtimeDir: string, workerId: string, offset: number): Promise<void> {
	await mkdir(join(runtimeDir, "controls"), { recursive: true, mode: 0o700 });
	await writeFile(offsetFileFor(runtimeDir, workerId), String(offset), { mode: 0o600 });
}

/** Acknowledge a control on the worker's own event stream so dispatchers can confirm delivery. */
async function acknowledgeControl(runtimeDir: string, workerId: string, ack: ControlAck): Promise<void> {
	await appendWorkerEvent(runtimeDir, workerId, "lifecycle", "control_ack", {
		id: ack.id,
		outcome: ack.outcome,
		...(ack.detail ? { detail: ack.detail.slice(0, 500) } : {}),
	});
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
	const extensionPath = process.env.PI_WORKERS_EXTENSION_PATH ?? fileURLToPath(import.meta.url);
	const runtimeDir = process.env.PI_WORKERS_RUNTIME_DIR || runtimeDirForRoot();
	const ownWorkerId = process.env.PI_WORKERS_WORKER_ID;
	const lockedConfig = configFromEnvironment();
	let currentModel: string | undefined;
	let controlTimer: ReturnType<typeof setInterval> | undefined;

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
		const task = `${params.name ? `[Worker: ${params.name}]\n` : ""}${params.task}`;
		const record: WorkerRecord = {
			id: workerId, parentId: parent?.id ?? null, depth, model: route.model, tag: params.tag, callerModel: caller, lineageRoutes,
			status: "starting", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
			sessionFile: sessionFileFor(runtimeDir, workerId), initialTask: task, initialTaskPersisted: false,
		};
		await writeRecord(runtimeDir, record);
		await appendWorkerEvent(runtimeDir, workerId, "lifecycle", "worker_created", { parentId: record.parentId, callerModel: caller, tag: params.tag, model: route.model, depth });
		await mkdir(join(runtimeDir, "sessions"), { recursive: true, mode: 0o700 });
		startWorkerProcess(ctx.cwd, runtimeDir, config, record, task, extensionPath);
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
				// The stable session path is assigned at creation; only fill it in if
				// an older record lacks one, never overwrite it.
				if (!record.sessionFile) record.sessionFile = ctx.sessionManager.getSessionFile();
				await writeRecord(runtimeDir, record);
				await appendWorkerEvent(runtimeDir, ownWorkerId, "lifecycle", "session_started", { sessionFile: record.sessionFile, pid: process.pid });
			}
			installGuestEventMap();
			let controlsOffset = await readControlOffset(runtimeDir, ownWorkerId);
			let polling = false;
			controlTimer = setInterval(() => {
				if (polling) return;
				polling = true;
				void (async () => {
					const read = await readAppliedControls(runtimeDir, ownWorkerId, controlsOffset);
					for (const control of read.entries) {
						try {
							if (control.type === "abort") {
								ctx.abort();
								await acknowledgeControl(runtimeDir, ownWorkerId, { id: control.id, outcome: "applied", detail: "abort requested" });
							} else if (control.type === "forward") {
								const cfg = lockedConfig ?? await loadRootConfig(ctx.cwd);
								await applyForwardControl(runtimeDir, ownWorkerId, control, { cwd: ctx.cwd, config: cfg, extensionPath });
							} else if (control.type === "prompt" && control.message) {
								pi.sendUserMessage(control.message, { deliverAs: control.delivery ?? "steer" });
								await acknowledgeControl(runtimeDir, ownWorkerId, { id: control.id, outcome: "applied", detail: `${control.delivery ?? "steer"} queued` });
							} else {
								await acknowledgeControl(runtimeDir, ownWorkerId, { id: control.id, outcome: "rejected", detail: `unsupported control type: ${control.type}` });
							}
						} catch (error) {
							await acknowledgeControl(runtimeDir, ownWorkerId, { id: control.id, outcome: "rejected", detail: error instanceof Error ? error.message : String(error) });
						}
					}
					if (read.malformed > 0) {
						await acknowledgeControl(runtimeDir, ownWorkerId, { id: `malformed-${read.nextOffset}`, outcome: "rejected", detail: `${read.malformed} malformed control line(s) skipped` });
					}
					if (read.entries.length > 0 || read.malformed > 0 || read.clamped) {
						controlsOffset = read.nextOffset;
						await writeControlOffset(runtimeDir, ownWorkerId, read.nextOffset);
					}
				})().catch(() => undefined).finally(() => { polling = false; });
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
		await stopWorkerProcesses();
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
		name: "workers_reply", label: "Workers: Reply",
		description: "Send a normal follow-up message to any worker, including a nested, finished, or errored one. Live workers queue it as a follow-up; ended workers resume on their own session first.",
		parameters: ReplyParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const config = await getConfig(ctx.cwd);
			const outcome = await deliverToWorker(runtimeDir, params.workerId, params.message, "reply", { cwd: ctx.cwd, config, extensionPath, ownWorkerId });
			if (outcome.kind === "rejected") throw new Error(outcome.detail);
			return textResult(outcome.detail, { workerId: params.workerId, outcome });
		},
	});

	pi.registerTool({
		name: "workers_steer", label: "Workers: Steer",
		description: "Send an instruction to any live worker, including a nested worker. 'steer' is delivered after its current tool batch; 'followUp' waits until it settles. Ended workers are rejected — use workers_reply to resume them.",
		parameters: SteerParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const config = await getConfig(ctx.cwd);
			const mode = params.delivery === "followUp" ? "reply" : "steer";
			const outcome = await deliverToWorker(runtimeDir, params.workerId, params.message, mode, { cwd: ctx.cwd, config, extensionPath, ownWorkerId });
			if (outcome.kind === "rejected") throw new Error(outcome.detail);
			return textResult(outcome.detail, { workerId: params.workerId, outcome });
		},
	});

	pi.registerCommand("workers", {
		description: "Manage workers: status [id|all], query <id>, listen <id> [cursor], spawn <tag> <task>, reply <id> <message>, steer <id> <message>, resume <id>, abort <id>",
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
			if (action === "steer" || action === "reply") {
				if (!first || rest.length === 0) throw new Error(`Usage: /workers ${action} <worker-id> <message>`);
				const config = await getConfig(ctx.cwd);
				const outcome = await deliverToWorker(runtimeDir, first, rest.join(" "), action, { cwd: ctx.cwd, config, extensionPath, ownWorkerId });
				if (outcome.kind === "rejected") throw new Error(outcome.detail);
				ctx.ui.notify(outcome.detail, outcome.kind === "resumed" ? "warning" : "info");
				return;
			}
			if (action === "resume") {
				if (!first) throw new Error("Usage: /workers resume <worker-id>");
				const record = await readRecord(runtimeDir, first);
				if (!record) throw new Error(`Unknown worker: ${first}`);
				const ownChild = record.parentId === ownWorkerId || (!ownWorkerId && record.parentId === null);
				if (!ownChild) throw new Error(`Worker ${first} is nested; use /workers reply ${first} <message> and its parent will resume it.`);
				const config = await getConfig(ctx.cwd);
				const resumed = await resumeWorker(runtimeDir, first, { cwd: ctx.cwd, config, extensionPath });
				ctx.ui.notify(`Resumed ${first} (attempt ${resumed.record.attempts ?? "?"}).`, "info");
				return;
			}
			if (action === "abort") {
				if (!first) throw new Error("Usage: /workers abort <worker-id>");
				await abortWorker(runtimeDir, first);
				ctx.ui.notify(`Abort requested for ${first}.`, "warning");
				return;
			}
			if (action === "spawn") {
				if (!first || rest.length === 0) throw new Error("Usage: /workers spawn <tag> <task>");
				const worker = await launchWorker({ tag: first, task: rest.join(" ") }, { cwd: ctx.cwd, model: ctx.model });
				ctx.ui.notify(worker ? `Worker started.\n${summarize(worker)}` : "Worker launch failed before a status record was available.", "info");
				return;
			}
			throw new Error("Usage: /workers status [id|all] | query <id> | listen <id> [cursor] | spawn <tag> <task> | reply <id> <message> | steer <id> <message> | resume <id> | abort <id>");
		},
	});
}

// Named exports for deterministic protocol tests (fixtures drive this module's
// process boundary without a real Pi child); the default export stays the
// extension factory.
export { abortWorker, acknowledgeControl, appendControl, applyForwardControl, channelForProcess, classifyUiRequest, controlFileFor, deliverToWorker, deliverUiAnswer, offsetFileFor, pendingDialogsFor, readAppliedControls, readControlOffset, readRecord, readWorkerEvents, registerPendingDialog, resolvePendingDialog, resumeWorker, sessionFileFor, startWorkerProcess, stopWorkerProcesses, workerInvocationArgs, writeControlOffset, writeRecord };