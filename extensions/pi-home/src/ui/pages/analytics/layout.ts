import { matchesKey } from "@earendil-works/pi-tui";
import { dailySeries, type DayStats, memo } from "../../../index/aggregate.ts";
import { dayKey, defaultFilter, filterSessions, type RangeId, type SessionFilter, startOfDay } from "../../../index/query.ts";
import type { SessionRecord } from "../../../index/types.ts";
import type { Surface } from "../../../term/canvas.ts";
import type { App } from "../../app.ts";
import { drillDown } from "../../nav.ts";
import type { ChartCtx } from "../../charts/index.ts";
import { section } from "../../widgets.ts";

export interface AnalyticsData {
	records: SessionRecord[];
	range: { from: number; to: number };
	rangeId: RangeId;
}

/** One analytics sub-page (a tab inside the ANALYTICS page). */
export interface SubPage {
	draw(s: Surface, app: App, data: AnalyticsData): void;
	/** Return true when the key was consumed. */
	key(data: string, app: App): boolean;
	/** Short status for the rule row, e.g. "PgDn more". Read after draw(). */
	status?: string;
	/** Extra footer hints for this sub-page. */
	hints?: string;
}

/** State shared between the ANALYTICS shell and its sub-pages. */
export const view = {
	includeSubagents: false,
	/** Start of the chart grow-in animation; reset on page enter, sub-tab and range change. */
	animStart: 0,
};

export function restartAnimation(app: App): void {
	view.animStart = Date.now();
	app.animate(550);
}

/** Eased 0..1 grow-in progress that restarts with restartAnimation(). */
export function chartProgress(app: App): number {
	if (!app.motion) return 1;
	const t = Math.min(1, (Date.now() - view.animStart) / 500);
	if (t < 1) app.animate(500);
	return 1 - (1 - t) ** 3;
}

export function chartCtx(app: App): ChartCtx {
	return { pal: app.pal, progress: chartProgress(app) };
}

/** Memoise per index revision, subagent toggle and calendar day. */
export function cachedBy<T>(app: App, key: string, fn: () => T): T {
	return memo(`${key}|${view.includeSubagents}|${dayKey(Date.now())}`, app.index.revision, fn);
}

/** Memoise a computation over the current range. */
export function cached<T>(app: App, data: AnalyticsData, name: string, fn: () => T): T {
	return cachedBy(app, `${name}|${data.rangeId}`, fn);
}

/** All records (respecting the subagent toggle), regardless of range. */
export function allRecords(app: App): SessionRecord[] {
	return cachedBy(app, "allRecords", () => filterSessions(app.index.records.values(), { ...defaultFilter(), includeSubagents: view.includeSubagents }));
}

/** Per-day totals over all records. */
export function allDaily(app: App): Map<string, DayStats> {
	return cachedBy(app, "allDaily", () => dailySeries(allRecords(app), { from: 0, to: Number.POSITIVE_INFINITY }));
}

/** [from, to) in ms of the local day with key "YYYY-MM-DD". */
export function dayRange(key: string): { from: number; to: number } {
	const [y, m, d] = key.split("-").map(Number) as [number, number, number];
	return { from: new Date(y, m - 1, d).getTime(), to: new Date(y, m - 1, d + 1).getTime() };
}

/** Day key `delta` days after `key`. */
export function shiftDay(key: string, delta: number): string {
	const [y, m, d] = key.split("-").map(Number) as [number, number, number];
	return dayKey(new Date(y, m - 1, d + delta).getTime());
}

/** The last `n` day keys ending today, oldest first. */
export function lastDays(n: number): string[] {
	const today = dayKey(startOfDay(Date.now()));
	return Array.from({ length: n }, (_, i) => shiftDay(today, i - (n - 1)));
}

// ---------------------------------------------------------------------------------------------
// Panel grid

export interface Panel {
	title: string;
	/** Text right-aligned on the title row. */
	right?: string;
	/** Share of the row width (default 1); ignored when `w` is set. */
	weight?: number;
	/** Fixed width in columns. */
	w?: number;
	/** Draw into the area below the title (full panel area when `bare`). */
	draw(s: Surface, ctx: ChartCtx): void;
	/** Draw without section title (the panel gets the whole area). */
	bare?: boolean;
}

/** A row of side-by-side panels. Heights include the 2 title rows. */
export interface Row {
	min: number;
	pref: number;
	panels: Panel[];
}

