/**
 * The workers dashboard screen: a keyboard-driven Pi TUI component over the
 * pure view model. Rendering is width-safe (every line is truncated to the
 * supplied width) and theme-neutral so tests can assert on plain text.
 */
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { DashboardRow, DashboardView } from "./dashboard-model.ts";

export interface DashboardActions {
	reply?(workerId: string, message: string): Promise<string>;
	steer?(workerId: string, message: string): Promise<string>;
	resume?(workerId: string): Promise<string>;
	abort?(workerId: string): Promise<string>;
	answer?(workerId: string, requestId: string, answer: string): Promise<string>;
}

export interface DashboardComponentDeps {
	getView: () => DashboardView;
	onClose: () => void;
	actions: DashboardActions;
}

const MIN_WIDTH = 20;
const ID_WIDTH = 10;
const STATUS_WIDTH = 9;

function statusBadge(row: DashboardRow): string {
	return row.pendingDialogs > 0 ? ` ⬤${row.pendingDialogs}` : "";
}

export class WorkersDashboardComponent implements Component {
	private selection = 0;
	private statusLine = "";

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
		if (this.statusLine) lines.push(this.line(` ${this.statusLine}`, width));
		lines.push(this.line(" [↑/k ↓/j] move  [r]eply [s]teer [u]resume [a]nswer [x]abort  [q/Esc] close", width));
		return lines;
	}

	/** Stateless rendering from the model each frame; nothing to invalidate. */
	invalidate(): void {}

	handleInput(data: string): void {
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
	}

	/** Surface an action outcome on the dashboard's status line. */
	setStatus(text: string): void {
		this.statusLine = text;
	}

	selectedWorkerId(): string | undefined {
		return this.deps.getView().rows[this.selection]?.id;
	}
}
