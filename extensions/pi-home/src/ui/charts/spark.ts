import type { Style, Surface } from "../../term/canvas.ts";
import { type ChartCtx, prog, tooSmall } from "./common.ts";

const LEVELS = "▁▂▃▄▅▆▇█";
const ASCII_LEVELS = "._-=+*#%";

/**
 * One-row sparkline of `▁▂▃▄▅▆▇█` at (x, y), width w. `values` are resampled to w columns by
 * max-pooling (stretched when fewer than w). Minimum: 1 row, w >= 1 columns inside the surface.
 * `style` is the text style (usually { fg }). ctx.progress scales the heights.
 */
export function sparkline(s: Surface, x: number, y: number, w: number, values: number[], style: Style, ctx: ChartCtx): void {
	const width = Math.min(w, s.w - x);
	if (tooSmall(s, ctx, 1, 1) || width < 1 || y < 0 || y >= s.h) return;
	const max = Math.max(0, ...values);
	if (values.length === 0 || !(max > 0)) {
		s.textIn(x, y, width, "NO DATA", ctx.pal.dim);
		return;
	}
	const n = values.length;
	const p = prog(ctx);
	const levels = ctx.pal.caps.unicode ? LEVELS : ASCII_LEVELS;
	let out = "";
	for (let c = 0; c < width; c++) {
		const a = Math.floor((c * n) / width);
		const b = Math.max(a + 1, Math.floor(((c + 1) * n) / width));
		let m = 0;
		for (let i = a; i < b && i < n; i++) m = Math.max(m, values[i]!);
		out += levels[Math.max(0, Math.min(7, Math.round((m / max) * p * 7)))];
	}
	s.text(x, y, out, style);
}
