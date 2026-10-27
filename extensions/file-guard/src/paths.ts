/**
 * Path helpers for File Guard.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { globMatch } from "./paths-pure.ts";

export { globMatch };

export function expandHome(input: string): string {
	if (input === "~" || input.startsWith("~/")) {
		return path.join(os.homedir(), input.slice(1));
	}
	return input;
}

export function normalizePath(input: string, cwd: string): string {
	let p = expandHome(input);
	if (!path.isAbsolute(p)) {
		p = path.resolve(cwd, p);
	}
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

export function shortenPath(input: string, cwd: string): string {
	const home = os.homedir();
	if (path.isAbsolute(input) && pathWithin(cwd, input)) {
		return path.relative(cwd, input).replace(/\\/g, "/") || ".";
	}
	if (input.startsWith(home)) {
		return `~${input.slice(home.length)}`;
	}
	return input.replace(/\\/g, "/");
}

export function pathWithin(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}