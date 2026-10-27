/**
 * Workers — pi-durable entrypoint.
 *
 * Persistent nested subagents with strict caller-model routing, implemented
 * natively on durable primitives (the pi-coding-agent extension achieves the
 * same by spawning `pi` child processes):
 *
 * - A worker is a durable conversation owned by a background anchor task of
 *   the spawning conversation, so the parent's abort and idle waits never
 *   reach it (pattern after upstream test/examples/22-subagent-background.ts).
 * - Messages are delivered by background reporter tasks; request IDs make
 *   spawn/message/report idempotent across restarts, and reporters resume
 *   from their checkpoints after a crash.
 * - Routing is policy, never model input: `models[callerModel].workers[tag]`
 *   selects the child model; `maxDepth`, `maxWorkers`, and `maxPerLineage`
 *   bound recursion.
 *
 * The TUI dashboard and RPC bridging stay host-side (index.ts); durable state
 * is watchable, so a host UI can render the same tree from the workers doc
 * and the task graph.
 */

import {
	AssistantEntry,
	configure,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	LiveDoc,
	type ConversationId,
	type EntryId,
	type TaskId,
} from "@earendil-works/pi-durable";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";

// ─── Policy ──────────────────────────────────────────────────────────────────

export interface WorkerRoute {
	/** Child model as `provider/modelId`. */
	model: string;
	/** Maximum uses of this caller-model/tag route in one root → worker path. Default 1. */
	maxPerLineage?: number;
}

export interface WorkersDurablePolicy {
	maxDepth: number;
	maxWorkers: number;
	/** Every key is an exact caller `provider/modelId` and owns its own tag namespace. */
	models: Record<string, { workers: Record<string, WorkerRoute> }>;
}

export interface WorkersDurableOptions {
	/** Master switch; the extension's tools error until a policy enables it. Default disabled. */
	enabled?: boolean;
	policy?: WorkersDurablePolicy;
}

// ─── Durable state ───────────────────────────────────────────────────────────

export type WorkerRecord = {
	conversationId: ConversationId;
	tag: string;
	model: string;
	callerModel: string;
	/** Task that created the worker; a replayed spawn reuses it. */
	createdBy: TaskId;
	/** Answers already reported to the parent. */
	reported: EntryId[];
	/** Preview of the worker's latest answer, written by the reporter. */
	lastAnswer?: string;
};

export type WorkersDocState = {
	/** This conversation's own place in the tree; written at spawn time. Absent at the root. */
	self?: { depth: number; lineageRoutes: string[] };
	/** Workers this conversation spawned, keyed by worker id (the child conversation id). */
	workers: Record<string, WorkerRecord>;
	reporters: Record<string, TaskId>;
};

const WorkersDoc = defineDoc<WorkersDocState>({
	kind: "workers.registry",
	version: 1,
	scope: "conversation",
	history: "latest",
	// A fork starts without workers.
	fork: "initial",
	initial: () => ({ workers: {}, reporters: {} }),
	checkpointWhen: () => false,
});

// ─── Tasks ───────────────────────────────────────────────────────────────────

/** Background anchor: owns a worker conversation so the parent's Esc/idle waits never reach it. */
const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "workers.anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_anchor, runtime, taskContext) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), taskContext),
	},
	abort: (_anchor, runtime, taskContext) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

type ReporterInput = { worker: string; conversationId: ConversationId; message: string; followUp: boolean };
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };

