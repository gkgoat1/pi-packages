/**
 * The workers dashboard screen: a keyboard-driven Pi TUI component over the
 * pure view model. Rendering is width-safe (every line is truncated to the
 * supplied width) and theme-neutral so tests can assert on plain text.
 *
 * Actions route through injected async callbacks (the shared Phase 2/3
 * validators); the component only manages browse/input/confirm modes and
 * surfaces outcomes on its status line.
 */
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { DashboardPendingLike, DashboardRow, DashboardView } from "./dashboard-model.ts";

export interface DashboardActions {
	reply?(workerId: string, message: string): Promise<string>;
	steer?(workerId: string, message: string): Promise<string>;
	resume?(workerId: string): Promise<string>;
	abort?(workerId: string): Promise<string>;
	answer?(workerId: string, requestId: string, answer: string): Promise<string>;
}

export interface DashboardComponentDeps {
	getView: () => DashboardView;
	getPending?: (workerId: string) => DashboardPendingLike[];
	onClose: () => void;
	actions: DashboardActions;
}

type DashboardMode =
	| { kind: "browse" }
	| { kind: "input"; action: "reply" | "steer" | "answer"; buffer: string; label: string; requestId?: string }
	| { kind: "confirm"; action: "abort"; label: string };

const MIN_WIDTH = 20;
const ID_WIDTH = 10;
const STATUS_WIDTH = 9;

function statusBadge(row: DashboardRow): string {
	return row.pendingDialogs > 0 ? ` ⬤${row.pendingDialogs}` : "";
}

export class WorkersDashboardComponent implements Component {
	private selection = 0;
	private statusLine = "";
	private mode: DashboardMode = { kind: "browse" };
	private inFlight: Promise<void> | undefined;

	constructor(private readonly deps: DashboardComponentDeps) {}

	private view(): { view: DashboardView; rows: DashboardRow[] } {
		const view = this.deps.getView();
		this.selection = Math.min(Math.max(this.selection, 0), Math.max(view.rows.length - 1, 0));
		return { view, rows: view.rows };
	}

	private line(text: string, width: number): string {
		return truncateToWidth(text, Math.max(width, MIN_WIDTH), "…", true);
	}

	render(width: number): string[] {
		const { view, rows } = this.view();
		const lines: string[] = [];
		const pending = view.totalPendingDialogs > 0 ? `  ⬤ ${view.totalPendingDialogs} pending dialog${view.totalPendingDialogs === 1 ? "" : "s"}` : "";
		lines.push(this.line(` Workers (${rows.length})${pending}`, width));
		lines.push(this.line("", width));

		if (view.emptyText) {
			lines.push(this.line(` ${view.emptyText}`, width));
		} else {
			for (const [index, row] of rows.entries()) {
				const marker = index === this.selection ? "▶" : " ";
				const indent = "  ".repeat(Math.min(row.indent, 8));
				const id = row.id.padEnd(ID_WIDTH).slice(0, ID_WIDTH);
				const status = row.status.padEnd(STATUS_WIDTH).slice(0, STATUS_WIDTH);
				lines.push(this.line(`${marker}${indent}${id}${status}${row.tag} ×${row.attempts}${statusBadge(row)}`, width));
				if (index === this.selection) {
					if (row.errorPreview) lines.push(this.line(`   error: ${row.errorPreview}`, width));
					else if (row.outputPreview) lines.push(this.line(`   out: ${row.outputPreview}`, width));
				}
			}
		}

		lines.push(this.line("", width));
		if (this.mode.kind === "input") {
			lines.push(this.line(` ${this.mode.label}: ${this.mode.buffer}▏`, width));
		} else if (this.mode.kind === "confirm") {
			lines.push(this.line(` ${this.mode.label} (y/n)`, width));
		} else if (this.statusLine) {
			lines.push(this.line(` ${this.statusLine}`, width));
		}
		lines.push(this.line(" [↑/k ↓/j] move  [r]eply [s]teer [u]resume [a]nswer [x]abort  [q/Esc] close", width));
		return lines;
	}

	/** Stateless rendering from the model each frame; nothing to invalidate. */
	invalidate(): void {}

	handleInput(data: string): void {
		if (this.mode.kind === "input") return this.handleInputMode(data);
		if (this.mode.kind === "confirm") return this.handleConfirmMode(data);
		return this.handleBrowseMode(data);
	}

