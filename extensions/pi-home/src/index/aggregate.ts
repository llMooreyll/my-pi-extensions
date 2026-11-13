/**
 * Analytics aggregates over SessionRecords. Every function counts only events whose timestamp is
 * in [range.from, range.to) unless its signature has no range. Event columns are iterated
 * directly; callers pass records already filtered with filterSessions().
 */
import { basename, dirname, extname } from "node:path";
import type { TreeNode } from "../ui/charts/tree.ts";
import { dayKey, sessionTitle, startOfDay } from "./query.ts";
import type { SessionRecord } from "./types.ts";
import { USER_FLAG_BROWSER, USER_FLAG_POLITE, USER_FLAG_RUSH, USER_FLAG_SKILL } from "./types.ts";

export interface Range {
	from: number;
	to: number;
}

const inRange = (t: number, r: Range): boolean => t >= r.from && t < r.to;

function sortedCopy(a: number[]): number[] {
	for (let i = 1; i < a.length; i++) if (a[i]! < a[i - 1]!) return [...a].sort((x, y) => x - y);
	return a;
}

/** Local-time start of the next day. */
function nextDay(t: number): number {
	const d = new Date(t);
	d.setHours(0, 0, 0, 0);
	d.setDate(d.getDate() + 1);
	return d.getTime();
}

/** Local-time Monday (start of day) of the week containing t. */
function mondayOf(t: number): number {
	const d = new Date(t);
	d.setHours(0, 0, 0, 0);
	d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
	return d.getTime();
}

/** Maps timestamps to a per-day value, recomputing the day key only when the day changes. */
function dayCursor<T>(get: (key: string) => T): (t: number) => T {
	let start = 1;
	let end = 0;
	let cur: T | undefined;
	return (t) => {
		if (t < start || t >= end || cur === undefined) {
			start = startOfDay(t);
			end = nextDay(t);
			cur = get(dayKey(t));
		}
		return cur;
	};
}

// ---------------------------------------------------------------------------------------------
// Time

export interface DayStats {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	cost: number;
	warmCost: number;
	sessions: Set<string>;
	activeMinutes: number;
	userTurns: number;
	editAdd: number;
	editDel: number;
}

const newDay = (): DayStats => ({
	calls: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	reasoning: 0,
	cost: 0,
	warmCost: 0,
	sessions: new Set(),
	activeMinutes: 0,
	userTurns: 0,
	editAdd: 0,
	editDel: 0,
});

/** Per local day totals (only days with events). `activeMinutes` sums gaps under 5 minutes. */
export function dailySeries(records: SessionRecord[], range: Range): Map<string, DayStats> {
	const days = new Map<string, DayStats>();
	const dayOf = dayCursor((k) => {
		let d = days.get(k);
		if (!d) days.set(k, (d = newDay()));
		return d;
	});
	const WARM = "cache_warm";
	for (const r of records) {
		const e = r.ev;
		for (let i = 0; i < e.cT.length; i++) {
			const t = e.cT[i]!;
			if (!inRange(t, range)) continue;
			const d = dayOf(t);
			d.calls++;
			d.input += e.cIn[i]!;
			d.output += e.cOut[i]!;
			d.cacheRead += e.cCR[i]!;
			d.cacheWrite += e.cCW[i]!;
			d.reasoning += e.cRsn[i]!;
			d.cost += e.cCost[i]!;
			d.sessions.add(r.id);
		}
		for (let i = 0; i < e.tT.length; i++) if (inRange(e.tT[i]!, range)) dayOf(e.tT[i]!).sessions.add(r.id);
		for (let i = 0; i < e.uT.length; i++) {
			const t = e.uT[i]!;
			if (!inRange(t, range)) continue;
			const d = dayOf(t);
			d.userTurns++;
			d.sessions.add(r.id);
		}
		for (let i = 0; i < e.eT.length; i++) {
			const t = e.eT[i]!;
			if (!inRange(t, range)) continue;
			const d = dayOf(t);
			d.sessions.add(r.id);
			if (e.dict[e.eKind[i]!] === WARM) d.warmCost += e.eVal[i]! / 1e6;
		}
		for (let i = 0; i < e.dT.length; i++) {
			const t = e.dT[i]!;
			if (!inRange(t, range)) continue;
			const d = dayOf(t);
			d.editAdd += e.dAdd[i]!;
			d.editDel += e.dDel[i]!;
			d.sessions.add(r.id);
		}
		// Active time: gaps under 5 minutes between consecutive events of this session.
		const all = [...e.cT, ...e.tT, ...e.uT].sort((a, b) => a - b);
		for (let i = 1; i < all.length; i++) {
			const gap = all[i]! - all[i - 1]!;
			if (gap > 0 && gap < 300_000 && inRange(all[i]!, range)) dayOf(all[i]!).activeMinutes += gap / 60_000;
		}
	}
	return days;
}

