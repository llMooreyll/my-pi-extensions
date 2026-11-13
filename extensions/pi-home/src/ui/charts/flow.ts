import type { Surface } from "../../term/canvas.ts";
import { strWidth } from "../../term/width.ts";
import { axisLabel, type ChartCtx, fgOf, noData, prog, tooSmall, ellipsis, cut, padCut } from "./common.ts";

/**
 * Simplified sankey: sources on the left, targets on the right, one row per link drawn between
 * them with a line whose weight follows the log-scaled value (`─` light, `━` medium, `█` heavy),
 * value label at the far right. Links are grouped by source (largest first) and a source label is
 * printed only on the first row of its group. Minimum 20 columns x 1 row; rows beyond the height
 * are dropped.
 */
export function flow(s: Surface, links: { from: string; to: string; value: number }[], ctx: ChartCtx): void {
	if (tooSmall(s, ctx, 20, 1)) return;
	const live = links.filter((l) => l.value > 0);
	if (live.length === 0) return noData(s, ctx);
	const pal = ctx.pal;
	const sourceTotal = new Map<string, number>();
	for (const l of live) sourceTotal.set(l.from, (sourceTotal.get(l.from) ?? 0) + l.value);
	const sources = [...sourceTotal.keys()].sort((a, b) => sourceTotal.get(b)! - sourceTotal.get(a)!);
	const sorted = sources.flatMap((src) => live.filter((l) => l.from === src).sort((a, b) => b.value - a.value));
	const rows = sorted.slice(0, s.h);
	const max = Math.max(...live.map((l) => l.value));
	const maxLog = Math.log10(max + 1) || 1;
	const lw = Math.min(Math.max(...rows.map((r) => strWidth(r.from))), Math.floor(s.w / 4));
	const tw = Math.min(Math.max(...rows.map((r) => strWidth(r.to))), Math.floor(s.w / 4));
	const vw = Math.max(...rows.map((r) => strWidth(axisLabel(r.value))));
	const lineW = s.w - lw - tw - vw - 5;
	if (lineW < 3) {
		s.text(0, 0, ellipsis(ctx), pal.dim);
		return;
	}
	const uni = pal.caps.unicode;
	const p = prog(ctx);
	let prev = "";
	rows.forEach((r, y) => {
		if (r.from !== prev) s.text(0, y, padCut(ctx, r.from, lw), pal.text);
		prev = r.from;
		const bucket = Math.log10(r.value + 1) / maxLog;
		const glyph = bucket < 1 / 3 ? (uni ? "─" : "-") : bucket < 2 / 3 ? (uni ? "━" : "=") : uni ? "█" : "#";
		const len = Math.max(1, Math.round((lineW - 1) * p));
		const color = pal.series(sources.indexOf(r.from));
		s.text(lw + 1, y, glyph.repeat(len), fgOf(color));
		s.text(lw + 1 + len, y, uni ? "→" : ">", fgOf(color));
		s.text(lw + lineW + 2, y, cut(ctx, r.to, tw), pal.text);
		s.textIn(lw + lineW + 3 + tw, y, vw + 1, axisLabel(r.value), pal.dim, "right");
	});
}
