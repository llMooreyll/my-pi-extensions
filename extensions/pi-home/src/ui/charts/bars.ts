import type { Style, Surface } from "../../term/canvas.ts";
import type { RGB } from "../../term/color.ts";
import { strWidth } from "../../term/width.ts";
import { axisLabel, type ChartCtx, fgOf, LEFT, LOWER, niceMax, noData, prog, seriesGlyph, tooSmall, ellipsis, cut, padCut } from "./common.ts";

export interface BarItem {
	label: string;
	value: number;
	color?: RGB;
	/** Sub-amount drawn in pal.err (e.g. errors). */
	part?: number;
	/** Text right of the bar; default axisLabel(value). */
	valueLabel?: string;
}

/**
 * Horizontal bar list, one row per item: label, bar with 1/8-cell precision, value label right of
 * the bar. Minimum 8 columns x 1 row. `opts.labelWidth` fixes the label column (default: widest
 * label, at most 40% of the width); `opts.max` fixes the scale (default: largest value);
 * `opts.onClick(i)` is registered per row. Items beyond the surface height are dropped.
 */
export function hbars(
	s: Surface,
	items: BarItem[],
	ctx: ChartCtx,
	opts: { labelWidth?: number; max?: number; onClick?: (i: number) => void } = {},
): void {
	if (tooSmall(s, ctx, 8, 1)) return;
	const max = opts.max ?? Math.max(0, ...items.map((i) => i.value));
	if (items.length === 0 || !(max > 0)) return noData(s, ctx);
	const pal = ctx.pal;
	const rows = items.slice(0, s.h);
	const labels = rows.map((it) => it.valueLabel ?? axisLabel(it.value));
	const vlw = Math.max(...labels.map(strWidth));
	const lw = Math.min(opts.labelWidth ?? Math.max(...rows.map((it) => strWidth(it.label))), Math.floor(s.w * 0.4));
	const bw = s.w - lw - 1 - vlw - 1;
	if (bw < 1) {
		s.text(0, 0, ellipsis(ctx), pal.dim);
		return;
	}
	const p = prog(ctx);
	const uni = pal.caps.unicode;
	const tier0 = pal.caps.tier === 0;
	rows.forEach((it, y) => {
		s.text(0, y, padCut(ctx, it.label, lw), pal.text);
		const color = it.color ?? pal.p100;
		const total = Math.round((Math.max(0, it.value) / max) * bw * 8 * p);
		const t8 = Math.min(total, bw * 8);
		const part8 = it.part && it.part > 0 ? Math.min(t8, Math.max(1, Math.round((it.part / max) * bw * 8 * p))) : 0;
		const boundary = t8 - part8;
		let cells = 0;
		for (let c = 0; c * 8 < t8; c++) {
			const fill = Math.min(8, t8 - c * 8);
			const isErr = part8 > 0 && c * 8 + 4 >= boundary && fill > 0;
			let ch: string;
			if (!uni) ch = isErr ? "=" : "#";
			else if (tier0 && isErr) ch = "▒";
			else ch = LEFT[fill]!;
			s.text(lw + 1 + c, y, ch, fgOf(isErr ? pal.err : color));
			cells = c + 1;
		}
		s.text(lw + 1 + cells + 1, y, cut(ctx, labels[y]!, s.w - (lw + 1 + cells + 1)), pal.dim);
	});
	const onClick = opts.onClick;
	if (onClick) rows.forEach((_, i) => s.hit(0, i, s.w, 1, { onClick: () => onClick(i) }));
}

/** Average `columns` into at most n groups (each group = mean of its stacks). Returns group → first source index. */
function pool(columns: number[][], n: number): { cols: number[][]; first: number[] } {
	if (columns.length <= n) return { cols: columns, first: columns.map((_, i) => i) };
	const k = Math.ceil(columns.length / n);
	const cols: number[][] = [];
	const first: number[] = [];
	for (let a = 0; a < columns.length; a += k) {
		const grp = columns.slice(a, a + k);
		const depth = Math.max(...grp.map((g) => g.length));
		cols.push(Array.from({ length: depth }, (_, d) => grp.reduce((t, g) => t + (g[d] ?? 0), 0) / grp.length));
		first.push(a);
	}
	return { cols, first };
}