/** Call counts [weekday 0 = Monday][hour], local time. */
export function hourWeekday(records: SessionRecord[], range: Range): number[][] {
	const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
	for (const r of records) {
		for (const t of r.ev.cT) {
			if (!inRange(t, range)) continue;
			const d = new Date(t);
			grid[(d.getDay() + 6) % 7]![d.getHours()]!++;
		}
	}
	return grid;
}

/** Call counts per local hour. */
export function hourOfDay(records: SessionRecord[], range: Range): number[] {
	const out = new Array<number>(24).fill(0);
	for (const r of records) for (const t of r.ev.cT) if (inRange(t, range)) out[new Date(t).getHours()]!++;
	return out;
}

/**
 * Streaks over the days of `daily` that have at least one call. `current` ends today or
 * yesterday (a streak is not broken until a full day passes without activity).
 */
export function streaks(daily: Map<string, DayStats>): { current: number; longest: number; longestEnd: string; activeDays: number } {
	const active = [...daily.entries()].filter(([, d]) => d.calls > 0 || d.userTurns > 0).map(([k]) => k).sort();
	let longest = 0;
	let longestEnd = "";
	let run = 0;
	let prev = "";
	const next = (k: string): string => {
		const [y, m, d] = k.split("-").map(Number) as [number, number, number];
		return dayKey(new Date(y, m - 1, d + 1).getTime());
	};
	for (const k of active) {
		run = prev !== "" && next(prev) === k ? run + 1 : 1;
		if (run > longest) {
			longest = run;
			longestEnd = k;
		}
		prev = k;
	}
	let current = 0;
	const today = dayKey(Date.now());
	const yesterday = dayKey(startOfDay(Date.now()) - 1);
	if (prev === today || prev === yesterday) current = run;
	return { current, longest, longestEnd, activeDays: active.length };
}

// ---------------------------------------------------------------------------------------------
// Models

export interface ModelStats {
	model: string;
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Durations in ms of calls with a recorded duration. */
	durMs: number[];
	/** Output tokens per second for calls longer than 1 s with output. */
	tps: number[];
	costPerCall: number[];
	errors: number;
	aborted: number;
	truncated: number;
}

/** Per model statistics, sorted by calls descending. */
export function modelStats(records: SessionRecord[], range: Range): ModelStats[] {
	const map = new Map<string, ModelStats>();
	for (const r of records) {
		const e = r.ev;
		for (let i = 0; i < e.cT.length; i++) {
			if (!inRange(e.cT[i]!, range)) continue;
			const name = e.dict[e.cModel[i]!] ?? "?";
			let m = map.get(name);
			if (!m) {
				m = { model: name, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, durMs: [], tps: [], costPerCall: [], errors: 0, aborted: 0, truncated: 0 };
				map.set(name, m);
			}
			m.calls++;
			m.input += e.cIn[i]!;
			m.output += e.cOut[i]!;
			m.cacheRead += e.cCR[i]!;
			m.cacheWrite += e.cCW[i]!;
			m.cost += e.cCost[i]!;
			m.costPerCall.push(e.cCost[i]!);
			const dur = e.cDur[i]!;
			if (dur > 0) m.durMs.push(dur);
			if (dur > 1000 && e.cOut[i]! > 0) m.tps.push(e.cOut[i]! / (dur / 1000));
			const stop = e.dict[e.cStop[i]!];
			if (stop === "error") m.errors++;
			else if (stop === "aborted") m.aborted++;
			else if (stop === "length") m.truncated++;
		}
	}
	return [...map.values()].sort((a, b) => b.calls - a.calls);
}