	private handleBrowseMode(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.deps.onClose();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.selection = Math.max(this.selection - 1, 0);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.selection = Math.min(this.selection + 1, Math.max(this.deps.getView().rows.length - 1, 0));
			return;
		}
		if (matchesKey(data, "r")) return this.startInput("reply");
		if (matchesKey(data, "s")) return this.startInput("steer");
		if (matchesKey(data, "a")) return this.startAnswer();
		if (matchesKey(data, "x")) return this.startAbort();
		if (matchesKey(data, "u")) return this.dispatchResume();
	}

	private handleInputMode(data: string): void {
		if (this.mode.kind !== "input") return;
		if (matchesKey(data, Key.escape)) {
			this.mode = { kind: "browse" };
			this.statusLine = "Cancelled.";
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const mode = this.mode;
			this.mode = { kind: "browse" };
			this.submitInput(mode);
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			this.mode.buffer = this.mode.buffer.slice(0, -1);
			return;
		}
		if (visibleWidth(data) > 0) this.mode.buffer += data;
	}

	private handleConfirmMode(data: string): void {
		if (this.mode.kind !== "confirm") return;
		if (matchesKey(data, "y")) {
			const workerId = this.selectedWorkerId();
			this.mode = { kind: "browse" };
			if (workerId) this.dispatch(`Abort ${workerId}`, () => this.requireAction("abort")(workerId));
			return;
		}
		if (matchesKey(data, "n") || matchesKey(data, Key.escape)) {
			this.mode = { kind: "browse" };
			this.statusLine = "Abort cancelled.";
		}
	}

	private requireAction<K extends keyof DashboardActions>(name: K): NonNullable<DashboardActions[K]> {
		const action = this.deps.actions[name];
		if (!action) throw new Error(`The ${name} action is unavailable here.`);
		return action as NonNullable<DashboardActions[K]>;
	}

	private startInput(action: "reply" | "steer"): void {
		const workerId = this.selectedWorkerId();
		if (!workerId) {
			this.statusLine = "No workers to act on.";
			return;
		}
		try {
			this.requireAction(action);
		} catch (error) {
			this.statusLine = error instanceof Error ? error.message : String(error);
			return;
		}
		this.mode = { kind: "input", action, buffer: "", label: `${action === "reply" ? "Reply to" : "Steer"} ${workerId}` };
	}

	private startAnswer(): void {
		const workerId = this.selectedWorkerId();
		if (!workerId) {
			this.statusLine = "No workers to act on.";
			return;
		}
		const pending = this.deps.getPending?.(workerId) ?? [];
		if (pending.length === 0) {
			this.statusLine = `No pending dialog on ${workerId}.`;
			return;
		}
		const first = pending[0]!;
		this.mode = { kind: "input", action: "answer", buffer: "", label: `Answer ${first.method} on ${workerId} (${first.requestId})`, requestId: first.requestId };
	}

	private startAbort(): void {
		const workerId = this.selectedWorkerId();
		if (!workerId) {
			this.statusLine = "No workers to act on.";
			return;
		}
		this.mode = { kind: "confirm", action: "abort", label: `Abort ${workerId}?` };
	}

	private dispatchResume(): void {
		const workerId = this.selectedWorkerId();
		if (!workerId) {
			this.statusLine = "No workers to act on.";
			return;
		}
		this.dispatch(`Resume ${workerId}`, () => this.requireAction("resume")(workerId));
	}

	private submitInput(mode: Extract<DashboardMode, { kind: "input" }>): void {
		const workerId = this.selectedWorkerId();
		const message = mode.buffer.trim();
		if (!workerId || !message) {
			this.statusLine = message ? "No workers to act on." : "Nothing to send.";
			return;
		}
		if (mode.action === "answer") {
			const requestId = mode.requestId;
			if (!requestId) {
				this.statusLine = "No pending dialog to answer.";
				return;
			}
			this.dispatch(`Answer ${requestId}`, () => this.requireAction("answer")(workerId, requestId, message));
			return;
		}
		const actionName: "reply" | "steer" = mode.action;
		this.dispatch(`${actionName} ${workerId}`, () => this.requireAction(actionName)(workerId, message));
	}

	private dispatch(label: string, run: () => Promise<string>): void {
		this.statusLine = `${label}…`;
		this.inFlight = (async () => {
			try {
				this.statusLine = await run();
			} catch (error) {
				this.statusLine = error instanceof Error ? error.message : String(error);
			}
		})();
	}

	/** Test hook: wait for the in-flight action to settle. */
	async flush(): Promise<void> {
		await this.inFlight;
	}

	/** Surface an action outcome on the dashboard's status line. */
	setStatus(text: string): void {
		this.statusLine = text;
	}

	selectedWorkerId(): string | undefined {
		return this.deps.getView().rows[this.selection]?.id;
	}
}
