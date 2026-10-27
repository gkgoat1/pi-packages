/**
 * Env relay end-to-end: a RelayedExecutionEnv over an in-memory linked
 * transport pair, served by a NodeExecutionEnv, plus FallbackExecutionEnv
 * behavior. Runs against the TypeScript sources (tsx).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
	createLinkedTransports,
	FallbackExecutionEnv,
	RelayConnectionError,
	RelayedExecutionEnv,
} from "../index.ts";
import { serveEnvRelay } from "../node.ts";

const context = BACKGROUND_CONTEXT;

async function setup(options: { token?: string; root?: string; readOnly?: boolean } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "env-relay-test-"));
	await writeFile(join(directory, "hello.txt"), "hello\nworld\n");
	const server = new NodeExecutionEnv({ cwd: directory });
	const [clientTransport, serverTransport] = createLinkedTransports();
	serveEnvRelay(server, serverTransport, { token: options.token, root: options.root ?? directory, readOnly: options.readOnly });
	const relay = new RelayedExecutionEnv({
		id: server.id,
		cwd: directory,
		token: options.token,
		connect: () => Promise.resolve(clientTransport),
	});
	return { directory, server, relay, clientTransport };
}

test("fs and exec round-trip through the relay", async () => {
	const { directory, relay, server } = await setup();
	try {
		const text = await relay.readTextFile("hello.txt", context);
		assert.ok(text.ok);
		assert.equal(text.ok ? text.value : undefined, "hello\nworld\n");

		const written = await relay.writeFile("new.txt", "fresh\n", context);
		assert.ok(written.ok);
		const exists = await relay.exists("new.txt", context);
		assert.ok(exists.ok && exists.value);

		const listing = await relay.listDir(".", context);
		assert.ok(listing.ok);
		assert.ok((listing.ok ? listing.value : []).some((f) => f.name === "hello.txt"));

		let streamed = "";
		const execResult = await relay.exec(["/bin/echo", "hi"], { onOutput: (t) => { streamed += t; } }, context);
		assert.ok(execResult.ok);
		assert.equal(execResult.ok ? execResult.value.exitCode : -1, 0);
		assert.match(streamed, /hi/);

		const reader = await relay.openBinaryReader("hello.txt", undefined, context);
		assert.ok(reader.ok);
		if (reader.ok) {
			const chunk = await reader.value.read(0, 5, context);
			assert.ok(chunk.ok);
			assert.equal(chunk.ok ? new TextDecoder().decode(chunk.value) : "", "hello");
			await reader.value.close(context);
		}
	} finally {
		await relay.cleanup(context);
		await server.cleanup(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test("the jail rejects paths outside the root", async () => {
	const { directory, relay, server } = await setup();
	try {
		const escaped = await relay.readTextFile("../outside.txt", context);
		assert.ok(!escaped.ok);
		assert.equal(escaped.ok ? undefined : escaped.error.code, "permission_denied");
	} finally {
		await relay.cleanup(context);
		await server.cleanup(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test("read-only mode rejects writes and exec", async () => {
	const { directory, relay, server } = await setup({ readOnly: true });
	try {
		const written = await relay.writeFile("nope.txt", "x", context);
		assert.ok(!written.ok);
		const execResult = await relay.exec(["/bin/echo", "hi"], undefined, context);
		assert.ok(!execResult.ok);
		assert.equal(execResult.ok ? undefined : execResult.error.code, "permission_denied");
	} finally {
		await relay.cleanup(context);
		await server.cleanup(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test("a wrong token fails the handshake", async () => {
	const directory = await mkdtemp(join(tmpdir(), "env-relay-auth-"));
	const server = new NodeExecutionEnv({ cwd: directory });
	const [clientTransport, serverTransport] = createLinkedTransports();
	serveEnvRelay(server, serverTransport, { token: "secret" });
	const relay = new RelayedExecutionEnv({
		id: server.id,
		cwd: directory,
		token: "wrong",
		connect: () => Promise.resolve(clientTransport),
	});
	await assert.rejects(() => relay.readTextFile("x", context), /unauthorized/);
	await rm(directory, { recursive: true, force: true });
});

test("cancellation aborts the call locally", async () => {
	const { directory, relay, server } = await setup();
	try {
		const { context: cancellable, cancel } = withCancel(context);
		const pending = relay.exec(["/bin/sleep", "30"], undefined, cancellable);
		cancel();
		const result = await pending;
		assert.ok(!result.ok);
		assert.equal(result.ok ? undefined : result.error.code, "aborted");
	} finally {
		await relay.cleanup(context);
		await server.cleanup(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test("FallbackExecutionEnv fails reads over and flips the circuit", async () => {
	const directory = await mkdtemp(join(tmpdir(), "env-relay-fallback-"));
	await writeFile(join(directory, "local.txt"), "local");
	const fallbackEnv = new NodeExecutionEnv({ cwd: directory });

	// A primary whose connect always fails.
	const broken = new RelayedExecutionEnv({
		id: "relay:broken",
		cwd: directory,
		connect: () => Promise.reject(new RelayConnectionError("no route to dev box")),
	});

	const switches: string[] = [];
	const env = new FallbackExecutionEnv({
		primary: broken,
		fallback: fallbackEnv,
		probeIntervalMs: 60_000,
		onSwitch: (active) => switches.push(active),
	});

	assert.equal(env.id, "relay:broken", "starts on the primary namespace");
	const text = await env.readTextFile("local.txt", context);
	assert.ok(text.ok, "read fails over to the fallback");
	assert.equal(text.ok ? text.value : undefined, "local");
	assert.deepEqual(switches, ["fallback"]);
	assert.equal(env.id, fallbackEnv.id, "id now reflects the fallback namespace");
	assert.equal(env.activeBackend, "fallback");
	await rm(directory, { recursive: true, force: true });
});
