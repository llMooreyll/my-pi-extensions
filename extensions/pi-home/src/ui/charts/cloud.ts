import type { Surface } from "../../term/canvas.ts";
import { strWidth } from "../../term/width.ts";
import { type ChartCtx, noData, prog, tooSmall, cut } from "./common.ts";

/**
 * Tag cloud: words sorted by weight and wrapped into lines, two spaces between words. Four
 * weight bands relative to the heaviest word: >= 75% pal.strong, >= 50% pal.text, >= 25%
 * pal.title, else pal.dim. Minimum 6 columns x 1 row. Words that do not fit are dropped; words
 * appear one after another as progress grows.
 */
export function tagCloud(s: Surface, words: { text: string; weight: number }[], ctx: ChartCtx): void {
	if (tooSmall(s, ctx, 6, 1)) return;
	const live = words.filter((w) => w.weight > 0 && w.text).sort((a, b) => b.weight - a.weight);
	if (live.length === 0) return noData(s, ctx);
	const pal = ctx.pal;
	const max = live[0]!.weight;
	const shown = Math.ceil(live.length * prog(ctx));
	let x = 0;
	let y = 0;
	for (const w of live.slice(0, shown)) {
		const t = cut(ctx, w.text, s.w);
		const tw = strWidth(t);
		if (x > 0 && x + tw > s.w) {
			x = 0;
			y++;
		}
		if (y >= s.h) break;
		const r = w.weight / max;
		s.text(x, y, t, r >= 0.75 ? pal.strong : r >= 0.5 ? pal.text : r >= 0.25 ? pal.title : pal.dim);
		x += tw + 2;
	}
}
