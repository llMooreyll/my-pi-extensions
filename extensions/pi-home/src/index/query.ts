import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { SessionRecord } from "./types.ts";

export const DAY_MS = 86_400_000;

/** Local-time YYYY-MM-DD. */
export function dayKey(t: number): string {
	const d = new Date(t);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function startOfDay(t: number): number {
	const d = new Date(t);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

export type RangeId = "7d" | "30d" | "90d" | "365d" | "all";
export const RANGES: { id: RangeId; label: string; days: number | null }[] = [
	{ id: "7d", label: "7D", days: 7 },
	{ id: "30d", label: "30D", days: 30 },
	{ id: "90d", label: "90D", days: 90 },
	{ id: "365d", label: "1Y", days: 365 },
	{ id: "all", label: "ALL", days: null },
];

/** [from, to) for a range ending now; from = start of the first day. */
export function rangeBounds(id: RangeId, now = Date.now()): { from: number; to: number } {
	const r = RANGES.find((x) => x.id === id)!;
	if (r.days === null) return { from: 0, to: Number.POSITIVE_INFINITY };
	return { from: startOfDay(now) - (r.days - 1) * DAY_MS, to: Number.POSITIVE_INFINITY };
}

/**
 * Shared filter used by the session list and by analytics drill-down. Sessions match when their
 * activity window [created, lastActivity] overlaps [from, to).
 */
export interface SessionFilter {
	from: number;
	to: number;
	cwd: string | null;
	includeSubagents: boolean;
	/** "provider/model": session used this model at least once. */
	model: string | null;
	tool: string | null;
	/** Session touched this file path. */
	file: string | null;
	onlyErrors: boolean;
	onlyFavorites: boolean;
	tag: string | null;
	/** Case-insensitive substring over name, first message and cwd. */
	text: string;
	/** Explicit id allow-list (from drill-down); null = no restriction. */
	ids: Set<string> | null;
}

export function defaultFilter(): SessionFilter {
	return {
		from: 0,
		to: Number.POSITIVE_INFINITY,
		cwd: null,
		includeSubagents: false,
		model: null,
		tool: null,
		file: null,
		onlyErrors: false,
		onlyFavorites: false,
		tag: null,
		text: "",
		ids: null,
	};
}

export interface MetaLookup {
	isFavorite(id: string): boolean;
	tags(id: string): string[];
}

export function matches(r: SessionRecord, f: SessionFilter, meta?: MetaLookup): boolean {
	if (!f.includeSubagents && r.isSubagent) return false;
	if (r.lastActivity < f.from || r.created >= f.to) return false;
	if (f.cwd !== null && r.cwd !== f.cwd) return false;
	if (f.model !== null && !(f.model in r.models)) return false;
	if (f.tool !== null && !(f.tool in r.tools)) return false;
	if (f.file !== null && !(f.file in r.files)) return false;
	if (f.onlyErrors && r.errors === 0) return false;
	if (f.ids !== null && !f.ids.has(r.id)) return false;
	if (meta) {
		if (f.onlyFavorites && !meta.isFavorite(r.id)) return false;
		if (f.tag !== null && !meta.tags(r.id).includes(f.tag)) return false;
	}
	if (f.text) {
		const q = f.text.toLowerCase();
		const hay = `${r.name ?? ""}\n${r.firstUserMessage}\n${r.cwd}`.toLowerCase();
		if (!hay.includes(q)) return false;
	}
	return true;
}

export function filterSessions(records: Iterable<SessionRecord>, f: SessionFilter, meta?: MetaLookup): SessionRecord[] {
	const out: SessionRecord[] = [];
	for (const r of records) if (matches(r, f, meta)) out.push(r);
	return out;
}

/** Display title: session name, else first user message, else file name. */
export function sessionTitle(r: SessionRecord): string {
	return r.name || r.firstUserMessage || basename(r.file);
}

/** Model with the most calls in this session. */
export function mainModel(r: SessionRecord): string {
	let best = "";
	let n = -1;
	for (const [m, s] of Object.entries(r.models)) {
		if (s.calls > n) {
			n = s.calls;
			best = m;
		}
	}
	return best;
}

export const totalTokens = (r: SessionRecord): number =>
	r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite;

export interface Project {
	cwd: string;
	name: string;
	sessions: number;
	lastActivity: number;
	cost: number;
	cost7d: number;
	exists: boolean;
	pinned: boolean;
	/** Daily cost for the last 14 days, oldest first (sparkline). */
	spark: number[];
}

/** Projects from session cwds; pinned first, then by most recent activity. Subagent sessions excluded. */
export function listProjects(records: Iterable<SessionRecord>, pinned: string[], now = Date.now()): Project[] {
	const map = new Map<string, Project>();
	const today = startOfDay(now);
	const weekAgo = today - 6 * DAY_MS;
	const sparkFrom = today - 13 * DAY_MS;
	for (const r of records) {
		if (!r.cwd || r.isSubagent) continue;
		let p = map.get(r.cwd);
		if (!p) {
			p = {
				cwd: r.cwd,
				name: basename(r.cwd) || r.cwd,
				sessions: 0,
				lastActivity: 0,
				cost: 0,
				cost7d: 0,
				exists: existsSync(r.cwd),
				pinned: pinned.includes(r.cwd),
				spark: new Array(14).fill(0),
			};
			map.set(r.cwd, p);
		}
		p.sessions++;
		p.lastActivity = Math.max(p.lastActivity, r.lastActivity);
		p.cost += r.cost + r.warmCost;
		const ev = r.ev;
		for (let i = 0; i < ev.cT.length; i++) {
			const t = ev.cT[i]!;
			if (t >= weekAgo) p.cost7d += ev.cCost[i]!;
			if (t >= sparkFrom) {
				const di = Math.floor((startOfDay(t) - sparkFrom) / DAY_MS);
				if (di >= 0 && di < 14) p.spark[di]! += ev.cCost[i]!;
			}
		}
	}
	for (const cwd of pinned) {
		if (!map.has(cwd)) {
			map.set(cwd, {
				cwd,
				name: basename(cwd) || cwd,
				sessions: 0,
				lastActivity: 0,
				cost: 0,
				cost7d: 0,
				exists: existsSync(cwd),
				pinned: true,
				spark: new Array(14).fill(0),
			});
		}
	}
	return [...map.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivity - a.lastActivity);
}
