#!/usr/bin/env node
/**
 * Deterministic fake Pi RPC worker for protocol tests.
 *
 * Speaks the documented Pi 1.1 RPC subprotocols over stdin/stdout JSONL:
 * command/response records, session events, and the extension UI subprotocol.
 * It never calls a model and never touches the network. Every inbound record
 * is traced to the file named by FAKE_RPC_TRACE so tests can assert on the
 * exact commands a client sent.
 */
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const traceFile = process.env.FAKE_RPC_TRACE;
const write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const trace = (record) => {
	if (traceFile) appendFileSync(traceFile, `${JSON.stringify(record)}\n`);
};

let streaming = false;
let stdinEnded = false;
let dialogSequence = Promise.resolve();
const pendingDialogs = new Map(); // id -> { method, resolve }

function respond(command, id, success, dataOrError) {
	write({
		type: "response",
		...(id !== undefined ? { id } : {}),
		command,
		success,
		...(success ? (dataOrError !== undefined ? { data: dataOrError } : {}) : { error: String(dataOrError) }),
	});
}

function settle(aborted) {
	streaming = false;
	write({ type: "agent_end", messages: [], willRetry: false });
	write({ type: "agent_settled", aborted });
}

function runEcho(message) {
	streaming = true;
	write({ type: "agent_start" });
	write({ type: "message_end", message: { role: "user", content: message, timestamp: Date.now() } });
	write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `echo: ${message}` }], timestamp: Date.now() } });
	settle(false);
}

function requestUi(method, fields) {
	const id = randomUUID();
	write({ type: "extension_ui_request", id, method, ...fields });
	return id;
}

function awaitDialog(method, fields) {
	if (stdinEnded) return Promise.resolve({ cancelled: true, value: undefined });
	const id = requestUi(method, fields);
	return new Promise((resolve) => pendingDialogs.set(id, { method, resolve }));
}

async function runDialogSequence() {
	const select = await awaitDialog("select", { title: "Allow dangerous command?", options: ["Allow", "Block"], timeout: 60_000 });
	write({ type: "fixture_ui_resolved", method: "select", ...select });
	const confirm = await awaitDialog("confirm", { title: "Clear session?", message: "All messages will be lost." });
	write({ type: "fixture_ui_resolved", method: "confirm", ...confirm });
	const input = await awaitDialog("input", { title: "Enter a value", placeholder: "type something..." });
	write({ type: "fixture_ui_resolved", method: "input", ...input });
	const editor = await awaitDialog("editor", { title: "Edit some text", prefill: "Line 1\nLine 2" });
	write({ type: "fixture_ui_resolved", method: "editor", ...editor });
	settle(false);
}

function runFireAndForget() {
	requestUi("notify", { message: "Command blocked by user", notifyType: "warning" });
	requestUi("setStatus", { statusKey: "fake-worker", statusText: "Turn 3 running..." });
	requestUi("setWidget", { widgetKey: "fake-worker", widgetLines: ["--- Fake Widget ---", "Line 1"], widgetPlacement: "aboveEditor" });
	requestUi("setTitle", { title: "pi - fake worker" });
	requestUi("set_editor_text", { text: "prefilled text for the user" });
	write({ type: "agent_start" });
	settle(false);
}

function handlePrompt(command) {
	if (streaming && command.streamingBehavior === undefined) {
		respond(command.type, command.id, false, "Agent is already streaming; specify streamingBehavior ('steer' or 'followUp')");
		return;
	}
	if (streaming) {
		respond(command.type, command.id, true, { disposition: "queued" });
		return;
	}
	respond(command.type, command.id, true, { disposition: "started" });
	const message = String(command.message ?? "");
	if (message === "emit-ui-dialogs") {
		streaming = true;
		write({ type: "agent_start" });
		dialogSequence = dialogSequence.then(runDialogSequence);
	} else if (message === "emit-ui-fire-and-forget") {
		runFireAndForget();
	} else if (message === "long-task") {
		streaming = true;
		write({ type: "agent_start" });
		// Stays open until abort or stdin end.
	} else {
		runEcho(message);
	}
}

function handleRecord(record) {
	trace(record);
	switch (record.type) {
		case "prompt":
			handlePrompt(record);
			break;
		case "steer":
			respond("steer", record.id, true, { disposition: "queued" });
			write({ type: "queue_update", steering: [String(record.message ?? "")], followUp: [] });
			break;
		case "follow_up":
			respond("follow_up", record.id, true, { disposition: "queued" });
			write({ type: "queue_update", steering: [], followUp: [String(record.message ?? "")] });
			break;
		case "abort":
			respond("abort", record.id, true);
			if (streaming) settle(true);
			else write({ type: "agent_settled", aborted: true });
			break;
		case "get_state":
			respond("get_state", record.id, true, {
				sessionId: "fake-session",
				sessionFile: "/tmp/fake-rpc-worker-session.jsonl",
				isStreaming: streaming,
				pendingMessageCount: 0,
			});
			break;
		case "extension_ui_response": {
			const pending = pendingDialogs.get(record.id);
			if (!pending) {
				write({ type: "fixture_ui_response_rejected", id: record.id ?? null });
				break;
			}
			pendingDialogs.delete(record.id);
			pending.resolve(record.cancelled === true
				? { cancelled: true, value: undefined }
				: { cancelled: false, value: record.value ?? record.confirmed });
			break;
		}
		case "fixture_crash":
			process.stderr.write("fixture crash requested\n");
			process.exit(7);
			break;
		default:
			respond(record.type ?? "unknown", record.id, false, `Unknown command: ${String(record.type)}`);
	}
}

let buffer = "";
process.stdin.on("data", (chunk) => {
	// Strict JSONL framing: split only on LF per the RPC protocol.
	buffer += chunk.toString("utf8");
	let newline;
	while ((newline = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (!line.trim()) continue;
		try {
			handleRecord(JSON.parse(line));
		} catch (error) {
			respond("parse", undefined, false, `Failed to parse command: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
});

process.stdin.on("end", async () => {
	// Unanswered dialogs cancel when the client goes away, mirroring Pi's
	// timeout/cancellation behavior. The flag is sticky so dialogs created
	// later in an in-flight sequence cancel immediately instead of hanging.
	stdinEnded = true;
	for (const [id, pending] of pendingDialogs) {
		pendingDialogs.delete(id);
		pending.resolve({ cancelled: true, value: undefined });
	}
	await dialogSequence;
	if (streaming) settle(false);
	process.exit(0);
});
