/**
 * Brace-compression helpers for the allowed-path status display.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePath } from "./paths.ts";
import type { AllowedSet } from "./includes.ts";

interface SegmentNode {
	segment: string;
	children: SegmentNode[];
}

function buildSegmentTree(paths: string[]): SegmentNode[] {
	const roots: SegmentNode[] = [];
	for (const p of paths) {
		const parts = p.split(/[\\/]+/).filter(Boolean);
		if (parts.length === 0) continue;
		let level = roots;
		for (const segment of parts) {
			let node = level.find((n) => n.segment === segment);
			if (!node) {
				node = { segment, children: [] };
				level.push(node);
			}
			level = node.children;
		}
	}
	return roots;
}

function commonPrefix(strs: string[]): string {
	if (strs.length === 0) return "";
	let prefix = strs[0];
	for (const s of strs.slice(1)) {
		let i = 0;
		while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
		prefix = prefix.slice(0, i);
	}
	return prefix;
}

function renderTree(nodes: SegmentNode[]): string {
	if (nodes.length === 0) return "";
	nodes.sort((a, b) => a.segment.localeCompare(b.segment));
	const leaves = nodes.filter((n) => n.children.length === 0);
	const branches = nodes.filter((n) => n.children.length > 0);
	const parts: string[] = leaves.map((n) => n.segment);

	if (branches.length > 0) {
		const rendered = branches.map((n) => {
			const child = renderTree(n.children);
			return child ? `${n.segment}/${child}` : `${n.segment}/`;
		});
		if (rendered.length === 1) {
			parts.push(rendered[0]);
		} else {
			const prefix = commonPrefix(rendered);
			if (prefix.length > 0) {
				parts.push(`${prefix}{${rendered.map((r) => r.slice(prefix.length)).join(",")}}`);
			} else {
				parts.push(`{${rendered.join(",")}}`);
			}
		}
	}

	if (parts.length === 1) return parts[0];
	return `{${parts.join(",")}}`;
}

function* walkDir(dir: string, remaining: number): Generator<string> {
	if (remaining <= 0) return;
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".") && entry.name !== ".piinclude") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkDir(full, remaining - 1);
		} else {
			yield full;
			remaining--;
			if (remaining <= 0) return;
		}
	}
}

export function compressAllowedPaths(allowedSet: AllowedSet, cwd: string): string {
	const patterns = allowedSet.getAllowedPatterns();
	const resolved: string[] = [];
	for (const pattern of patterns) {
		const abs = normalizePath(pattern, cwd);
		try {
			const stat = fs.statSync(abs);
			if (stat.isDirectory()) {
				for (const f of walkDir(abs, 500)) {
					resolved.push(path.relative(cwd, f).replace(/\\/g, "/") || ".");
				}
			} else {
				resolved.push(path.relative(cwd, abs).replace(/\\/g, "/") || ".");
			}
		} catch {
			resolved.push(pattern.replace(/\\/g, "/"));
		}
	}

	const unique = [...new Set(resolved)].sort();
	if (unique.length === 0) return "";
	if (unique.length > 200) {
		return `{${unique.slice(0, 200).join(",")},... (${unique.length - 200} more)}`;
	}
	return renderTree(buildSegmentTree(unique));
}