function textOf(message: AssistantMessage | undefined): string {
	return (message?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
}

/** Delivers one message to a worker and reports the answer back to the parent conversation. */
const Reporter = defineTask<ReporterInput, ReporterState, null>({
	name: "workers.reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (reporter, runtime, taskContext) => {
			const { worker, conversationId, message, followUp } = reporter.input;
			const child = await runtime.conversation(conversationId, taskContext);
			if (!child) {
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "failed", error: { message: `worker ${worker} is gone` } } }),
					taskContext,
				);
				return;
			}
			const request = { type: "input", content: message, whenBusy: followUp ? "followUp" : "steer" } as const;
			const submission = await child.submit({ ...request, requestId: `workers:${reporter.id}` }, taskContext);
			const settled = await submission.wait(taskContext);
			await runtime.commit(async (tx) => {
				const next = (report?: string) => ({ status: "running", checkpoint: { phase: "report", report } }) as const;
				if (settled.status === "unanswered") {
					return next(settled.reason === "aborted" ? undefined : `[worker ${worker} failed: ${settled.reason}]`);
				}
				if (settled.type !== "input") return next();
				const state = await tx.doc(WorkersDoc, runtime.conversationId);
				const record = state.workers[worker];
				if (record && !record.reported.includes(settled.answer)) {
					record.reported.push(settled.answer);
					const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage;
					const text = textOf(answer);
					record.lastAnswer = text.length > 200 ? `${text.slice(0, 200)}…` : text;
					return next(`[worker ${worker} answered]\n${text}`);
				}
				return next();
			}, taskContext);
		},
		report: async (reporter, runtime, taskContext) => {
			const report = reporter.state.checkpoint.report;
			if (report !== undefined) {
				const parent = await runtime.conversation(runtime.conversationId, taskContext);
				if (parent) {
					const input = { type: "input", content: report, whenBusy: "followUp" } as const;
					await parent.submit({ ...input, requestId: `workers-report:${reporter.id}` }, taskContext);
				}
			}
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), taskContext);
		},
	},
	abort: (_reporter, runtime, taskContext) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

// ─── Tools ───────────────────────────────────────────────────────────────────

const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;

