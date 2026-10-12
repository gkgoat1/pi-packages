/**
 * Pure view-model derivation for the workers dashboard.
 *
 * No TUI imports: the component (dashboard-component.ts) renders this shape,
 * and tests drive it without a terminal. Ordering is tree order — parents
 * before children, creation order among siblings — so the tree reads
 * top-to-bottom the way it grew.
 */

export interface DashboardWorkerLike {
	id: string;
	parentId: string | null;
	depth: number;
	model: string;
	tag: string;
	callerModel: string;
	status: string;
	createdAt: string;
	lastOutput?: string;
	error?: string;
	attempts?: number;
	sessionFile?: string;
}

export interface DashboardPendingLike {
	workerId: string;
	requestId: string;
	method: string;
	title?: string;
}

export interface DashboardRow {
	id: string;
	parentId: string | null;
	indent: number;
	status: string;
	model: string;
	tag: string;
	attempts: number;
	pendingDialogs: number;
	errorPreview?: string;
	outputPreview?: string;
}

export interface DashboardView {
	rows: DashboardRow[];
	selectedIndex: number;
	totalPendingDialogs: number;
	emptyText?: string;
	/** Tree edges for connectors: id of each row's rendered parent. */
}

export interface BuildDashboardInput {
	records: DashboardWorkerLike[];
	pendingByWorker: Record<string, DashboardPendingLike[]>;
	previousSelection?: number;
}

const MAX_PREVIEW_CHARS = 160;

function preview(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > MAX_PREVIEW_CHARS ? `${single.slice(0, MAX_PREVIEW_CHARS)}…` : single;
}

function compareCreated(a: DashboardWorkerLike, b: DashboardWorkerLike): number {
	return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

export function buildDashboardView(input: BuildDashboardInput): DashboardView {
	if (input.records.length === 0) {
		return { rows: [], selectedIndex: 0, totalPendingDialogs: 0, emptyText: "No workers in this runtime." };
	}

	const childrenByParent = new Map<string | null, DashboardWorkerLike[]>();
	for (const record of input.records) {
		const siblings = childrenByParent.get(record.parentId) ?? [];
		siblings.push(record);
		childrenByParent.set(record.parentId, siblings);
	}
	for (const siblings of childrenByParent.values()) siblings.sort(compareCreated);

	// Depth-first walk from roots: parents before children, siblings in creation order.
	// Orphans (missing parent record) attach as roots so nothing disappears.
	const known = new Set(input.records.map((record) => record.id));
	const roots = (childrenByParent.get(null) ?? []).slice();
	for (const [parentId, siblings] of childrenByParent) {
		if (parentId !== null && !known.has(parentId)) roots.push(...siblings);
	}
	roots.sort(compareCreated);

	const rows: DashboardRow[] = [];
	const visit = (record: DashboardWorkerLike, indent: number) => {
		rows.push({
			id: record.id,
			parentId: record.parentId,
			indent,
			status: record.status,
			model: record.model,
			tag: record.tag,
			attempts: record.attempts ?? 1,
			pendingDialogs: input.pendingByWorker[record.id]?.length ?? 0,
			errorPreview: preview(record.error),
			outputPreview: preview(record.lastOutput?.slice(-500)),
		});
		for (const child of childrenByParent.get(record.id) ?? []) visit(child, indent + 1);
	};
	for (const root of roots) visit(root, 0);

	const totalPendingDialogs = Object.values(input.pendingByWorker).reduce((sum, list) => sum + list.length, 0);
	const selectedIndex = Math.min(Math.max(input.previousSelection ?? 0, 0), rows.length - 1);
	return { rows, selectedIndex, totalPendingDialogs };
}
