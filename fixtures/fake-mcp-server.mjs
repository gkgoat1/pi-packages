#!/usr/bin/env node
/**
 * Minimal MCP stdio server fixture (newline-delimited JSON-RPC).
 * No network, no credentials — just enough of the protocol for Pi's built-in
 * MCP client to connect, list one tool, and call it.
 */
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function result(id, value) {
	write({ jsonrpc: "2.0", id, result: value });
}

function handle(message) {
	if (message.id === undefined) return; // notifications need no response
	switch (message.method) {
		case "initialize":
			result(message.id, {
				protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "fake-local", version: "0.0.1" },
			});
			break;
		case "ping":
			result(message.id, {});
			break;
		case "tools/list":
			result(message.id, {
				tools: [{
					name: "fake_echo",
					description: "Echo the input text (test fixture)",
					inputSchema: { type: "object", properties: { text: { type: "string" } } },
				}],
			});
			break;
		case "tools/call":
			result(message.id, { content: [{ type: "text", text: `echo: ${message.params?.arguments?.text ?? ""}` }] });
			break;
		default:
			result(message.id, {});
	}
}

let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	let newline;
	while ((newline = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (!line.trim()) continue;
		try {
			handle(JSON.parse(line));
		} catch (error) {
			process.stderr.write(`fake-mcp-server: ${error instanceof Error ? error.message : String(error)}\n`);
		}
	}
});
process.stdin.on("end", () => process.exit(0));
