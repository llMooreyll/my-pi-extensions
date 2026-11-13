import type { Surface } from "../../term/canvas.ts";
import type { RGB } from "../../term/color.ts";
import { strWidth } from "../../term/width.ts";
import { type ChartCtx, fgOf, noData, prog, seriesGlyph, tooSmall, cut, padCut } from "./common.ts";

/** Largest-remainder rounding of `values` to integer cell counts summing to `n`. */
function apportion(values: number[], n: number): number[] {
	const total = values.reduce((a, b) => a + b, 0);
	const quota = values.map((v) => (v / total) * n);
	const cells = quota.map(Math.floor);
	let left = n - cells.reduce((a, b) => a + b, 0);
	const order = quota.map((q, i) => ({ i, f: q - Math.floor(q) })).sort((a, b) => b.f - a.f);
	for (let k = 0; left > 0 && order.length > 0; k = (k + 1) % order.length, left--) cells[order[k]!.i]!++;
	return cells;
}

/**
 * Waffle chart at (x, y): `cols` x `rows` (default 10 x 10) cells, each `▀▀` plus one space (3
 * columns, roughly square; tier 0 repeats the density glyph twice), filled row by row with largest-remainder rounding so the cells sum to cols*rows; legend with
 * percentages to the right when it fits. Minimum: grid fits (x + cols*2 <= width, y + rows <=
 * height), else "…". Cells appear in order as progress grows; the rest show `·`.
 */
export function waffle(
	s: Surface,
	x: number,
	y: number,
	parts: { value: number; color: RGB; label: string }[],
	ctx: ChartCtx,
	opts: { cols?: number; rows?: number } = {},
): void {
	const cols = opts.cols ?? 10;
	const rows = opts.rows ?? 10;
	const pal = ctx.pal;
	const live = parts.filter((p) => p.value > 0);
	if (live.length === 0) return noData(s, ctx);
	if (tooSmall(s, ctx, x + cols * 3, y + rows)) return;
	const total = live.reduce((a, b) => a + b.value, 0);
	const counts = apportion(
		live.map((p) => p.value),
		cols * rows,
	);
	const shown = Math.ceil(cols * rows * prog(ctx));
	let idx = 0;
	live.forEach((part, pi) => {
		const g = ctx.pal.caps.unicode && ctx.pal.caps.tier !== 0 ? "▀" : seriesGlyph(ctx, pi, live.length);
		for (let k = 0; k < counts[pi]!; k++, idx++) {
			const cx = x + (idx % cols) * 3;
			const cy = y + Math.floor(idx / cols);
			if (idx < shown) s.text(cx, cy, g + g, fgOf(part.color));
			else s.text(cx, cy, pal.caps.unicode ? "··" : "..", pal.faint);
		}
	});
	const lx = x + cols * 3 + 1;
	if (lx + 8 > s.w) return;
	live.slice(0, Math.max(0, s.h - y)).forEach((part, i) => {
		const pct = `${Math.round((part.value / total) * 100)}%`;
		const labelW = s.w - lx - 2 - strWidth(pct) - 1;
		s.text(lx, y + i, seriesGlyph(ctx, i, live.length), fgOf(part.color));
		if (labelW > 0) s.text(lx + 2, y + i, padCut(ctx, cut(ctx, part.label, labelW), labelW), pal.text);
		s.text(lx + 2 + Math.max(0, labelW) + 1, y + i, pct, pal.dim);
	});
}