function drawXLabels(ctx: ChartCtx, s: Surface, y: number, x0: number, slot: (g: number) => number, first: number[], labels: string[], style: Style): void {
	let lastEnd = x0 - 1;
	first.forEach((src, g) => {
		const lab = labels[src];
		if (!lab) return;
		const x = x0 + slot(g);
		const t = cut(ctx, lab, Math.max(1, s.w - x));
		if (x <= lastEnd || x >= s.w) return;
		s.text(x, y, t, style);
		lastEnd = x + strWidth(t);
	});
}

/**
 * Stacked vertical columns; each `columns[i]` is one column's stack, bottom to top, coloured by
 * `colors[stackIndex]`. 1/8-cell precision. Minimum 6 columns x 3 rows. Options: `xLabels` on the
 * last row (labels that would overlap are skipped), `max` fixed scale (default nice max of the
 * tallest stack), `yAxis` three ticks (0, half, max) with `money` formatting, `onClick(i)` per
 * column. More columns than cells are averaged into groups.
 */
export function vbars(
	s: Surface,
	columns: number[][],
	colors: RGB[],
	ctx: ChartCtx,
	opts: { xLabels?: string[]; max?: number; onClick?: (i: number) => void; yAxis?: boolean; money?: boolean } = {},
): void {
	if (tooSmall(s, ctx, 6, 3)) return;
	const rawMax = Math.max(0, ...columns.map((c) => c.reduce((a, b) => a + Math.max(0, b), 0)));
	const max = opts.max ?? niceMax(rawMax);
	if (columns.length === 0 || !(rawMax > 0) || !(max > 0)) return noData(s, ctx);
	const pal = ctx.pal;
	const uni = pal.caps.unicode;
	const plotH = s.h - (opts.xLabels ? 1 : 0);
	const ticks = opts.yAxis ? [max, max / 2, 0].map((v) => axisLabel(v, opts.money)) : [];
	const aw = opts.yAxis ? Math.max(...ticks.map(strWidth)) + 1 : 0;
	const pw = s.w - aw;
	if (pw < 2 || plotH < 2) {
		s.text(0, 0, ellipsis(ctx), pal.dim);
		return;
	}
	if (opts.yAxis) {
		s.vline(aw - 1, 0, plotH, pal.faint, uni ? "│" : "|");
		s.textIn(0, 0, aw - 1, ticks[0]!, pal.dim, "right");
		if (plotH > 4) s.textIn(0, Math.floor((plotH - 1) / 2), aw - 1, ticks[1]!, pal.dim, "right");
		s.textIn(0, plotH - 1, aw - 1, ticks[2]!, pal.dim, "right");
	}
	const { cols, first } = pool(columns, pw);
	// Columns share the whole width: slot g spans [slot(g), slot(g + 1)); the bar sits centred in it.
	const slot = (g: number): number => Math.round((g * pw) / cols.length);
	const H = plotH * 8;
	const p = prog(ctx);
	const nStack = colors.length;
	cols.forEach((stack, g) => {
		// Cumulative boundaries in eighths of the plot height.
		const bounds: number[] = [];
		let cum = 0;
		for (const v of stack) {
			cum += Math.max(0, v);
			bounds.push(Math.min(H, Math.round((cum / max) * H * p)));
		}
		const top = bounds.length ? bounds[bounds.length - 1]! : 0;
		const segAt = (e: number): number => {
			const k = bounds.findIndex((b) => e < b);
			return k < 0 ? bounds.length - 1 : k;
		};
		for (let r = 0; r < plotH; r++) {
			const base = r * 8;
			const filled = Math.min(8, Math.max(0, top - base));
			if (filled === 0) continue;
			const y = plotH - 1 - r;
			const lo = segAt(base);
			const hi = segAt(base + filled - 1);
			let ch: string;
			let style: Style;
			if (!uni) {
				if (filled < 4) continue;
				ch = seriesGlyph(ctx, hi, nStack);
				style = fgOf(colors[hi] ?? pal.p100);
			} else if (pal.caps.tier === 0) {
				ch = filled === 8 ? seriesGlyph(ctx, hi, nStack) : LOWER[filled]!;
				style = fgOf(colors[hi] ?? pal.p100);
			} else if (lo === hi || filled < 8) {
				ch = LOWER[filled]!;
				style = fgOf(colors[hi] ?? pal.p100);
			} else {
				const split = Math.max(1, Math.min(7, bounds[lo]! - base));
				ch = LOWER[split]!;
				style = { fg: colors[lo] ?? pal.p100, bg: colors[hi] ?? pal.p100 };
			}
			const sw = slot(g + 1) - slot(g);
			const bw = sw >= 2 ? sw - 1 : 1;
			const bx = aw + slot(g) + Math.floor((sw - bw) / 2);
			for (let k = 0; k < bw; k++) s.text(bx + k, y, ch, style);
		}
	});
	if (opts.xLabels) drawXLabels(ctx, s, s.h - 1, aw, slot, first, opts.xLabels, pal.dim);
	const onClick = opts.onClick;
	if (onClick) cols.forEach((_, g) => s.hit(aw + slot(g), 0, slot(g + 1) - slot(g), plotH, { onClick: () => onClick(first[g]!) }));
}

