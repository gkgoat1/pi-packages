/**
 * Path helpers for File Guard.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

function globToRegex(pattern: string): RegExp {
	let regex = "";
	let i = 0;
	while (i < pattern.length) {
		const c = pattern[i];
		if (c === "*" && pattern[i + 1] === "*") {
			regex += ".*";
			i += 2;
		} else if (c === "*") {
			regex += "[^/]*";
			i++;
		} else if (c === "?") {
			regex += "[^/]";
			i++;
		} else if ("+.^$|()[]{}\\".includes(c)) {
			regex += "\\" + c;
			i++;
		} else {
			regex += c;
			i++;
		}
	}
	return new RegExp(`^${regex}$`);
}

export function globMatch(pattern: string, target: string): boolean {
	const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
	const normalizedTarget = target.replace(/\\/g, "/");
	const regex = globToRegex(normalizedPattern);
	if (regex.test(normalizedTarget)) return true;

	if (normalizedPattern.endsWith("/")) {
		const dirRegex = globToRegex(normalizedPattern + "**");
		if (dirRegex.test(normalizedTarget)) return true;
	}

	const asDir = normalizedPattern.endsWith("/") ? normalizedPattern : normalizedPattern + "/";
	const dirPrefixRegex = globToRegex(asDir + "**");
	if (dirPrefixRegex.test(normalizedTarget)) return true;

	return false;
}