/** Monday dayKeys from the first to the last week that has calls in the range (gaps included). */
export function weekList(records: SessionRecord[], range: Range): string[] {
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (const r of records) {
		for (const t of r.ev.cT) {
			if (!inRange(t, range)) continue;
			if (t < lo) lo = t;
			if (t > hi) hi = t;
		}
	}
	if (lo > hi) return [];
	const weeks: string[] = [];
	const last = mondayOf(hi);
	for (let w = mondayOf(lo); w <= last; ) {
		weeks.push(dayKey(w));
		const d = new Date(w);
		d.setDate(d.getDate() + 7);
		w = d.getTime();
	}
	return weeks;
}

/** Calls per week and model: `calls[weekIndex][modelIndex]`, models sorted by total calls. */
export function modelWeekly(records: SessionRecord[], range: Range): { weeks: string[]; models: string[]; calls: number[][] } {
	const weeks = weekList(records, range);
	const index = new Map(weeks.map((w, i) => [w, i]));
	const models = modelStats(records, range).map((m) => m.model);
	const mIndex = new Map(models.map((m, i) => [m, i]));
	const calls = weeks.map(() => new Array<number>(models.length).fill(0));
	for (const r of records) {
		const e = r.ev;
		for (let i = 0; i < e.cT.length; i++) {
			const t = e.cT[i]!;
			if (!inRange(t, range)) continue;
			const wi = index.get(dayKey(mondayOf(t)));
			const mi = mIndex.get(e.dict[e.cModel[i]!] ?? "?");
			if (wi !== undefined && mi !== undefined) calls[wi]![mi]!++;
		}
	}
	return { weeks, models, calls };
}

/**
 * Model switches, top 12. For a model_change event `from` is the value of the previous
 * model_change of the session, else the model of the last call before it; events without a known
 * `from` or with from === to are skipped.
 */
export function modelSwitches(records: SessionRecord[], range: Range): { from: string; to: string; value: number }[] {
	const counts = new Map<string, { from: string; to: string; value: number }>();
	for (const r of records) {
		const e = r.ev;
		let prev: string | undefined;
		let ci = 0;
		let lastCallModel: string | undefined;
		for (let i = 0; i < e.eT.length; i++) {
			if (e.dict[e.eKind[i]!] !== "model_change") continue;
			const t = e.eT[i]!;
			while (ci < e.cT.length && e.cT[ci]! <= t) lastCallModel = e.dict[e.cModel[ci++]!];
			const to = e.dict[e.eVal[i]!] ?? "?";
			const from = prev ?? lastCallModel;
			prev = to;
			if (from === undefined || from === to || !inRange(t, range)) continue;
			const key = `${from}\u0000${to}`;
			const c = counts.get(key);
			if (c) c.value++;
			else counts.set(key, { from, to, value: 1 });
		}
	}
	return [...counts.values()].sort((a, b) => b.value - a.value).slice(0, 12);
}

/** Calls, output and reasoning tokens per thinking level ("unknown" when missing). */
export function thinkingStats(records: SessionRecord[], range: Range): { level: string; calls: number; output: number; reasoning: number }[] {
	const map = new Map<string, { level: string; calls: number; output: number; reasoning: number }>();
	for (const r of records) {
		const e = r.ev;
		for (let i = 0; i < e.cT.length; i++) {
			if (!inRange(e.cT[i]!, range)) continue;
			const level = e.dict[e.cThink[i]!] || "unknown";
			let s = map.get(level);
			if (!s) map.set(level, (s = { level, calls: 0, output: 0, reasoning: 0 }));
			s.calls++;
			s.output += e.cOut[i]!;
			s.reasoning += e.cRsn[i]!;
		}
	}
	return [...map.values()].sort((a, b) => b.calls - a.calls);
}

// ---------------------------------------------------------------------------------------------
// Tools

const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
export type ToolSource = "builtin" | "mcp" | "extension";
const toolSource = (name: string): ToolSource => (BUILTIN_TOOLS.has(name) ? "builtin" : name.startsWith("mcp__") ? "mcp" : "extension");

