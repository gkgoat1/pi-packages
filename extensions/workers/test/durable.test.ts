/**
 * End-to-end test of the workers durable entrypoint on MemoryStorage with the
 * faux provider: a parent conversation spawns a worker, the worker answers,
 * and the answer is reported back to the parent.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createWorkersDurableExtension } from "../durable.ts";

const context = BACKGROUND_CONTEXT;

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("timed out waiting for condition");
}

test("spawn → worker answers → answer reported back to the parent", async () => {
	const models = createModels();
	const faux = fauxProvider({ tokensPerSecond: 0 });
	models.setProvider(faux.provider);

	// Script: the parent spawns a worker on the trigger phrase, answers plainly
	// otherwise; the worker (same faux model, sees the task text) answers it.
	// Each request consumes one queued step, so queue the route generously.
	const route = (request: { messages: Array<{ role: string; content: unknown }> }) => {
		let last = request.messages[request.messages.length - 1];
		for (let i = request.messages.length - 1; i >= 0; i--) {
			if (request.messages[i].role !== "system") {
				last = request.messages[i];
				break;
			}
		}
		const content = typeof last?.content === "string" ? last.content : "";
		const parts = Array.isArray(last?.content) ? last.content : [];
		const text =
			content ||
			parts.flatMap((p: { type: string; text?: string }) => (p.type === "text" ? [p.text ?? ""] : [])).join("");
		if (text.includes("Start a worker")) {
			return fauxAssistantMessage([fauxToolCall("workers_spawn", { tag: "helper", task: "What is 2+2?" })], { stopReason: "toolUse" });
		}
		if (text.includes("What is 2+2?")) return fauxAssistantMessage([fauxText("4")]);
		return fauxAssistantMessage([fauxText("acknowledged")]);
	};
	faux.setResponses(Array.from({ length: 40 }, () => route));

	const registry = createRegistry();
	registry.install(
		createWorkersDurableExtension({
			enabled: true,
			policy: {
				maxDepth: 2,
				maxWorkers: 4,
				models: { "faux/faux-1": { workers: { helper: { model: "faux/faux-1" } } } },
			},
		}),
	);

	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const submission = await root.submit({ type: "input", content: "Start a worker please" }, context);
		const settled = await submission.wait(context);
		assert.equal(settled.status, "done");

		// The worker answers and the reporter posts the answer back to the parent.
		await waitFor(async () => {
			const view = await root.context(context);
			return JSON.stringify(view).includes("[worker") && JSON.stringify(view).includes("4");
		});

		// The parent's doc records the worker and its reported answer.
		const report = await root.context(context);
		const serialized = JSON.stringify(report);
		assert.match(serialized, /worker 4|4/);
	} finally {
		await harness.close(context);
	}
});

test("routing is policy: unknown tags and unlisted caller models are rejected", async () => {
	const models = createModels();
	const faux = fauxProvider({ tokensPerSecond: 0 });
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("workers_spawn", { tag: "nope", task: "hi" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("understood")]),
	]);
	const registry = createRegistry();
	registry.install(
		createWorkersDurableExtension({
			enabled: true,
			policy: { maxDepth: 1, maxWorkers: 2, models: { "faux/faux-1": { workers: { helper: { model: "faux/faux-1" } } } } },
		}),
	);
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const submission = await root.submit({ type: "input", content: "spawn" }, context);
		const settled = await submission.wait(context);
		assert.equal(settled.status, "done");
		const view = await root.context(context);
		assert.match(JSON.stringify(view), /no workers route/);
	} finally {
		await harness.close(context);
	}
});

test("disabled extension refuses to spawn", async () => {
	const models = createModels();
	const faux = fauxProvider({ tokensPerSecond: 0 });
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("workers_spawn", { tag: "helper", task: "hi" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("understood")]),
	]);
	const registry = createRegistry();
	registry.install(createWorkersDurableExtension({}));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const settled = await (await root.submit({ type: "input", content: "spawn" }, context)).wait(context);
		assert.equal(settled.status, "done");
		const view = await root.context(context);
		assert.match(JSON.stringify(view), /workers are disabled/);
	} finally {
		await harness.close(context);
	}
});
