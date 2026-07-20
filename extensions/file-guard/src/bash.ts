/**
 * Bash command analysis for File Guard.
 */

const KNOWN_SAFE_COMMANDS = new Set([
	"echo",
	"printf",
	"pwd",
	"date",
	"uname",
	"whoami",
	"id",
	"groups",
	"hostname",
	"true",
	"false",
	"env",
	"printenv",
	"which",
	"command",
	"type",
	"exit",
]);

const READONLY_FILE_COMMANDS = new Set([
	"cat",
	"grep",
	"rg",
	"find",
	"ls",
	"head",
	"tail",
	"less",
	"more",
	"file",
	"stat",
	"du",
	"df",
	"wc",
	"sort",
	"uniq",
	"diff",
	"xargs", // conservative: often reads; could mutate, but commonly used with grep.
]);

const MUTATING_FILE_COMMANDS = new Set([
	"cp",
	"mv",
	"rm",
	"rmdir",
	"touch",
	"mkdir",
	"chmod",
	"chown",
	"chgrp",
	"ln",
	"tar", // can create archives
	"zip",
	"gzip",
	"gunzip",
]);

function splitShellCommands(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let escape = false;

	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		const next = command[i + 1];
		if (escape) {
			current += c;
			escape = false;
			continue;
		}
		if (c === "\\") {
			current += c;
			escape = true;
			continue;
		}
		if (c === "'" && !inDouble) {
			inSingle = !inSingle;
			current += c;
			continue;
		}
		if (c === '"' && !inSingle) {
			inDouble = !inDouble;
			current += c;
			continue;
		}
		if (!inSingle && !inDouble) {
			if ((c === "&" && next === "&") || (c === "|" && next === "|")) {
				segments.push(current.trim());
				current = "";
				i++;
				continue;
			}
			if (c === ";" || c === "|") {
				segments.push(current.trim());
				current = "";
				continue;
			}
		}
		current += c;
	}
	if (current.trim()) segments.push(current.trim());
	return segments.filter(Boolean);
}

function tokenizeSegment(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let escape = false;

	for (const c of segment) {
		if (escape) {
			current += c;
			escape = false;
			continue;
		}
		if (c === "\\") {
			current += c;
			escape = true;
			continue;
		}
		if (c === "'" && !inDouble) {
			inSingle = !inSingle;
			current += c;
			continue;
		}
		if (c === '"' && !inDouble && !inSingle) {
			inDouble = true;
			continue;
		}
		if (c === '"' && inDouble) {
			inDouble = false;
			continue;
		}
		if (!inSingle && !inDouble && /\s/.test(c)) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += c;
	}
	if (current) tokens.push(current);
	return tokens;
}

function stripQuotes(token: string): string {
	if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) {
		return token.slice(1, -1);
	}
	return token;
}

function looksLikePath(token: string): boolean {
	const stripped = stripQuotes(token);
	if (stripped.startsWith("/") || stripped.startsWith("./") || stripped.startsWith("../") || stripped.startsWith("~")) {
		return true;
	}
	if (stripped.includes("/")) return true;
	if (/\.[a-z0-9]{1,10}$/i.test(stripped)) return true;
	return false;
}

export interface CommandAnalysis {
	command: string;
	paths: string[];
	knownSafe: boolean;
	knownFile: boolean;
}

export function analyseCommand(command: string): CommandAnalysis[] {
	return splitShellCommands(command).map((segment) => {
		const tokens = tokenizeSegment(segment);
		const commandName = stripQuotes(tokens[0] ?? "").replace(/\.\.\//g, "").replace(/\.\//g, "");
		const paths: string[] = [];
		let skipNext = false;
		for (let i = 1; i < tokens.length; i++) {
			const token = tokens[i];
			if (!token) continue;
			if (skipNext) {
				skipNext = false;
				continue;
			}
			if (/^-[^=]*$/.test(token) && ["-e", "-E", "-c", "-m", "-v", "--version", "--help"].includes(token)) {
				continue;
			}
			if (/^-[^=]*$/.test(token) && i + 1 < tokens.length) {
				const next = stripQuotes(tokens[i + 1] ?? "");
				if (looksLikePath(next)) {
					paths.push(next);
					skipNext = true;
				}
				continue;
			}
			if (token.startsWith("-")) continue;
			const stripped = stripQuotes(token);
			if (looksLikePath(stripped)) {
				paths.push(stripped);
			}
		}
		return {
			command: commandName,
			paths: [...new Set(paths)],
			knownSafe: KNOWN_SAFE_COMMANDS.has(commandName),
			knownFile:
				READONLY_FILE_COMMANDS.has(commandName) ||
				MUTATING_FILE_COMMANDS.has(commandName),
		};
	});
}

export function getBashPaths(command: string): { paths: string[]; shouldPrompt: boolean; reason: string } {
	const analyses = analyseCommand(command);
	const paths: string[] = [];
	const reasons: string[] = [];

	for (const a of analyses) {
		for (const p of a.paths) paths.push(p);
		if (a.knownSafe && a.paths.length === 0) continue;
		if (READONLY_FILE_COMMANDS.has(a.command)) {
			reasons.push(`${a.command} reads files`);
		} else if (MUTATING_FILE_COMMANDS.has(a.command)) {
			reasons.push(`${a.command} may modify files`);
		} else if (!a.knownSafe) {
			reasons.push(`${a.command} is not a known-safe command`);
		}
	}

	return {
		paths: [...new Set(paths)],
		shouldPrompt: reasons.length > 0,
		reason: reasons.join("; ") || "bash command may touch files",
	};
}

export { looksLikePath };