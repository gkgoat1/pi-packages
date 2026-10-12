import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const fixturePath = join(root, "fixtures", "fake-rpc-worker.mjs");

/**
 * Spawn the fake RPC worker and collect every stdout JSONL record until the
 * predicate holds or the child exits. Received stdin commands land in the
 * trace file named by FAKE_RPC_TRACE.
 */
async function runFixture(commands, options = {}) {
	const directory = await mkdtemp(join(tmpdir(), "fake-rpc-worker-test-"));
	const traceFile = join(directory, "trace.jsonl");
	const proc = spawn(process.execPath, [fixturePath], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, FAKE_RPC_TRACE: traceFile },
	});
	const records = [];
	let buffer = "";
	proc.stdout.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let newline;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.trim()) records.push(JSON.parse(line));
		}
	});
	let stderr = "";
	proc.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
	for (const command of commands) proc.stdin.write(`${JSON.stringify(command)}\n`);
	if (options.closeStdin !== false) proc.stdin.end();
	const [code] = await once(proc, "exit");
	const trace = (await readFile(traceFile, "utf8").catch(() => ""))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	await rm(directory, { recursive: true, force: true });
	return { code, records, stderr, trace };
}

test("prompt responses carry the request id and settle after one run", async () => {
	const { code, records } = await runFixture([{ type: "prompt", id: "req-1", message: "hello" }]);
	assert.equal(code, 0);
	const response = records.find((record) => record.type === "response" && record.id === "req-1");
	assert.deepEqual(response?.data, { disposition: "started" });
	assert.ok(records.some((record) => record.type === "agent_start"), "agent_start precedes work");
	assert.ok(records.some((record) => record.type === "agent_end"), "agent_end closes the run");
	const settled = records.at(-1);
	assert.deepEqual(settled, { type: "agent_settled", aborted: false }, "agent_settled is the final automatic-work boundary");
});

test("steer and follow_up return distinct queued dispositions", async () => {
	const { records } = await runFixture([
		{ type: "prompt", id: "req-1", message: "start" },
		{ type: "steer", id: "req-2", message: "redirect" },
		{ type: "follow_up", id: "req-3", message: "after" },
	]);
	const steer = records.find((record) => record.type === "response" && record.id === "req-2");
	const followUp = records.find((record) => record.type === "response" && record.id === "req-3");
	assert.deepEqual(steer, { type: "response", id: "req-2", command: "steer", success: true, data: { disposition: "queued" } });
	assert.deepEqual(followUp, { type: "response", id: "req-3", command: "follow_up", success: true, data: { disposition: "queued" } });
	const queueUpdates = records.filter((record) => record.type === "queue_update");
	assert.ok(queueUpdates.length >= 2, "each queue change is reported");
});

test("a select dialog blocks until its matching extension_ui_response", async () => {
	const commands = [{ type: "prompt", id: "req-1", message: "emit-ui-dialogs" }];
	const directory = await mkdtemp(join(tmpdir(), "fake-rpc-worker-dialog-"));
	const traceFile = join(directory, "trace.jsonl");
	const proc = spawn(process.execPath, [fixturePath], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, FAKE_RPC_TRACE: traceFile },
	});
	const records = [];
	let buffer = "";
	let answered = false;
	proc.stdout.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let newline;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			const record = JSON.parse(line);
			records.push(record);
			if (record.type === "extension_ui_request" && record.method === "select" && !answered) {
				answered = true;
				proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, value: "Allow" })}\n`);
				proc.stdin.end();
			}
		}
	});
	proc.stdin.write(`${JSON.stringify(commands[0])}\n`);
	await once(proc, "exit");
	await rm(directory, { recursive: true, force: true });
	const resolved = records.find((record) => record.type === "fixture_ui_resolved" && record.method === "select");
	assert.equal(resolved?.value, "Allow", "the fixture reports the answer the client returned");
});

test("a stale extension_ui_response id is rejected without resolving other dialogs", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fake-rpc-worker-stale-"));
	const traceFile = join(directory, "trace.jsonl");
	const proc = spawn(process.execPath, [fixturePath], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, FAKE_RPC_TRACE: traceFile },
	});
	const records = [];
	let buffer = "";
	let sent = false;
	proc.stdout.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let newline;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			const record = JSON.parse(line);
			records.push(record);
			if (record.type === "extension_ui_request" && record.method === "select") {
				proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, cancelled: true })}\n`);
			}
			if (record.type === "extension_ui_request" && record.method === "confirm" && !sent) {
				sent = true;
				proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: "not-a-real-request", confirmed: true })}\n`);
				proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, cancelled: true })}\n`);
				proc.stdin.end();
			}
		}
	});
	proc.stdin.write(`${JSON.stringify({ type: "prompt", id: "req-1", message: "emit-ui-dialogs" })}\n`);
	await once(proc, "exit");
	await rm(directory, { recursive: true, force: true });
	const rejected = records.find((record) => record.type === "fixture_ui_response_rejected");
	assert.equal(rejected?.id, "not-a-real-request", "the unknown id is reported");
	const cancelled = records.find((record) => record.type === "fixture_ui_resolved" && record.method === "confirm");
	assert.deepEqual(cancelled?.cancelled, true, "the real dialog still resolves through its own id");
	assert.equal(cancelled?.value, undefined, "a cancelled confirm yields no confirmation value");
});

test("fire-and-forget UI records stream in method order without responses", async () => {
	const { records, trace } = await runFixture([{ type: "prompt", id: "req-1", message: "emit-ui-fire-and-forget" }]);
	const uiRecords = records.filter((record) => record.type === "extension_ui_request");
	assert.deepEqual(
		uiRecords.map((record) => record.method),
		["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"],
	);
	assert.equal(trace.filter((entry) => entry.type === "extension_ui_response").length, 0, "no response is expected or required");
});

test("abort responds successfully and settles the fixture as aborted", async () => {
	const { records } = await runFixture([
		{ type: "prompt", id: "req-1", message: "long-task" },
		{ type: "abort", id: "req-2" },
	]);
	const abort = records.find((record) => record.type === "response" && record.id === "req-2");
	assert.deepEqual(abort, { type: "response", id: "req-2", command: "abort", success: true });
	assert.deepEqual(records.at(-1), { type: "agent_settled", aborted: true });
});

test("a prompt during streaming without streamingBehavior is rejected", async () => {
	const { records } = await runFixture([
		{ type: "prompt", id: "req-1", message: "long-task" },
		{ type: "prompt", id: "req-2", message: "interrupt" },
	]);
	const rejected = records.find((record) => record.type === "response" && record.id === "req-2");
	assert.equal(rejected?.success, false);
	assert.match(rejected?.error ?? "", /streamingBehavior/);
});

test("the fixture exits non-zero on the test-only crash command", async () => {
	const { code, stderr } = await runFixture([{ type: "fixture_crash", id: "req-1" }], { closeStdin: false });
	assert.equal(code, 7);
	assert.match(stderr, /fixture crash requested/);
});
