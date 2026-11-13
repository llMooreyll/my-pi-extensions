import type { Style, Surface } from "../../term/canvas.ts";
import type { RGB } from "../../term/color.ts";
import { strWidth, truncate } from "../../term/width.ts";
import type { Palette } from "../../theme.ts";

export interface ChartCtx {
	pal: Palette;
	/** Grow-in progress 0..1 (from app.progress()); multiply drawn magnitudes by it. Default 1. */
	progress?: number;
}

/** Progress clamped to 0..1 (default 1). */
export function prog(ctx: ChartCtx): number {
	const p = ctx.progress ?? 1;
	return p < 0 ? 0 : p > 1 ? 1 : p;
}

/** Lower-block levels 0..8 (index = eighths filled from the bottom). */
export const LOWER = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
/** Left-block levels 0..8 (index = eighths filled from the left). */
export const LEFT = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
const ASCII_SERIES = ["#", "=", "+", "*", ":", "-"];

/** Glyph for the up / down trend arrows and the line-chart marker (VISUAL.md §7 whitelist). */
export const trendGlyph = (ctx: ChartCtx, up: boolean): string => (ctx.pal.caps.unicode ? (up ? "↑" : "↓") : up ? "^" : "v");
export const markerGlyph = (ctx: ChartCtx): string => (ctx.pal.caps.unicode ? "↓" : "v");

/**
 * Fill glyph for series i of n. Colour tiers: "█". Tier 0: density glyph so series stay apart
 * without colour. No unicode: ASCII letters.
 */
export function seriesGlyph(ctx: ChartCtx, i: number, n: number): string {
	if (!ctx.pal.caps.unicode) return ASCII_SERIES[i % ASCII_SERIES.length]!;
	if (ctx.pal.caps.tier !== 0) return "█";
	return ctx.pal.rampGlyph(n <= 1 ? 1 : 1 - (0.7 * i) / (n - 1));
}

/** "…" (R4 marker), "." without unicode. */
export const ellipsis = (ctx: ChartCtx): string => (ctx.pal.caps.unicode ? "…" : ".");

/** truncate() with an ASCII ellipsis when unicode is off. */
export const cut = (ctx: ChartCtx, str: string, w: number): string => truncate(str, w, ctx.pal.caps.unicode ? "…" : ".");

/** cut() padded with spaces to exactly w cells. */
export function padCut(ctx: ChartCtx, str: string, w: number): string {
	const t = cut(ctx, str, w);
	return t + " ".repeat(Math.max(0, w - strWidth(t)));
}

/** Style with only a foreground colour. */
export const fgOf = (c: RGB): Style => ({ fg: c });

/** Draw "NO DATA" centred in pal.dim. Every chart calls this when it has nothing to show. */
export function noData(s: Surface, ctx: ChartCtx): void {
	if (s.w <= 0 || s.h <= 0) return;
	s.textIn(0, Math.floor((s.h - 1) / 2), s.w, truncate("NO DATA", s.w), ctx.pal.dim, "center");
}

/**
 * R4 helper: when the surface is smaller than minW x minH draws "…" at (0,0) in pal.dim and
 * returns true; the caller then returns without drawing anything else.
 */
export function tooSmall(s: Surface, ctx: ChartCtx, minW: number, minH: number): boolean {
	if (s.w >= minW && s.h >= minH) return false;
	s.text(0, 0, ellipsis(ctx), ctx.pal.dim);
	return true;
}

/** Round up to 1, 2, 2.5, 5 × 10^n. */
export function niceMax(v: number): number {
	if (!(v > 0) || !Number.isFinite(v)) return 1;
	const e = 10 ** Math.floor(Math.log10(v));
	const f = v / e;
	const pick = [1, 2, 2.5, 5, 10].find((c) => f <= c + 1e-9) ?? 10;
	return pick * e;
}

function compact(v: number): string {
	const units: [number, string][] = [
		[1e9, "B"],
		[1e6, "M"],
		[1e3, "K"],
	];
	for (const [k, u] of units) {
		if (v >= k) {
			const x = v / k;
			return `${x >= 100 || Number.isInteger(x) ? Math.round(x) : x.toFixed(1)}${u}`;
		}
	}
	return Number.isInteger(v) ? String(v) : v.toFixed(v < 10 ? 1 : 0);
}

/** Compact axis label: 0, 950, 1.2K, 3M, $4.20 (when money=true). */
export function axisLabel(v: number, money = false): string {
	if (!Number.isFinite(v)) return "0";
	if (!money) return (v < 0 ? "-" : "") + compact(Math.abs(v));
	const a = Math.abs(v);
	const sign = v < 0 ? "-" : "";
	if (a >= 1000) return `${sign}$${compact(a)}`;
	return `${sign}$${a === 0 ? "0" : a < 100 ? a.toFixed(2) : a.toFixed(0)}`;
}

/**
 * Draw "█ label" pairs separated by two spaces starting at (x, y). Returns the x after the last
 * item. Items that do not fit are not drawn.
 */
export function legend(s: Surface, x: number, y: number, items: { label: string; color: RGB }[], ctx: ChartCtx): number {
	let cx = x;
	items.forEach((it, i) => {
		const w = 2 + strWidth(it.label);
		if (cx + w > s.w) return;
		s.text(cx, y, seriesGlyph(ctx, i, items.length), fgOf(it.color));
		s.text(cx + 2, y, it.label, ctx.pal.text);
		cx += w + 2;
	});
	return cx;
}