function parseModelRef(model: string): { provider: string; modelId: string } {
	const slash = model.indexOf("/");
	if (slash <= 0) throw new Error(`invalid model ref ${JSON.stringify(model)}: expected "provider/modelId"`);
	return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

export function createWorkersDurableExtension(options: WorkersDurableOptions = {}) {
	const enabled = options.enabled === true && options.policy !== undefined;
	const policy = options.policy;

	const requirePolicy = () => {
		if (!enabled || !policy) throw new Error("workers are disabled (createWorkersDurableExtension({ enabled: true, policy }))");
		return policy;
	};

	const spawn = defineTool({
		name: "workers_spawn",
		description:
			"Spawn a persistent background worker with the given routing tag. The policy of YOUR current model decides which model the worker runs; you never choose it. The worker gets your message as its task and reports its answer back when done.",
		parameters: Type.Object({
			tag: Type.String({ description: "Routing tag; your caller model's policy maps it to the worker model" }),
			task: Type.String({ description: "The worker's initial task" }),
		}),
		// Safe: a rerun after a crash finds the worker this call already created (createdBy) and returns it.
		replay: "safe",
		execute: async (args, api, callContext) => {
			const current = requirePolicy();
			const agent = await api.agent(callContext);
			if (!agent.model) throw new Error("this conversation has no model configured; workers need a caller model for routing");
			const callerModel = `${agent.model.provider}/${agent.model.modelId}`;
			const route = current.models[callerModel]?.workers[args.tag];
			if (!route) {
				throw new Error(`no workers route for caller model ${callerModel} and tag ${JSON.stringify(args.tag)}`);
			}

			const workerId = await api.commit(async (tx) => {
				const state = await tx.doc(WorkersDoc, api.conversationId);
				// Replay: this call already created a worker.
				const existing = Object.entries(state.workers).find(([, record]) => record.createdBy === api.taskId);
				if (existing) return existing[0];

				const self = state.self ?? { depth: 0, lineageRoutes: [] };
				if (self.depth + 1 > current.maxDepth) throw new Error(`workers depth limit ${current.maxDepth} reached`);
				if (Object.keys(state.workers).length >= current.maxWorkers) {
					throw new Error(`workers limit ${current.maxWorkers} reached for this conversation`);
				}
				const routeKey = `${callerModel}#${args.tag}`;
				const used = self.lineageRoutes.filter((key) => key === routeKey).length;
				if (used >= (route.maxPerLineage ?? 1)) {
					throw new Error(`route ${routeKey} already used ${used} time(s) on this lineage (maxPerLineage ${route.maxPerLineage ?? 1})`);
				}

				const anchor = await tx.createTask(Anchor, null, BACKGROUND);
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
				await configure(tx, child.id, {
					model: parseModelRef(route.model),
					instructions: `You are worker ${child.id} (tag "${args.tag}") of a parent agent. Answer its requests concisely; your answers are reported back automatically.`,
				});
				const workerId = String(child.id);
				state.workers[workerId] = {
					conversationId: child.id,
					tag: args.tag,
					model: route.model,
					callerModel,
					createdBy: api.taskId,
					reported: [],
				};
				// The child's own doc records its place in the tree for nested spawns.
				const childState = await tx.doc(WorkersDoc, child.id);
				childState.self = { depth: self.depth + 1, lineageRoutes: [...self.lineageRoutes, routeKey] };

				state.reporters[`spawn:${workerId}`] = await tx.createTask(
					Reporter,
					{ worker: workerId, conversationId: child.id, message: args.task, followUp: false },
					BACKGROUND,
				);
				return workerId;
			}, callContext);
			return {
				output: [{ type: "text", text: `Started worker ${workerId} (${route.model}, tag "${args.tag}"). It reports its answer back as a message.` }],
				details: { worker: workerId },
			};
		},
	});

	const send = (followUp: boolean) =>
		defineTool({
			name: followUp ? "workers_reply" : "workers_steer",
			description: followUp
				? "Queue a message for a worker after its current answer (starts a new run when it is idle)."
				: "Steer a running worker: the message joins its current work at the next step.",
			parameters: Type.Object({
				worker: Type.String({ description: "Worker id returned by workers_spawn" }),
				message: Type.String(),
			}),
			replay: "unsafe",
			execute: async (args, api, callContext) => {
				requirePolicy();
				await api.commit(async (tx) => {
					const state = await tx.doc(WorkersDoc, api.conversationId);
					const record = state.workers[args.worker];
					if (!record) throw new Error(`unknown worker ${args.worker}`);
					state.reporters[`${followUp ? "reply" : "steer"}:${api.taskId}`] = await tx.createTask(
						Reporter,
						{ worker: args.worker, conversationId: record.conversationId, message: args.message, followUp },
						BACKGROUND,
					);
				}, callContext);
				return { output: [{ type: "text", text: `${followUp ? "Queued for" : "Steering"} worker ${args.worker}.` }] };
			},
		});

	const query = defineTool({
		name: "workers_query",
		description: "List this conversation's workers with their status (working/idle), model, tag, and a preview of the latest answer.",
		parameters: Type.Object({ worker: Type.Optional(Type.String()) }),
		replay: "safe",
		execute: async (args, api, callContext) => {
			requirePolicy();
			const state = (await api.snapshot(WorkersDoc, api.conversationId, callContext)) ?? WorkersDoc.definition.initial();
			const ids = args.worker === undefined ? Object.keys(state.workers) : [args.worker];
			if (ids.length === 0) return { output: [{ type: "text", text: "No workers." }] };
			const lines: string[] = [];
			for (const id of ids) {
				const record = state.workers[id];
				if (!record) {
					lines.push(`${id}: unknown worker`);
					continue;
				}
				const busy = (await api.snapshot(LiveDoc, record.conversationId, callContext))?.run !== undefined;
				const preview = record.lastAnswer ? ` — ${record.lastAnswer}` : "";
				lines.push(`${id} [${record.tag} on ${record.model}]: ${busy ? "working" : "idle"}${preview}`);
			}
			return { output: [{ type: "text", text: lines.join("\n") }] };
		},
	});

	const stop = defineTool({
		name: "workers_stop",
		description: "Abort a worker's current work and queued messages. The worker conversation stays usable for later replies.",
		parameters: Type.Object({ worker: Type.String() }),
		replay: "unsafe",
		execute: async (args, api, callContext) => {
			requirePolicy();
			const state = (await api.snapshot(WorkersDoc, api.conversationId, callContext)) ?? WorkersDoc.definition.initial();
			const record = state.workers[args.worker];
			if (!record) throw new Error(`unknown worker ${args.worker}`);
			const child = await api.conversation(record.conversationId, callContext);
			await child?.abort(callContext);
			return { output: [{ type: "text", text: `Stopped worker ${args.worker}.` }] };
		},
	});

	return defineExtension({
		name: "workers",
		tasks: [Anchor, Reporter],
		tools: [spawn, send(false), send(true), query, stop],
		sections: enabled
			? [
					{
						key: "workers",
						render: () =>
							[
								"You can spawn persistent background workers with workers_spawn(tag, task).",
								"Routing is fixed by policy: your model's policy maps each tag to the worker's model; you never pass a model.",
								"Workers report their answers back as messages. Use workers_steer to redirect a running worker, workers_reply to queue a follow-up, workers_query for status, workers_stop to abort one.",
							].join("\n"),
					},
				]
			: undefined,
	});
}

export default createWorkersDurableExtension;