/** Per tool call counts, errors and durations (ms, recorded ones only), sorted by calls. */
export function toolStats(records: SessionRecord[], range: Range): { tool: string; calls: number; errors: number; durMs: number[]; source: ToolSource }[] {
	const map = new Map<string, { tool: string; calls: number; errors: number; durMs: number[]; source: ToolSource }>();
	for (const r of records) {
		const e = r.ev;
		for (let i = 0; i < e.tT.length; i++) {
			if (!inRange(e.tT[i]!, range)) continue;
			const name = e.dict[e.tTool[i]!] ?? "?";
			let s = map.get(name);
			if (!s) map.set(name, (s = { tool: name, calls: 0, errors: 0, durMs: [], source: toolSource(name) }));
			s.calls++;
			s.errors += e.tErr[i]!;
			if (e.tDur[i]! > 0) s.durMs.push(e.tDur[i]!);
		}
	}
	return [...map.values()].sort((a, b) => b.calls - a.calls);
}

/** Indexes of tool results of one session ordered by time. */
function toolOrder(r: SessionRecord): number[] {
	const idx = r.ev.tT.map((_, i) => i);
	const t = r.ev.tT;
	for (let i = 1; i < t.length; i++) {
		if (t[i]! < t[i - 1]!) return idx.sort((a, b) => t[a]! - t[b]!);
	}
	return idx;
}

/** Tool -> next tool counts within sessions for the `top` most used tools (`matrix[from][to]`). */
export function toolTransitions(records: SessionRecord[], range: Range, top = 10): { tools: string[]; matrix: number[][] } {
	const tools = toolStats(records, range).slice(0, top).map((t) => t.tool);
	const index = new Map(tools.map((t, i) => [t, i]));
	const matrix = tools.map(() => new Array<number>(tools.length).fill(0));
	for (const r of records) {
		const e = r.ev;
		let prev = -1;
		for (const i of toolOrder(r)) {
			if (!inRange(e.tT[i]!, range)) {
				prev = -1;
				continue;
			}
			const cur = index.get(e.dict[e.tTool[i]!] ?? "?") ?? -1;
			if (prev >= 0 && cur >= 0) matrix[prev]![cur]!++;
			prev = cur;
		}
	}
	return { tools, matrix };
}

/** Tool call sequence of the latest `limit` sessions; `tools` are indices into `names`. */
export function toolDna(records: SessionRecord[], limit: number): { names: string[]; rows: { id: string; title: string; tools: number[] }[] } {
	const latest = [...records].sort((a, b) => b.lastActivity - a.lastActivity).slice(0, limit);
	const totals = new Map<string, number>();
	for (const r of latest) for (const i of r.ev.tTool) totals.set(r.ev.dict[i] ?? "?", (totals.get(r.ev.dict[i] ?? "?") ?? 0) + 1);
	const names = [...totals.keys()].sort((a, b) => totals.get(b)! - totals.get(a)!);
	const index = new Map(names.map((n, i) => [n, i]));
	const rows = latest.map((r) => ({
		id: r.id,
		title: sessionTitle(r),
		tools: toolOrder(r).map((i) => index.get(r.ev.dict[r.ev.tTool[i]!] ?? "?")!),
	}));
	return { names, rows };
}

export type CountField = "bashCmds" | "gitSubs" | "codeLangs" | "customTypes" | "skills" | "words";

