import type { Surface } from "../../term/canvas.ts";
import type { RGB } from "../../term/color.ts";
import { strWidth } from "../../term/width.ts";
import { type ChartCtx, fgOf, noData, prog, tooSmall, ellipsis, cut, padCut } from "./common.ts";

function defaultTick(t: number): string {
	const d = new Date(t);
	return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Gantt chart: one row per item with its label and a bar from `start` to `end` (ms) on the time
 * axis `from`..`to`; tick labels (default `MM-DD`) on the last row. Bars are background-filled in
 * colour tiers, `█` / `#` otherwise. Minimum 12 columns x 2 rows. `labelWidth` fixes the label
 * column (default widest label, at most 35% of the width); `onClick` is registered per row.
 * Rows beyond the height are dropped; items entirely outside the range are not drawn.
 */
export function gantt(
	s: Surface,
	rows: { label: string; start: number; end: number; color?: RGB; onClick?: () => void }[],
	from: number,
	to: number,
	ctx: ChartCtx,
	opts: { labelWidth?: number; tickFormat?: (t: number) => string } = {},
): void {
	if (tooSmall(s, ctx, 12, 2)) return;
	if (rows.length === 0 || !(to > from)) return noData(s, ctx);
	const pal = ctx.pal;
	const shown = rows.slice(0, s.h - 1);
	const lw = Math.min(opts.labelWidth ?? Math.max(...shown.map((r) => strWidth(r.label))), Math.floor(s.w * 0.35));
	const bx = lw + 1;
	const pw = s.w - bx;
	if (pw < 4) {
		s.text(0, 0, ellipsis(ctx), pal.dim);
		return;
	}
	const col = (t: number): number => Math.max(0, Math.min(pw - 1, Math.floor(((t - from) / (to - from)) * pw)));
	const solid = pal.caps.tier === 0 || !pal.caps.unicode;
	const p = prog(ctx);
	shown.forEach((r, y) => {
		s.text(0, y, padCut(ctx, r.label, lw), pal.text);
		if (r.end >= from && r.start <= to) {
			const a = col(r.start);
			const w = Math.max(1, Math.round((col(r.end) - a + 1) * p));
			const color = r.color ?? pal.p70;
			if (solid) s.hline(bx + a, y, w, fgOf(color), pal.caps.unicode ? "█" : "#");
			else s.fill(bx + a, y, w, 1, { bg: color, fg: pal.text.fg }, " ");
		}
		const onClick = r.onClick;
		if (onClick) s.hit(0, y, s.w, 1, { onClick: () => onClick() });
	});
	const fmt = opts.tickFormat ?? defaultTick;
	const n = Math.max(2, Math.min(6, Math.floor(pw / 12)));
	let lastEnd = bx - 1;
	for (let k = 0; k < n; k++) {
		const x = bx + Math.floor((k * (pw - 1)) / (n - 1));
		const lab = fmt(from + ((to - from) * k) / (n - 1));
		const w = strWidth(lab);
		// The last tick is right-aligned so it stays inside the surface.
		const px = k === n - 1 ? s.w - w : x;
		if (px <= lastEnd || px < bx) continue;
		s.text(px, s.h - 1, cut(ctx, lab, s.w - px), pal.dim);
		lastEnd = px + w;
	}
}
