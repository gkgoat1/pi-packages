import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { StreamingOutput } from "../src/streaming-output.ts";

test("retains a UTF-8-safe tail and records complete output", async () => {
	const output = await StreamingOutput.create({ maxBytes: 20, maxLines: 2, hardMaxBytes: 100 });
	output.append(Buffer.from("first\nééé\nlast\n"));
	await output.close();
	const snapshot = output.snapshot();
	assert.equal(snapshot.content, "ééé\nlast");
	assert.equal(snapshot.truncation.truncated, true);
	assert.equal(snapshot.truncation.truncatedBy, "lines");
	assert.equal(await readFile(snapshot.fullOutputPath!, "utf8"), "first\nééé\nlast\n");
	await output.remove();
});

test("honors the hard cap when configured limits are unlimited", async () => {
	const output = await StreamingOutput.create({ maxBytes: null, maxLines: null, hardMaxBytes: 5 });
	output.append("abcdef");
	await output.close();
	const snapshot = output.snapshot();
	assert.equal(snapshot.content, "bcdef");
	assert.equal(snapshot.truncation.truncated, true);
	assert.equal(snapshot.truncation.truncatedBy, "bytes");
	await output.remove();
});
