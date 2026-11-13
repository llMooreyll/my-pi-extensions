import type { Surface } from "../../term/canvas.ts";
import { strWidth } from "../../term/width.ts";
import { axisLabel, type ChartCtx, fgOf, noData, prog, tooSmall, ellipsis, cut, padCut } from "./common.ts";

function percentile(sorted: number[], q: number): number {
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * Horizontal box plots, one row per group: whiskers p5-p95 (`├─` ... `─┤`), box p25-p75
 * (`▐█▌`), median `┃`; the last row is an axis with the min / max labels. Minimum 16 columns x 2
 * rows. `log` uses log10 positions (values <= 0 ignored); `format` / `money` format the axis
 * labels. Groups beyond the height are dropped; groups without values keep an empty row. A group
 * whose values are all 0 shows "all $0" (or "all 0") in pal.dim instead of a box; with `log`, zeros
 * are left out of the box and counted in the label ("name +12% at $0").
 */
export function boxplot(
	s: Surface,
	groups: { label: string; values: number[] }[],
	ctx: ChartCtx,
	opts: { log?: boolean; money?: boolean; format?: (v: number) => string } = {},
): void {
	if (tooSmall(s, ctx, 16, 2)) return;
	const pal = ctx.pal;
	const zeros = groups.map((g) => g.values.filter((v) => v === 0).length);
	const allZero = groups.map((g, i) => g.values.length > 0 && zeros[i] === g.values.length);
	const zero = opts.money ? "$0" : "0";
	const labelOf = (g: { label: string; values: number[] }, i: number): string =>
		opts.log && zeros[i]! > 0 && !allZero[i] ? `${g.label} +${Math.max(1, Math.round((zeros[i]! / g.values.length) * 100))}% at ${zero}` : g.label;
	const prep = groups.map((g) => g.values.filter((v) => Number.isFinite(v) && (!opts.log || v > 0)).sort((a, b) => a - b));
	if (prep.every((v) => v.length === 0) && !allZero.some(Boolean)) return noData(s, ctx);
	const shown = Math.min(groups.length, s.h - 1);
	const lw = Math.min(Math.max(...groups.slice(0, shown).map((g, i) => strWidth(labelOf(g, i)))), Math.floor(s.w * 0.45));
	const pw = s.w - lw - 1;
	if (pw < 6) {
		s.text(0, 0, ellipsis(ctx), pal.dim);
		return;
	}
	const tf = (v: number): number => (opts.log ? Math.log10(v) : v);
	const live = prep.filter((v) => v.length);
	const lowest = live.length ? Math.min(...live.map((v) => percentile(v, 0.05))) : 0;
	const highest = live.length ? Math.max(...live.map((v) => percentile(v, 0.95))) : 1;
	const lo = tf(lowest);
	const range = tf(highest) - lo || 1;
	const col = (v: number): number => Math.max(0, Math.min(pw - 1, Math.round(((tf(v) - lo) / range) * (pw - 1))));
	const uni = pal.caps.unicode;
	const tier0 = pal.caps.tier === 0;
	const p = prog(ctx);
	const bx = lw + 1;
	for (let g = 0; g < shown; g++) {
		s.text(0, g, padCut(ctx, labelOf(groups[g]!, g), lw), pal.text);
		if (allZero[g]) {
			s.text(bx, g, cut(ctx, `all ${zero}`, pw), pal.dim);
			continue;
		}
		const v = prep[g]!;
		if (v.length === 0) continue;
		const q = [0.05, 0.25, 0.5, 0.75, 0.95].map((k) => col(percentile(v, k)));
		// Progress grows the plot out of the median.
		const grow = (c: number): number => Math.round(q[2]! + (c - q[2]!) * p);
		const [w0, b0, m, b1, w1] = [grow(q[0]!), grow(q[1]!), q[2]!, grow(q[3]!), grow(q[4]!)];
		s.hline(bx + w0, g, w1 - w0 + 1, fgOf(pal.p70), uni ? "─" : "-");
		s.put(bx + w0, g, uni ? "├" : "|", fgOf(pal.p70));
		s.put(bx + w1, g, uni ? "┤" : "|", fgOf(pal.p70));
		const boxFill = !uni ? "=" : tier0 ? "▒" : "█";
		s.hline(bx + b0, g, b1 - b0 + 1, fgOf(pal.p100), boxFill);
		if (uni && !tier0) {
			s.put(bx + b0, g, "▐", fgOf(pal.p100));
			s.put(bx + b1, g, "▌", fgOf(pal.p100));
		}
		s.put(bx + m, g, uni ? "┃" : "#", tier0 || !uni ? pal.strong : { fg: pal.screenBg, bg: pal.p100 });
	}
	const fmt = opts.format ?? ((v: number) => axisLabel(v, opts.money));
	s.hline(bx, s.h - 1, pw, pal.faint, uni ? "─" : "-");
	const minL = cut(ctx, fmt(lowest), pw);
	const maxL = cut(ctx, fmt(highest), pw);
	s.text(bx, s.h - 1, minL, pal.dim);
	if (strWidth(minL) + strWidth(maxL) + 1 <= pw) s.textIn(bx, s.h - 1, pw, maxL, pal.dim, "right");
}
