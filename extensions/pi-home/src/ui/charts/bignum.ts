import type { Style, Surface } from "../../term/canvas.ts";
import { strWidth } from "../../term/width.ts";
import { type ChartCtx, tooSmall } from "./common.ts";

// 3x5 pixel font; "#" = lit. Characters narrower than 3 are listed with their own width.
const FONT: Record<string, string[]> = {
	"0": ["###", "#.#", "#.#", "#.#", "###"],
	"1": [".#.", "##.", ".#.", ".#.", "###"],
	"2": ["###", "..#", "###", "#..", "###"],
	"3": ["###", "..#", "###", "..#", "###"],
	"4": ["#.#", "#.#", "###", "..#", "..#"],
	"5": ["###", "#..", "###", "..#", "###"],
	"6": ["###", "#..", "###", "#.#", "###"],
	"7": ["###", "..#", ".#.", ".#.", ".#."],
	"8": ["###", "#.#", "###", "#.#", "###"],
	"9": ["###", "#.#", "###", "..#", "###"],
	".": [".", ".", ".", ".", "#"],
	",": [".", ".", ".", "#", "#"],
	$: [".##", "##.", ".#.", ".##", "##."],
	"%": ["#.#", "..#", ".#.", "#..", "#.#"],
	K: ["#.#", "#.#", "##.", "#.#", "#.#"],
	M: ["#.#", "###", "###", "#.#", "#.#"],
	B: ["##.", "#.#", "##.", "#.#", "##."],
	"-": ["...", "...", "###", "...", "..."],
	" ": [".", ".", ".", ".", "."],
};

const glyphOf = (c: string): string[] => FONT[c] ?? FONT[" "]!;

/** Width in columns of `text` rendered by bigNumber() with unicode on. */
export function bigNumberWidth(text: string): number {
	const chars = [...text.toUpperCase()];
	return chars.reduce((a, c) => a + glyphOf(c)[0]!.length, 0) + Math.max(0, chars.length - 1);
}

/**
 * Big number in a 3x5 pixel font rendered with half blocks `█▀▄` (3 rows tall) at (x, y).
 * Supports `0-9 . , $ % K M B -` and space; other characters render blank. Returns the width in
 * columns. Without unicode the text is drawn on one row in pal.strong (or `opts.style`).
 * Minimum: the glyphs fit (x + width <= surface width, y + 3 <= height), else "…" at (0,0).
 */
export function bigNumber(s: Surface, x: number, y: number, text: string, ctx: ChartCtx, opts: { style?: Style } = {}): number {
	const style = opts.style ?? ctx.pal.strong;
	if (!ctx.pal.caps.unicode) {
		s.text(x, y, text, style);
		return strWidth(text);
	}
	const chars = [...text.toUpperCase()];
	const width = bigNumberWidth(text);
	if (tooSmall(s, ctx, x + width, y + 3)) return width;
	let cx = x;
	for (const c of chars) {
		const g = glyphOf(c);
		const gw = g[0]!.length;
		for (let col = 0; col < gw; col++) {
			for (let r = 0; r < 3; r++) {
				const top = g[r * 2]?.[col] === "#";
				const bottom = g[r * 2 + 1]?.[col] === "#";
				if (top || bottom) s.text(cx + col, y + r, top && bottom ? "█" : top ? "▀" : "▄", style);
			}
		}
		cx += gw + 1;
	}
	return width;
}
