/**
 * Batched permission prompt queue.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AllowedSet } from "./includes.ts";
import type { GuardRequest } from "./types.ts";

export class PromptQueue {
	private current: GuardRequest[] = [];
	private processing = false;
	private postponed: GuardRequest[] = [];

	constructor(
		private ctx: ExtensionContext,
		private allowedSet: AllowedSet,
	) {}

	request(toolName: string, description: string, paths: string[], contextSummary?: string): Promise<boolean> {
		return new Promise((resolve) => {
			this.add({
				id: `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				toolName,
				description,
				contextSummary,
				paths: [...paths],
				resolve,
			});
		});
	}

	requestCallback(
		toolName: string,
		description: string,
		paths: string[],
		callback: (allowed: boolean) => void,
		contextSummary?: string,
	): void {
		this.add({
			id: `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			toolName,
			description,
			contextSummary,
			paths: [...paths],
			resolve: callback,
		});
	}

	private add(req: GuardRequest): void {
		if (this.processing) {
			this.postponed.push(req);
		} else {
			this.current.push(req);
			void this.process();
		}
	}

	private async process(): Promise<void> {
		if (this.processing || this.current.length === 0) return;
		this.processing = true;

		const batch = this.current;
		this.current = [];
		const { ctx, allowedSet } = this;

		if (!ctx.hasUI) {
			for (const req of batch) {
				for (const p of req.paths) allowedSet.recordDecision(p, false);
				req.resolve(false);
			}
			this.finishBatch();
			return;
		}

		const lines = batch.map((req, i) => {
			const ctxLine = req.contextSummary ? `\n    ${req.contextSummary}` : "";
			return `${i + 1}. ${req.description}${ctxLine}`;
		});
		const toggles = new Array<boolean>(batch.length).fill(false);
		const buildOptions = () => {
			const itemOptions = lines.map((line, i) => {
				const marker = toggles[i] ? "[x]" : "[ ]";
				return `${marker} ${line}`;
			});
			return ["✓ Confirm selections", "Allow all", "Deny all", ...itemOptions];
		};

		while (true) {
			const choice = await ctx.ui.select("File Guard: allow agent access?", buildOptions());
			if (choice === undefined || choice === "Deny all") {
				for (const req of batch) {
					for (const p of req.paths) allowedSet.recordDecision(p, false);
					req.resolve(false);
				}
				break;
			}
			if (choice === "Allow all") {
				for (const req of batch) {
					for (const p of req.paths) allowedSet.recordDecision(p, true);
					req.resolve(true);
				}
				break;
			}
			if (choice === "✓ Confirm selections") {
				for (let i = 0; i < batch.length; i++) {
					const req = batch[i];
					for (const p of req.paths) allowedSet.recordDecision(p, toggles[i]);
					req.resolve(toggles[i]);
				}
				break;
			}
			const toggleIndex = buildOptions().indexOf(choice) - 3;
			if (toggleIndex >= 0 && toggleIndex < batch.length) {
				toggles[toggleIndex] = !toggles[toggleIndex];
			}
		}

		this.finishBatch();
	}

	private finishBatch(): void {
		this.processing = false;
		this.current = this.postponed;
		this.postponed = [];
		if (this.current.length > 0) {
			void this.process();
		}
	}
}