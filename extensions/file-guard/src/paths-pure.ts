/**
 * Pure glob matching for File Guard — no Node imports, safe to bundle for
 * any runtime (durable harnesses, workers, browsers).
 */

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
