/**
 * Output policy for the radare2 extension.
 *
 * Per the resolved design, commands are NOT restricted at the policy layer:
 * the OS sandbox (Seatbelt/bwrap/Gondolin) is the enforcement mechanism.
 * This module only provides defense-in-depth *tagging* (write ops are marked
 * in tool details for transcripts/auditing) and output truncation.
 */

/** r2 write-command families (first token, before any `*`/`+` modifiers). */
const WRITE_PREFIXES = [
	"w", // w, w1, w2, wa, wao, wc, wd, we, wf, wg, wi, wk, wl, wm, wo, wp, wr, ws, wt, wu, wv, wx, wz
];

/** Tokenize an r2 command the way r2 does: up to the first space or `@`. */
export function r2CommandToken(command: string): string {
	const stripped = command.trim().replace(/^[-+]/, "");
	const match = /^(?:[!#$%&'.0-9:<>?@a-z|~]|\*)+/i.exec(stripped);
	return match ? match[0].toLowerCase() : stripped.toLowerCase();
}

/** Heuristic write-op detection for `details.writeOp` tagging. */
export function isWriteCommand(command: string): boolean {
	const segments = command.split(";").map((part) => part.trim()).filter(Boolean);
	return segments.some((segment) => {
		const token = r2CommandToken(segment);
		if (token === "") return false;
		if (WRITE_PREFIXES.some((prefix) => token.startsWith(prefix))) return true;
		return false;
	});
}

/** Head+tail truncation with an explicit marker. */
export function truncateOutput(
	text: string,
	maxBytes: number,
): { text: string; truncated: boolean } {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= maxBytes) return { text, truncated: false };
	const half = Math.floor(maxBytes / 2);
	let head = text.slice(0, half);
	let tail = text.slice(-half);
	while (Buffer.byteLength(head, "utf8") > half) head = head.slice(0, -256);
	while (Buffer.byteLength(tail, "utf8") > half) tail = tail.slice(256);
	return {
		text: `${head}\n\n[... output truncated (${bytes} bytes total, showing first/last ~${half} bytes) ...]\n\n${tail}`,
		truncated: true,
	};
}
