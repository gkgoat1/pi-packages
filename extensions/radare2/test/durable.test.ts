import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { ok } from "@earendil-works/pi-durable/env";
import { createRadare2DurableExtension, r2OneshotArgv } from "../durable.ts";

const context = BACKGROUND_CONTEXT;

// The extension's tools array intersects every tool's parameter schema; each
// test drives one tool, so narrow to a loose per-tool execute signature.
interface LooseTool {
	replay?: string;
	execute(args: never, api: unknown, context: unknown): Promise<{ output?: Array<{ type: string; text?: string }> }>;
}
const asTool = (tool: unknown): LooseTool => tool as LooseTool;

test("r2OneshotArgv never emits hanging analysis variants and always quits", () => {
	const argv = r2OneshotArgv("/bin/ls", ["aaa", "aflj"], "r2", ["bin.cache=true"]);
	assert.deepEqual(argv.slice(0, 3), ["r2", "-q", "-N"]);
	assert.ok(argv.includes("bin.relocs.apply=true"));
	assert.deepEqual(argv.slice(-4), ["-c", "q", "--", "/bin/ls"]);
	assert.ok(!argv.some((a) => /aaj|aaaj/.test(a)), "never aaj/aaaj");
});

test("r2_functions filters and formats the aflj reply", async () => {
	const extension = createRadare2DurableExtension();
	const tool = asTool(extension.tools!.find((t) => t.name === "r2_functions")!);
	const payload = JSON.stringify([
		{ name: "main", realsz: 42 },
		{ name: "helper", realsz: 10 },
	]);
	const env = {
		exec: async (_c: unknown, o?: { onOutput?: (t: string) => void }) => {
			o?.onOutput?.(payload);
			return ok({ exitCode: 0 });
		},
	} as unknown as ExecutionEnv;
	const result = await tool.execute({ path: "/bin/x", filter: "mai" } as never, { env }, context);
	const first = result.output?.[0];
	const text = first?.type === "text" ? first.text ?? "" : "";
	assert.match(text, /functions: 1/);
	assert.match(text, /main \(size 42\)/);
	assert.ok(!text.includes("helper"));
});

test("r2 tools fail with an error result when no environment is wired", async () => {
	const extension = createRadare2DurableExtension();
	const tool = asTool(extension.tools!.find((t) => t.name === "r2_functions")!);
	await assert.rejects(() => tool.execute({ path: "/bin/x" } as never, { env: undefined }, context), /execution environment/);
});

test("r2_cmd rejects newlines and is not replay-safe", async () => {
	const extension = createRadare2DurableExtension();
	const tool = asTool(extension.tools!.find((t) => t.name === "r2_cmd")!);
	assert.notEqual(tool.replay, "safe");
	await assert.rejects(
		() => tool.execute({ path: "/bin/x", command: "aaa\ns main" } as never, { env: {} }, context),
		/newlines/,
	);
});

test("r2_xrefs passes direction and sanitizes the target", async () => {
	const extension = createRadare2DurableExtension();
	const tool = asTool(extension.tools!.find((t) => t.name === "r2_xrefs")!);
	let seen: string[] = [];
	const env = {
		exec: async (command: unknown, o?: { onOutput?: (t: string) => void }) => {
			seen = command as string[];
			o?.onOutput?.("[]");
			return ok({ exitCode: 0 });
		},
	} as unknown as ExecutionEnv;
	await tool.execute({ path: "/bin/x", target: "main`whoami`", direction: "to" } as never, { env }, context);
	const commands = seen.join(" ");
	assert.ok(commands.includes("axtj @ mainwhoami"), "backticks stripped");
	assert.ok(!commands.includes("`"));
});