/**
 * Mirror bars around a centre line: `up` in pal.ok above, `down` in pal.err below (GitHub
 * additions / deletions). Up bars have 1/8 precision, down bars half-cell precision. Minimum
 * 4 columns x 3 rows. `opts.xLabels` go on the last row. More columns than cells are max-pooled.
 */
export function mirrorBars(s: Surface, up: number[], down: number[], ctx: ChartCtx, opts: { xLabels?: string[] } = {}): void {
	if (tooSmall(s, ctx, 4, 3)) return;
	const n = Math.max(up.length, down.length);
	const maxV = Math.max(0, ...up, ...down);
	if (n === 0 || !(maxV > 0)) return noData(s, ctx);
	const pal = ctx.pal;
	const uni = pal.caps.unicode;
	const plotH = s.h - (opts.xLabels ? 1 : 0);
	if (plotH < 3) {
		s.text(0, 0, ellipsis(ctx), pal.dim);
		return;
	}
	const cy = Math.floor(plotH / 2);
	const upH = cy;
	const downH = plotH - cy - 1;
	s.hline(0, cy, s.w, pal.faint, uni ? "─" : "-");
	const groups = Math.min(n, s.w);
	const k = Math.ceil(n / groups);
	const nGroups = Math.ceil(n / k);
	const slot = (g: number): number => Math.round((g * s.w) / nGroups);
	const p = prog(ctx);
	const poolMax = (arr: number[], g: number): number => {
		let m = 0;
		for (let i = g * k; i < Math.min(arr.length, (g + 1) * k); i++) m = Math.max(m, arr[i]!);
		return m;
	};
	const first: number[] = [];
	for (let g = 0; g < nGroups; g++) {
		first.push(g * k);
		const sw = slot(g + 1) - slot(g);
		const bw = sw >= 2 ? sw - 1 : 1;
		const bx = slot(g) + Math.floor((sw - bw) / 2);
		const u8 = Math.round((poolMax(up, g) / maxV) * upH * 8 * p);
		for (let r = 0; r * 8 < u8; r++) {
			const fill = Math.min(8, u8 - r * 8);
			const ch = uni ? LOWER[fill]! : "#";
			for (let b = 0; b < bw; b++) s.text(bx + b, cy - 1 - r, ch, fgOf(pal.ok));
		}
		const d2 = Math.round((poolMax(down, g) / maxV) * downH * 2 * p);
		for (let r = 0; r * 2 < d2; r++) {
			const half = d2 - r * 2 === 1;
			const ch = !uni ? "=" : pal.caps.tier === 0 ? "▒" : half ? "▀" : "█";
			for (let b = 0; b < bw; b++) s.text(bx + b, cy + 1 + r, ch, fgOf(pal.err));
		}
	}
	if (opts.xLabels) drawXLabels(ctx, s, s.h - 1, 0, slot, first, opts.xLabels, pal.dim);
}
