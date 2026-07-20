/**
 * `.piinclude` loading and allowed-set management.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { expandHome, globMatch, normalizePath } from "./paths.ts";
import type { FileGuardConfig, LoadedSources, ModelIncludeMap, ModelRef, PersistedState } from "./types.ts";

function fileExists(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export function modelKey(model: ModelRef): string {
	return `${model.provider}/${model.id}`;
}

function lookupModelIncludeFiles(map: ModelIncludeMap, model: ModelRef | undefined): string[] | undefined {
	if (!model) return undefined;
	return map[modelKey(model)];
}

export function loadPiInclude(filePath: string, cwd: string): string[] {
	const absPath = normalizePath(filePath, cwd);
	const patterns: string[] = [];
	try {
		const content = fs.readFileSync(absPath, "utf-8");
		for (const line of content.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			patterns.push(expandHome(trimmed));
		}
	} catch {
		// Missing file is fine.
	}
	return patterns;
}

export class AllowedSet {
	private patterns: string[] = [];
	private resolvedDirs = new Set<string>();
	private explicitAllows = new Set<string>();
	private explicitDenials = new Set<string>();
	private dirty = false;
	private loadedSources: LoadedSources = {
		global: [],
		project: [],
		globalOverride: false,
		projectOverride: false,
	};

	constructor(
		private cwd: string,
		private config: FileGuardConfig,
	) {
		this.reload(undefined);
	}

	isDirty(): boolean {
		return this.dirty;
	}

	getLoadedSources(): LoadedSources {
		return { ...this.loadedSources };
	}

	reload(model: ModelRef | undefined): void {
		this.patterns = [];
		this.resolvedDirs.clear();
		this.loadedSources = {
			global: [],
			project: [],
			modelKey: model ? modelKey(model) : undefined,
			globalOverride: false,
			projectOverride: false,
		};

		const globalResult = this.loadTier(
			this.config.globalIncludeFiles,
			this.config.globalModelIncludeFiles,
			model,
		);
		this.loadedSources.global = globalResult.files;
		this.loadedSources.globalOverride = globalResult.usedModelTier;

		const projectResult = this.loadTier(
			this.config.projectIncludeFiles,
			this.config.projectModelIncludeFiles,
			model,
		);
		this.loadedSources.project = projectResult.files;
		this.loadedSources.projectOverride = projectResult.usedModelTier;
	}

	private loadTier(
		baseFiles: string[],
		modelMap: ModelIncludeMap,
		model: ModelRef | undefined,
	): { files: string[]; usedModelTier: boolean } {
		const modelFiles = lookupModelIncludeFiles(modelMap, model);
		const useModelTier =
			modelFiles !== undefined &&
			modelFiles.length > 0 &&
			modelFiles.some((p) => fileExists(normalizePath(p, this.cwd)));

		const filesToLoad = useModelTier ? modelFiles! : baseFiles;
		for (const file of filesToLoad) this.addPiInclude(file);
		return { files: filesToLoad, usedModelTier: useModelTier };
	}

	private addPiInclude(filePath: string): void {
		for (const p of loadPiInclude(filePath, this.cwd)) {
			this.patterns.push(p);
			const abs = normalizePath(p, this.cwd);
			try {
				const stat = fs.statSync(abs);
				if (stat.isDirectory()) {
					this.resolvedDirs.add(abs);
				}
			} catch {
				// Keep as glob.
			}
		}
	}

	recordDecision(pathOrPattern: string, allowed: boolean): void {
		if (allowed) {
			if (!this.explicitAllows.has(pathOrPattern)) this.dirty = true;
			this.explicitAllows.add(pathOrPattern);
			if (this.explicitDenials.delete(pathOrPattern)) this.dirty = true;
		} else {
			if (!this.explicitDenials.has(pathOrPattern)) this.dirty = true;
			this.explicitDenials.add(pathOrPattern);
			if (this.explicitAllows.delete(pathOrPattern)) this.dirty = true;
		}
	}

	isAllowed(inputPath: string): boolean {
		if (!inputPath) return true;
		const absPath = normalizePath(inputPath, this.cwd);

		if (this.explicitDenials.has(absPath) || this.explicitDenials.has(inputPath)) return false;
		if (this.explicitAllows.has(absPath) || this.explicitAllows.has(inputPath)) return true;

		for (const dir of this.resolvedDirs) {
			if (pathWithin(dir, absPath) || absPath === dir) return true;
		}

		for (const pattern of this.patterns) {
			if (globMatch(pattern, absPath)) return true;
			if (globMatch(pattern, inputPath)) return true;
			if (globMatch(pattern, path.basename(absPath))) return true;
		}

		return false;
	}

	isDenied(inputPath: string): boolean {
		if (!inputPath) return false;
		const absPath = normalizePath(inputPath, this.cwd);
		return this.explicitDenials.has(absPath) || this.explicitDenials.has(inputPath);
	}

	getAllowedPatterns(): string[] {
		return [...this.patterns, ...this.explicitAllows];
	}

	restore(state: PersistedState): void {
		for (const p of state.allowedPaths ?? []) this.explicitAllows.add(p);
		for (const p of state.deniedPaths ?? []) this.explicitDenials.add(p);
		this.dirty = false;
	}

	serialize(): PersistedState {
		this.dirty = false;
		return {
			allowedPaths: [...this.explicitAllows],
			deniedPaths: [...this.explicitDenials],
		};
	}
}

function pathWithin(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}