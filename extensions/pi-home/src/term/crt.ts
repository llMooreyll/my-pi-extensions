import type { Canvas } from "./canvas.ts";
import { DEFAULT, scale } from "./color.ts";

/**
 * Character-level CRT post-processing (VISUAL.md §4). Each pass mutates the frame in place after
 * all pages have drawn and before the Renderer serialises it. DEFAULT colours are left untouched.
 */

/** Darken towards the edges: factor 1 - strength·d², d = normalised distance from centre (0..1). */
export function vignette(c: Canvas, strength: number): void {
	const cx = (c.w - 1) / 2;
	const cy = (c.h - 1) / 2;
	for (let y = 0; y < c.h; y++) {
		// Cells are roughly twice as tall as wide, so weight rows double.
		const dy = (y - cy) / Math.max(1, cy);
		for (let x = 0; x < c.w; x++) {
			const dx = (x - cx) / Math.max(1, cx);
			const d2 = Math.min(1, (dx * dx + dy * dy) / 2);
			const k = 1 - strength * d2;
			if (k >= 0.999) continue;
			const i = y * c.w + x;
			const f = c.fg[i]!;
			const b = c.bg[i]!;
			if (f !== DEFAULT) c.fg[i] = scale(f, k);
			if (b !== DEFAULT) c.bg[i] = scale(b, k);
		}
	}
}

/** Darken the background of every other row. */
export function scanlines(c: Canvas, k: number): void {
	for (let y = 1; y < c.h; y += 2) {
		for (let x = 0; x < c.w; x++) {
			const i = y * c.w + x;
			const b = c.bg[i]!;
			if (b !== DEFAULT) c.bg[i] = scale(b, k);
		}
	}
}

/** Multiply every colour by k (flicker and fades). */
export function brightness(c: Canvas, k: number): void {
	if (k === 1) return;
	for (let i = 0; i < c.w * c.h; i++) {
		const f = c.fg[i]!;
		const b = c.bg[i]!;
		if (f !== DEFAULT) c.fg[i] = scale(f, k);
		if (b !== DEFAULT) c.bg[i] = scale(b, k);
	}
}

const easeOut = (t: number): number => 1 - (1 - t) ** 3;

/**
 * Mask the frame for a CRT power-on/off transition. `open` goes 0 (dark) → 1 (full picture).
 * 0..0.35: a bright horizontal line grows from the centre; 0.35..1: the line opens vertically.
 * Cells outside the visible window become `dark`; the line itself uses `glow`.
 */
export function powerMask(c: Canvas, open: number, dark: number, glow: number): void {
	if (open >= 1) return;
	const cy = (c.h - 1) / 2;
	const cx = (c.w - 1) / 2;
	const lineT = Math.min(1, open / 0.35);
	const halfW = easeOut(lineT) * (c.w / 2);
	const vertT = open <= 0.35 ? 0 : easeOut((open - 0.35) / 0.65);
	const halfH = vertT * (c.h / 2);
	for (let y = 0; y < c.h; y++) {
		for (let x = 0; x < c.w; x++) {
			const i = y * c.w + x;
			const inX = Math.abs(x - cx) <= halfW;
			const inY = Math.abs(y - cy) <= Math.max(0.5, halfH);
			if (inX && inY) {
				if (halfH < 1.5) {
					c.ch[i] = "━";
					c.fg[i] = glow;
					c.bg[i] = dark;
					c.at[i] = 0;
				}
				continue;
			}
			c.ch[i] = " ";
			c.fg[i] = dark;
			c.bg[i] = dark;
			c.at[i] = 0;
		}
	}
}

/**
 * Power-off: picture squeezes vertically into a line (close 0..0.6), then the line shrinks to a dot
 * (0.6..1). `close` goes 0 → 1.
 */
export function powerOffMask(c: Canvas, close: number, dark: number, glow: number): void {
	if (close <= 0) return;
	if (close < 0.6) {
		// Reuse the vertical opening phase in reverse.
		const open = 0.35 + 0.65 * (1 - close / 0.6);
		powerMask(c, open, dark, glow);
		return;
	}
	const t = (close - 0.6) / 0.4;
	const cy = Math.floor((c.h - 1) / 2);
	const cx = (c.w - 1) / 2;
	const halfW = (1 - easeOut(t)) * (c.w / 2);
	for (let i = 0; i < c.w * c.h; i++) {
		c.ch[i] = " ";
		c.fg[i] = dark;
		c.bg[i] = dark;
		c.at[i] = 0;
	}
	for (let x = 0; x < c.w; x++) {
		if (Math.abs(x - cx) > Math.max(0.5, halfW)) continue;
		const i = cy * c.w + x;
		c.ch[i] = halfW < 1 ? "█" : "━";
		c.fg[i] = glow;
	}
}
