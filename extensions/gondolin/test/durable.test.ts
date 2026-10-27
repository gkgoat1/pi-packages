import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { GondolinExecutionEnv, createGondolinDurableExtension } from "../durable.ts";
import type { VM } from "@earendil-works/gondolin";

const context = BACKGROUND_CONTEXT;

/** Minimal in-memory fake of the VmFs/VM surface GondolinExecutionEnv uses. */
function fakeVm(initial: Record<string, string> = {}) {
	const files = new Map<string, Buffer>(Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)]));
	const statsFor = (path: string) => {
		const data = files.get(path);
		const isDir = data === undefined && [...files.keys()].some((k) => k.startsWith(`${path}/`));
		if (data === undefined && !isDir) {
			const error = new Error(`ENOENT: no such file or directory: ${path}`);
			(error as NodeJS.ErrnoException).code = "ENOENT";
			throw error;
		}
		return {
			isFile: () => data !== undefined,
			isDirectory: () => data === undefined,
			isSymbolicLink: () => false,
			size: data?.length ?? 0,
			mtimeMs: 1_700_000_000_000,
		};
	};
	const fs = {
		readFile: async (path: string, options?: { encoding?: BufferEncoding | null }) => {
			const data = files.get(path);
			if (data === undefined) {
				const error = new Error(`ENOENT: no such file or directory: ${path}`);
				(error as NodeJS.ErrnoException).code = "ENOENT";
				throw error;
			}
			return options?.encoding ? data.toString(options.encoding) : data;
		},
		writeFile: async (path: string, content: string | Buffer) => {
			files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content));
		},
		stat: async (path: string) => statsFor(path),
		access: async (path: string) => {
			statsFor(path);
		},
		listDir: async (path: string) => {
			const prefix = `${path}/`;
			const names = new Set<string>();
			for (const key of files.keys()) {
				if (!key.startsWith(prefix)) continue;
				names.add(key.slice(prefix.length).split("/")[0]);
			}
			return [...names];
		},
		mkdir: async () => {},
		rename: async (from: string, to: string) => {
			const data = files.get(from);
			if (data === undefined) throw new Error(`ENOENT: ${from}`);
			files.delete(from);
			files.set(to, data);
		},
		deleteFile: async (path: string) => {
			files.delete(path);
		},
	};
	const exec = (command: string | string[], _options?: unknown) => {
		const text = `ran:${Array.isArray(command) ? command.join(" ") : command}\n`;
		return {
			output: () =>
				(async function* () {
					yield { stream: "stdout" as const, data: Buffer.from(text), text };
				})(),
			result: Promise.resolve({ exitCode: 0 }),
		};
	};
	const vm = { id: "vm-test", fs, exec } as unknown as VM;
	return { vm, files };
}

test("file operations round-trip through the guest fs with cwd resolution", async () => {
	const { vm, files } = fakeVm({ "/work/a.txt": "hello\nworld\n" });
	const env = new GondolinExecutionEnv(vm, "/work");
	assert.equal(env.id, "gondolin:vm-test");

	const text = await env.readTextFile("a.txt", context);
	assert.ok(text.ok);
	assert.equal(text.ok ? text.value : undefined, "hello\nworld\n");

	const written = await env.writeFile("b.txt", "one", context);
	assert.ok(written.ok);
	const appended = await env.appendFile("b.txt", "two", context);
	assert.ok(appended.ok);
	assert.equal(files.get("/work/b.txt")?.toString(), "onetwo");

	const listing = await env.listDir(".", context);
	assert.ok(listing.ok);
	const names = (listing.ok ? listing.value : []).map((f) => f.name).sort();
	assert.deepEqual(names, ["a.txt", "b.txt"]);

	const missing = await env.readTextFile("nope.txt", context);
	assert.ok(!missing.ok);
	assert.equal(missing.ok ? undefined : missing.error.code, "not_found");

	const exists = await env.exists("a.txt", context);
	assert.ok(exists.ok && exists.value === true);
});

test("openBinaryReader scans lines over the whole file", async () => {
	const { vm } = fakeVm({ "/work/big.txt": "l0\nl1\nl2\nl3\n" });
	const env = new GondolinExecutionEnv(vm, "/work");
	const reader = await env.openBinaryReader("big.txt", undefined, context);
	assert.ok(reader.ok);
	if (!reader.ok) return;
	const scan = await reader.value.scanLines({ startLine: 1, endLine: 3 }, context);
	assert.ok(scan.ok);
	if (!scan.ok) return;
	const slice = await reader.value.read(scan.value.start, scan.value.end - scan.value.start, context);
	assert.ok(slice.ok);
	assert.equal(slice.ok ? new TextDecoder().decode(slice.value) : undefined, "l1\nl2");
	await reader.value.close(context);
});

test("exec streams output and reports the exit code", async () => {
	const { vm } = fakeVm();
	const env = new GondolinExecutionEnv(vm, "/work");
	let streamed = "";
	const result = await env.exec(["echo", "hi"], { onOutput: (text) => { streamed += text; } }, context);
	assert.ok(result.ok);
	assert.equal(result.ok ? result.value.exitCode : -1, 0);
	assert.match(streamed, /ran:echo hi/);
});

test("durable extension renders the sandbox section only when enabled", async () => {
	const config = {
		enabled: true,
		guestWorkspace: "/workspace",
		mounts: [],
		httpProxy: { enabled: true },
	} as unknown as Parameters<typeof createGondolinDurableExtension>[0];
	const extension = createGondolinDurableExtension(config, "/host");
	const render = extension.sections![0].render as (input: unknown, ctx: unknown) => Promise<string | undefined>;
	const text = await render({}, context);
	assert.match(text ?? "", /Gondolin sandbox/);
	assert.match(text ?? "", /gondolin-stub-/);

	const disabledConfig = { ...config, enabled: false };
	const disabled = createGondolinDurableExtension(disabledConfig, "/host");
	const renderDisabled = disabled.sections![0].render as (input: unknown, ctx: unknown) => Promise<string | undefined>;
	assert.equal(await renderDisabled({}, context), undefined);
});
