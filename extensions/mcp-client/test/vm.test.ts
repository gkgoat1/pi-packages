import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
	getGondolinHandle,
	GONDOLIN_SHARED_KEY,
	resolveRunInVm,
	VmMcpTransport,
	type GondolinHandle,
	type GuestProcess,
} from "../src/vm.ts";

// ---------------------------------------------------------------------------
// Symbol-keyed handle lookup
// ---------------------------------------------------------------------------

test("mcp-client getGondolinHandle reads the published symbol", () => {
	assert.equal(getGondolinHandle(), undefined);
	const handle: GondolinHandle = {
		version: 1,
		guestWorkspace: "/workspace",
		hostCwd: "/host",
		isEnabled: () => true,
		refreshTrust: () => true,
		ensureVm: async () => null,
		toGuestPath: () => "/workspace",
		execGuest: () => {
			throw new Error("not under test");
		},
	};
	(globalThis as Record<symbol, unknown>)[GONDOLIN_SHARED_KEY] = handle;
	try {
		assert.equal(getGondolinHandle(), handle);
		(globalThis as Record<symbol, unknown>)[GONDOLIN_SHARED_KEY] = { ...handle, version: 5 as unknown as 1 };
		assert.equal(getGondolinHandle(), undefined);
	} finally {
		delete (globalThis as Record<symbol, unknown>)[GONDOLIN_SHARED_KEY];
	}
});

test("mcp-client resolveRunInVm defaults to in-VM when Gondolin is active", () => {
	const handle: GondolinHandle = {
		version: 1,
		guestWorkspace: "/workspace",
		hostCwd: "/host",
		isEnabled: () => true,
		refreshTrust: () => true,
		ensureVm: async () => null,
		toGuestPath: () => "/workspace",
		execGuest: () => {
			throw new Error("not under test");
		},
	};
	assert.equal(resolveRunInVm(handle, undefined, undefined), true);
	assert.equal(resolveRunInVm(handle, false, undefined), false);
	assert.equal(resolveRunInVm(handle, true, false), false);
	assert.equal(resolveRunInVm(handle, false, true), true);
	assert.equal(resolveRunInVm(undefined, true, undefined), false);
	const disabled = { ...handle, isEnabled: () => false };
	assert.equal(resolveRunInVm(disabled, undefined, undefined), false);
});

// ---------------------------------------------------------------------------
// VmMcpTransport — JSON-RPC over a fake guest process
// ---------------------------------------------------------------------------

interface FakeGuestProcess extends GuestProcess {
	stdout: PassThrough;
	stderr: PassThrough;
	stdinChunks: string[];
	readonly ended: boolean;
	resultResolve: (result: { exitCode: number; stdout: string; stderr: string }) => void;
	resultReject: (error: Error) => void;
	abortSignal: AbortSignal | undefined;
}

function fakeGuestProcess(): FakeGuestProcess {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const stdinChunks: string[] = [];
	let ended = false;
	let resolveResult!: (result: { exitCode: number; stdout: string; stderr: string }) => void;
	let rejectResult!: (error: Error) => void;
	const result = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});
	const proc = {
		write: (data: string | Buffer) => {
			stdinChunks.push(typeof data === "string" ? data : data.toString("utf8"));
		},
		end: () => {
			ended = true;
		},
		stdout,
		stderr,
		result,
	} as FakeGuestProcess;
	Object.defineProperties(proc, {
		stdinChunks: { get: () => stdinChunks },
		ended: { get: () => ended },
	});
	proc.resultResolve = resolveResult;
	proc.resultReject = rejectResult;
	proc.abortSignal = undefined;
	return proc;
}

function fakeHandle(proc: FakeGuestProcess): GondolinHandle {
	return {
		version: 1,
		guestWorkspace: "/workspace",
		hostCwd: "/host",
		isEnabled: () => true,
		refreshTrust: () => true,
		ensureVm: async () => null,
		toGuestPath: (hostPath) => (hostPath.startsWith("/host") ? "/workspace" + hostPath.slice("/host".length) : undefined),
		execGuest: (spec) => {
			proc.abortSignal = spec.signal;
			return proc;
		},
	};
}

test("mcp-client VmMcpTransport frames JSON-RPC over the guest process", async () => {
	const proc = fakeGuestProcess();
	const transport = new VmMcpTransport(fakeHandle(proc), { command: "npx", args: ["-y", "server"] });

	const received: unknown[] = [];
	transport.onmessage = (message) => received.push(message);
	let closed = false;
	transport.onclose = () => {
		closed = true;
	};

	await transport.start();

	// stdout line → onmessage (newline-delimited JSON-RPC).
	proc.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })}\n`);
	await delay(0);
	assert.deepEqual(received, [{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);

	// send → serialized line written to the guest stdin.
	await transport.send({ jsonrpc: "2.0", id: 5, method: "ping" } as never);
	assert.deepEqual(proc.stdinChunks, [`${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" })}\n`]);

	// Process exit → onclose.
	proc.resultResolve({ exitCode: 0, stdout: "", stderr: "" });
	await delay(0);
	assert.equal(closed, true);
});

test("mcp-client VmMcpTransport reports non-zero exit with stderr tail", async () => {
	const proc = fakeGuestProcess();
	const transport = new VmMcpTransport(fakeHandle(proc), { command: "bad" });
	const errors: Error[] = [];
	transport.onerror = (error) => errors.push(error);
	let closed = false;
	transport.onclose = () => {
		closed = true;
	};

	await transport.start();
	proc.stderr.write("command not found: bad\n");
	proc.resultResolve({ exitCode: 127, stdout: "", stderr: "command not found: bad" });
	await delay(0);

	assert.equal(errors.length, 1);
	assert.equal(errors[0].message.includes("code 127"), true);
	assert.equal(errors[0].message.includes("command not found"), true);
	assert.equal(closed, true);
});

test("mcp-client VmMcpTransport close ends stdin and resolves", async () => {
	const proc = fakeGuestProcess();
	const transport = new VmMcpTransport(fakeHandle(proc), { command: "npx" });
	await transport.start();

	let closed = false;
	transport.onclose = () => {
		closed = true;
	};

	const closedPromise = transport.close();
	// stdin EOF was requested.
	assert.equal(proc.ended, true);
	// Resolve the guest result so close completes.
	proc.resultResolve({ exitCode: 0, stdout: "", stderr: "" });
	await closedPromise;
	assert.equal(closed, true);
});