/** Merge one of the per-session count maps over all records, descending. */
export function topCounts(records: SessionRecord[], field: CountField): { key: string; count: number }[] {
	const map = new Map<string, number>();
	for (const r of records) for (const [k, v] of Object.entries(r[field])) map.set(k, (map.get(k) ?? 0) + v);
	return [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------------------------
// Files

/** Per file read/edit/write counts, edited-file languages (by extension) and directories. */
export function fileStats(records: SessionRecord[]): {
	files: { path: string; read: number; edit: number; write: number }[];
	languages: { ext: string; count: number }[];
	dirs: { dir: string; count: number }[];
} {
	const files = new Map<string, { path: string; read: number; edit: number; write: number }>();
	for (const r of records) {
		for (const [path, f] of Object.entries(r.files)) {
			let s = files.get(path);
			if (!s) files.set(path, (s = { path, read: 0, edit: 0, write: 0 }));
			s.read += f.read;
			s.edit += f.edit;
			s.write += f.write;
		}
	}
	const langs = new Map<string, number>();
	const dirs = new Map<string, number>();
	for (const f of files.values()) {
		const n = f.edit + f.write;
		if (n === 0) continue;
		const ext = extname(f.path).toLowerCase() || "(none)";
		langs.set(ext, (langs.get(ext) ?? 0) + n);
		const dir = dirname(f.path);
		dirs.set(dir, (dirs.get(dir) ?? 0) + n);
	}
	const desc = <T extends { count: number }>(a: T[]): T[] => a.sort((x, y) => y.count - x.count);
	return {
		files: [...files.values()].sort((a, b) => b.read + b.edit + b.write - (a.read + a.edit + a.write)),
		languages: desc([...langs].map(([ext, count]) => ({ ext, count }))),
		dirs: desc([...dirs].map(([dir, count]) => ({ dir, count }))),
	};
}

/** Edits per file (top `top`) per day: `matrix[fileIndex][dayIndex]`, days contiguous. */
export function fileTimeline(records: SessionRecord[], range: Range, top = 10): { files: string[]; days: string[]; matrix: number[][] } {
	const totals = new Map<string, number>();
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (const r of records) {
		const e = r.ev;
		for (let i = 0; i < e.dT.length; i++) {
			const t = e.dT[i]!;
			if (!inRange(t, range)) continue;
			const f = e.dict[e.dFile[i]!] ?? "?";
			totals.set(f, (totals.get(f) ?? 0) + 1);
			if (t < lo) lo = t;
			if (t > hi) hi = t;
		}
	}
	if (lo > hi) return { files: [], days: [], matrix: [] };
	const files = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([f]) => f);
	const fIndex = new Map(files.map((f, i) => [f, i]));
	const start = startOfDay(range.from > 0 ? range.from : lo);
	const end = startOfDay(Number.isFinite(range.to) ? range.to - 1 : Math.max(hi, Date.now()));
	const days: string[] = [];
	const dIndex = new Map<string, number>();
	for (let d = start; d <= Math.max(start, end); d = nextDay(d)) {
		dIndex.set(dayKey(d), days.length);
		days.push(dayKey(d));
	}
	const matrix = files.map(() => new Array<number>(days.length).fill(0));
	for (const r of records) {
		const e = r.ev;
		for (let i = 0; i < e.dT.length; i++) {
			const t = e.dT[i]!;
			if (!inRange(t, range)) continue;
			const fi = fIndex.get(e.dict[e.dFile[i]!] ?? "?");
			const di = dIndex.get(dayKey(t));
			if (fi !== undefined && di !== undefined) matrix[fi]![di]!++;
		}
	}
	return { files, days, matrix };
}

// ---------------------------------------------------------------------------------------------
// Projects, user, cost

export interface ProjectStats {
	cwd: string;
	name: string;
	sessions: number;
	cost: number;
	tokens: number;
	first: number;
	last: number;
	/** Calls per week, aligned with weekList(records, range). */
	weekly: number[];
}

/** Per working directory totals (calls cost plus cache warm-ups), for projects with activity. */
export function projectStats(records: SessionRecord[], range: Range): ProjectStats[] {
	const weeks = weekList(records, range);
	const wIndex = new Map(weeks.map((w, i) => [w, i]));
	const map = new Map<string, ProjectStats & { ids: Set<string> }>();
	for (const r of records) {
		const e = r.ev;
		const touch = (t: number): ProjectStats & { ids: Set<string> } => {
			let p = map.get(r.cwd);
			if (!p) {
				p = { cwd: r.cwd, name: basename(r.cwd) || r.cwd, sessions: 0, cost: 0, tokens: 0, first: Number.POSITIVE_INFINITY, last: 0, weekly: new Array<number>(weeks.length).fill(0), ids: new Set() };
				map.set(r.cwd, p);
			}
			p.ids.add(r.id);
			if (t < p.first) p.first = t;
			if (t > p.last) p.last = t;
			return p;
		};
		for (let i = 0; i < e.cT.length; i++) {
			const t = e.cT[i]!;
			if (!inRange(t, range)) continue;
			const p = touch(t);
			p.cost += e.cCost[i]!;
			p.tokens += e.cIn[i]! + e.cOut[i]! + e.cCR[i]! + e.cCW[i]!;
			const wi = wIndex.get(dayKey(mondayOf(t)));
			if (wi !== undefined) p.weekly[wi]!++;
		}
		for (const t of e.tT) if (inRange(t, range)) touch(t);
		for (const t of e.uT) if (inRange(t, range)) touch(t);
		for (let i = 0; i < e.eT.length; i++) {
			if (inRange(e.eT[i]!, range) && e.dict[e.eKind[i]!] === "cache_warm") touch(e.eT[i]!).cost += e.eVal[i]! / 1e6;
		}
	}
	return [...map.values()].map(({ ids, ...p }) => ({ ...p, sessions: ids.size })).sort((a, b) => b.cost - a.cost);
}

export interface UserStats {
	messages: number;
	avgUserLen: number;
	avgAssistantLen: number;
	/** Han characters / all characters in user messages, 0..1 (length weighted). */
	hanRatio: number;
	polite: number;
	rush: number;
	aborted: number;
	images: number;
	browserCtx: number;
	skillRefs: number;
	/** Tool results between a user message and the next one. */
	toolsPerTurn: number[];
}

/** User behaviour numbers. */
export function userStats(records: SessionRecord[], range: Range): UserStats {
	const s: UserStats = { messages: 0, avgUserLen: 0, avgAssistantLen: 0, hanRatio: 0, polite: 0, rush: 0, aborted: 0, images: 0, browserCtx: 0, skillRefs: 0, toolsPerTurn: [] };
	let userChars = 0;
	let hanChars = 0;
	let calls = 0;
	let assistantChars = 0;
	for (const r of records) {
		const e = r.ev;
		for (let i = 0; i < e.cT.length; i++) {
			if (!inRange(e.cT[i]!, range)) continue;
			calls++;
			assistantChars += e.cText[i]!;
			if (e.dict[e.cStop[i]!] === "aborted") s.aborted++;
		}
		const tools = sortedCopy(e.tT);
		const users = e.uT.map((_, i) => i).sort((a, b) => e.uT[a]! - e.uT[b]!);
		let ti = 0;
		for (let k = 0; k < users.length; k++) {
			const i = users[k]!;
			const t = e.uT[i]!;
			const nextT = k + 1 < users.length ? e.uT[users[k + 1]!]! : Number.POSITIVE_INFINITY;
			while (ti < tools.length && tools[ti]! < t) ti++;
			let n = 0;
			while (ti < tools.length && tools[ti]! < nextT) {
				n++;
				ti++;
			}
			if (!inRange(t, range)) continue;
			s.messages++;
			userChars += e.uLen[i]!;
			hanChars += (e.uHan[i]! / 100) * e.uLen[i]!;
			s.images += e.uImg[i]!;
			const f = e.uFlags[i]!;
			if (f & USER_FLAG_POLITE) s.polite++;
			if (f & USER_FLAG_RUSH) s.rush++;
			if (f & USER_FLAG_BROWSER) s.browserCtx++;
			if (f & USER_FLAG_SKILL) s.skillRefs++;
			s.toolsPerTurn.push(n);
		}
	}
	s.avgUserLen = s.messages ? userChars / s.messages : 0;
	s.avgAssistantLen = calls ? assistantChars / calls : 0;
	s.hanRatio = userChars ? hanChars / userChars : 0;
	return s;
}

export interface CostStats {
	/** Calls cost plus cache warm-up spend. */
	total: number;
	warm: number;
	byProject: { cwd: string; cost: number }[];
	bySession: { id: string; title: string; cwd: string; cost: number }[];
	cumulative: { day: string; cost: number }[];
	milestones: { amount: 1 | 10 | 100 | 1000; day: string }[];
	cacheHitByDay: { day: string; ratio: number }[];
}

/** Cost breakdowns; every cost includes cache warm-up spend. */
export function costStats(records: SessionRecord[], range: Range): CostStats {
	const daily = dailySeries(records, range);
	const keys = [...daily.keys()].sort();
	let total = 0;
	let warm = 0;
	const cumulative: { day: string; cost: number }[] = [];
	const cacheHitByDay: { day: string; ratio: number }[] = [];
	for (const k of keys) {
		const d = daily.get(k)!;
		total += d.cost + d.warmCost;
		warm += d.warmCost;
		cumulative.push({ day: k, cost: total });
		if (d.input + d.cacheRead > 0) cacheHitByDay.push({ day: k, ratio: d.cacheRead / (d.input + d.cacheRead) });
	}
	const milestones: CostStats["milestones"] = [];
	for (const amount of [1, 10, 100, 1000] as const) {
		const hit = cumulative.find((c) => c.cost >= amount);
		if (hit) milestones.push({ amount, day: hit.day });
	}
	const byProject = new Map<string, number>();
	const bySession: CostStats["bySession"] = [];
	for (const r of records) {
		const e = r.ev;
		let cost = 0;
		for (let i = 0; i < e.cT.length; i++) if (inRange(e.cT[i]!, range)) cost += e.cCost[i]!;
		for (let i = 0; i < e.eT.length; i++) if (inRange(e.eT[i]!, range) && e.dict[e.eKind[i]!] === "cache_warm") cost += e.eVal[i]! / 1e6;
		if (cost <= 0) continue;
		byProject.set(r.cwd, (byProject.get(r.cwd) ?? 0) + cost);
		bySession.push({ id: r.id, title: sessionTitle(r), cwd: r.cwd, cost });
	}
	return {
		total,
		warm,
		byProject: [...byProject].map(([cwd, cost]) => ({ cwd, cost })).sort((a, b) => b.cost - a.cost),
		bySession: bySession.sort((a, b) => b.cost - a.cost).slice(0, 50),
		cumulative,
		milestones,
		cacheHitByDay,
	};
}

/** Spend this month so far, linear projection to month end, and spent / monthlyBudget (0 when no budget). */
export function budget(records: SessionRecord[], monthlyBudget: number, now: number): { spent: number; projected: number; ratio: number } {
	const d = new Date(now);
	const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
	const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
	const spent = costStats(records, { from: start, to: now + 1 }).total;
	const fraction = Math.max((now - start) / (end - start), 1 / 31 / 24);
	return { spent, projected: spent / fraction, ratio: monthlyBudget > 0 ? spent / monthlyBudget : 0 };
}

/** The `n` longest recorded runs. */
export function longestRuns(records: SessionRecord[], n: number): { id: string; title: string; ms: number; prompt: string }[] {
	return records
		.filter((r) => r.longestRunMs > 0)
		.sort((a, b) => b.longestRunMs - a.longestRunMs)
		.slice(0, n)
		.map((r) => ({ id: r.id, title: sessionTitle(r), ms: r.longestRunMs, prompt: r.longestRunPrompt }));
}

/** Subagent families: roots that have children (parentSession = another record's file). */
export function subagentTree(records: SessionRecord[]): TreeNode[] {
	const byFile = new Map(records.map((r) => [r.file, r]));
	const children = new Map<string, SessionRecord[]>();
	for (const r of records) {
		if (r.parentSession && byFile.has(r.parentSession) && r.parentSession !== r.file) {
			const list = children.get(r.parentSession) ?? [];
			list.push(r);
			children.set(r.parentSession, list);
		}
	}
	const build = (r: SessionRecord, seen: Set<string>): TreeNode => {
		seen.add(r.file);
		const kids = (children.get(r.file) ?? []).filter((c) => !seen.has(c.file)).sort((a, b) => a.created - b.created);
		return { label: sessionTitle(r), children: kids.map((c) => build(c, seen)) };
	};
	return records
		.filter((r) => children.has(r.file) && !(r.parentSession && byFile.has(r.parentSession)))
		.sort((a, b) => b.lastActivity - a.lastActivity)
		.map((r) => build(r, new Set()));
}

// ---------------------------------------------------------------------------------------------
// Memo

const memoStore = new Map<string, { revision: number; value: unknown }>();

/** Cache the last result per key; recompute when `revision` (app.index.revision) changes. */
export function memo<T>(key: string, revision: number, fn: () => T): T {
	const hit = memoStore.get(key);
	if (hit && hit.revision === revision) return hit.value as T;
	const value = fn();
	memoStore.set(key, { revision, value });
	return value;
}
