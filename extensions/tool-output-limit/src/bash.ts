import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolOutputLimitConfig } from "./config.ts";
import { limitsFor } from "./config.ts";
import { StreamingOutput } from "./streaming-output.ts";

const schema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

function resultText(snapshot: Awaited<ReturnType<StreamingOutput["snapshot"]>>): string {
	let text = snapshot.content || "(no output)";
	if (snapshot.truncation.truncated) {
		text += `\n\n[Output truncated: showing ${snapshot.truncation.outputLines} of ${snapshot.truncation.totalLines} lines; full output: ${snapshot.fullOutputPath}]`;
	}
	return text;
}

export function registerBashOverride(pi: ExtensionAPI, config: ToolOutputLimitConfig): void {
	const limits = limitsFor(config, "bash");
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: "Execute bash commands. Output limits are configured by tool-output-limit; full output is retained in a private temporary file.",
		parameters: schema,
		async execute(_id, { command, timeout }, signal, onUpdate, ctx) {
			const output = await StreamingOutput.create(limits, config.tempOutput.directory);
			const child = spawn(process.env.SHELL || "/bin/bash", ["-lc", command], {
				cwd: ctx.cwd,
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			let timedOut = false;
			const kill = () => {
				if (!child.pid) return;
				if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			};
			const timer = timeout === undefined ? undefined : setTimeout(() => { timedOut = true; kill(); }, timeout * 1000);
			const onAbort = () => kill();
			signal?.addEventListener("abort", onAbort, { once: true });
			child.stdout?.on("data", (data: Buffer) => { output.append(data); onUpdate?.({ content: [{ type: "text", text: output.snapshot().content }], details: {} }); });
			child.stderr?.on("data", (data: Buffer) => { output.append(data); onUpdate?.({ content: [{ type: "text", text: output.snapshot().content }], details: {} }); });
			const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			await output.close();
			if (signal?.aborted) throw new Error("aborted");
			if (timedOut) throw new Error(`timeout:${timeout}`);
			const snapshot = output.snapshot();
			return { content: [{ type: "text" as const, text: resultText(snapshot) }], details: { exitCode, truncation: snapshot.truncation, fullOutputPath: snapshot.fullOutputPath } };
		},
	});
}
