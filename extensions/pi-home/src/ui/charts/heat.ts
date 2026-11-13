import { dayKey, startOfDay } from "../../index/query.ts";
import type { Surface } from "../../term/canvas.ts";
import { type ChartCtx, fgOf, noData, tooSmall } from "./common.ts";

const ASCII_RAMP = ".:-=+*#@";

function cellGlyph(ctx: ChartCtx, v: number): string {
	const pal = ctx.pal;
	if (!pal.caps.unicode) return ASCII_RAMP[Math.max(0, Math.min(7, Math.round(v * 7)))]!;
	return pal.rampGlyph(v);
}

/**
 * Heat grid with rows x cols cells at (x, y). `value(r, c)` returns 0..1 or NaN for "no cell".
 * Each cell is `cellW` (default 2) glyphs wide, coloured by pal.ramp (density glyph in tier 0,
 * ASCII ramp without unicode). `cursor` is drawn with pal.sel. Minimum: the grid must fit
 * (x + cols*cellW <= width, y + rows <= height), else "…". `onClick(r, c)` is one hit region
 * over the grid.
 */
export function heatGrid(
	s: Surface,
	x: number,
	y: number,
	rows: number,
	cols: number,
	value: (r: number, c: number) => number,
	ctx: ChartCtx,
	opts: { cellW?: 1 | 2; cursor?: { r: number; c: number }; onClick?: (r: number, c: number) => void } = {},
): void {
	const cw = opts.cellW ?? 2;
	if (rows <= 0 || cols <= 0) return noData(s, ctx);
	if (tooSmall(s, ctx, x + cols * cw, y + rows)) return;
	const pal = ctx.pal;
	let any = false;
	for (let r = 0; r < rows && !any; r++) for (let c = 0; c < cols; c++) if (value(r, c) > 0) any = true;
	if (!any) return noData(s, ctx);
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const v = value(r, c);
			if (Number.isNaN(v)) continue;
			const cur = opts.cursor && opts.cursor.r === r && opts.cursor.c === c;
			if (cur) s.text(x + c * cw, y + r, (pal.caps.unicode ? "▒" : "#").repeat(cw), pal.sel);
			else s.text(x + c * cw, y + r, cellGlyph(ctx, v).repeat(cw), fgOf(pal.ramp(v)));
		}
	}
	const onClick = opts.onClick;
	if (onClick) {
		s.hit(x, y, cols * cw, rows, {
			onClick: (m) => onClick(Math.max(0, Math.min(rows - 1, m.y)), Math.max(0, Math.min(cols - 1, Math.floor(m.x / cw)))),
		});
	}
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LABEL_W = 4;

/**
 * GitHub-style contribution calendar: 7 rows Mon..Sun, one `██` column per week ending with the
 * week of `endDay` (ms, default now), month labels on the row above, `Mon`/`Wed`/`Fri` on the
 * left. `days` maps dayKey() strings to values; colour = value / max. `weeks` defaults to 53 and
 * is reduced to what fits. Minimum 12 columns x 8 rows. `cursor` is a dayKey drawn with pal.sel;
 * `onClick(day)` receives the dayKey of the clicked cell.
 */
export function calendarHeat(
	s: Surface,
	days: Map<string, number>,
	ctx: ChartCtx,
	opts: { weeks?: number; endDay?: number; cursor?: string; onClick?: (day: string) => void } = {},
): void {
	if (tooSmall(s, ctx, LABEL_W + 8, 8)) return;
	const pal = ctx.pal;
	let max = 0;
	for (const v of days.values()) max = Math.max(max, v);
	if (!(max > 0)) return noData(s, ctx);
	const weeks = Math.max(1, Math.min(opts.weeks ?? 53, Math.floor((s.w - LABEL_W) / 2)));
	const end = new Date(startOfDay(opts.endDay ?? Date.now()));
	const endMonday = new Date(end);
	endMonday.setDate(end.getDate() - ((end.getDay() + 6) % 7));
	const dayAt = (c: number, r: number): Date => {
		const d = new Date(endMonday);
		d.setDate(endMonday.getDate() - (weeks - 1 - c) * 7 + r);
		return d;
	};
	const unicode = pal.caps.unicode;
	const glyph = (v: number): string => cellGlyph(ctx, v).repeat(2);
	[0, 2, 4].forEach((r, i) => s.text(0, 1 + r, ["Mon", "Wed", "Fri"][i]!, pal.dim));
	let lastMonth = -1;
	let lastLabelEnd = -1;
	const keys: string[][] = [];
	for (let c = 0; c < weeks; c++) {
		const col: string[] = [];
		const monday = dayAt(c, 0);
		const x = LABEL_W + c * 2;
		if (monday.getMonth() !== lastMonth) {
			lastMonth = monday.getMonth();
			if (x > lastLabelEnd) {
				s.text(x, 0, MONTHS[lastMonth]!, pal.dim);
				lastLabelEnd = x + 3;
			}
		}
		for (let r = 0; r < 7; r++) {
			const d = dayAt(c, r);
			const key = dayKey(d.getTime());
			col.push(key);
			if (d.getTime() > end.getTime()) continue;
			const v = Math.min(1, (days.get(key) ?? 0) / max);
			if (key === opts.cursor) s.text(x, 1 + r, (unicode ? "▒" : "#").repeat(2), pal.sel);
			else s.text(x, 1 + r, glyph(v), fgOf(pal.ramp(v)));
		}
		keys.push(col);
	}
	const onClick = opts.onClick;
	if (onClick) {
		s.hit(LABEL_W, 1, weeks * 2, 7, {
			onClick: (m) => {
				const key = keys[Math.max(0, Math.min(weeks - 1, Math.floor(m.x / 2)))]?.[Math.max(0, Math.min(6, m.y))];
				if (key) onClick(key);
			},
		});
	}
}