/**
 * Base class of grid sub-pages: subclasses return rows of panels for the current width. Rows are
 * stacked with a 1-row gap; rows that do not fit at their minimum height are dropped from the
 * bottom (never overlapped), spare height goes to the rows top-down up to their preferred height.
 * Up/Down (and PgUp/PgDn) scroll by whole rows.
 */
export abstract class GridPage implements SubPage {
	status = "";
	hints = "up/down scroll panels  PgUp/PgDn page";
	protected scroll = 0;
	private rowCount = 0;
	private visible = 0;

	protected abstract rows(app: App, data: AnalyticsData, width: number): Row[];

	/** Subclass key handling before scrolling. */
	protected pageKey(_data: string, _app: App): boolean {
		return false;
	}

	/** True when Up/Down belong to the sub-page (cursor); only PgUp/PgDn scroll then. */
	protected ownsArrows = false;

	draw(s: Surface, app: App, data: AnalyticsData): void {
		const rows = this.rows(app, data, s.w);
		this.rowCount = rows.length;
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - 1)));
		const fit: number[] = [];
		let used = 0;
		for (let i = this.scroll; i < rows.length; i++) {
			const need = rows[i]!.min + (fit.length ? 1 : 0);
			if (used + need > s.h) break;
			fit.push(i);
			used += need;
		}
		if (fit.length === 0 && rows.length > 0) fit.push(this.scroll);
		this.visible = Math.max(1, fit.length);
		let extra = Math.max(0, s.h - used);
		const heights = fit.map((i) => {
			const grow = Math.min(extra, rows[i]!.pref - rows[i]!.min);
			extra -= grow;
			return rows[i]!.min + grow;
		});
		const ctx = chartCtx(app);
		let y = 0;
		fit.forEach((ri, k) => {
			const row = rows[ri]!;
			const h = heights[k]!;
			this.drawRow(s.sub(0, y, s.w, h), app, row, ctx);
			y += h + 1;
		});
		const below = rows.length - (this.scroll + fit.length);
		this.status = below > 0 ? `PgDn ${below} more` : this.scroll > 0 ? "PgUp" : "";
	}

	private drawRow(s: Surface, app: App, row: Row, ctx: ChartCtx): void {
		const gap = 2;
		const fixed = row.panels.reduce((a, p) => a + (p.w ?? 0), 0);
		const totalWeight = row.panels.reduce((a, p) => a + (p.w ? 0 : (p.weight ?? 1)), 0) || 1;
		const free = Math.max(0, s.w - fixed - gap * (row.panels.length - 1));
		let x = 0;
		let given = 0;
		let weightSeen = 0;
		for (const p of row.panels) {
			let w: number;
			if (p.w) w = p.w;
			else {
				weightSeen += p.weight ?? 1;
				const target = Math.round((free * weightSeen) / totalWeight);
				w = target - given;
				given = target;
			}
			const ps = s.sub(x, 0, w, s.h);
			if (p.bare) p.draw(ps, ctx);
			else {
				section(ps, 0, 0, w, p.title, app.pal, p.right);
				p.draw(ps.sub(0, 2, w, s.h - 2), ctx);
			}
			x += w + gap;
		}
	}

	key(data: string, app: App): boolean {
		if (this.pageKey(data, app)) return true;
		const page = Math.max(1, this.visible);
		const set = (n: number): boolean => {
			this.scroll = Math.max(0, Math.min(n, Math.max(0, this.rowCount - 1)));
			return true;
		};
		if (matchesKey(data, "pageDown")) return set(this.scroll + page);
		if (matchesKey(data, "pageUp")) return set(this.scroll - page);
		if (this.ownsArrows) return false;
		if (matchesKey(data, "down")) return set(this.scroll + 1);
		if (matchesKey(data, "up")) return set(this.scroll - 1);
		return false;
	}
}

/** drillDown() over the current range and subagent toggle; `patch` wins. */
export function drill(app: App, data: AnalyticsData, patch: Partial<SessionFilter>, label: string): void {
	drillDown(app, { from: data.range.from, to: data.range.to, includeSubagents: view.includeSubagents, ...patch }, label);
}

/** drillDown() onto one local day ("YYYY-MM-DD"). */
export function drillDay(app: App, day: string): void {
	drillDown(app, { ...dayRange(day), includeSubagents: view.includeSubagents }, day);
}
