import type { Style, Surface } from "../term/canvas.ts";

/** 5×5 pixel font (VISUAL.md §5). Each row is a 5-bit pattern, "#" = lit. */
const FONT: Record<string, string[]> = {
	A: [" ### ", "#   #", "#####", "#   #", "#   #"],
	B: ["#### ", "#   #", "#### ", "#   #", "#### "],
	C: [" ####", "#    ", "#    ", "#    ", " ####"],
	D: ["#### ", "#   #", "#   #", "#   #", "#### "],
	E: ["#####", "#    ", "#### ", "#    ", "#####"],
	F: ["#####", "#    ", "#### ", "#    ", "#    "],
	G: [" ####", "#    ", "#  ##", "#   #", " ####"],
	H: ["#   #", "#   #", "#####", "#   #", "#   #"],
	I: ["#####", "  #  ", "  #  ", "  #  ", "#####"],
	J: ["  ###", "    #", "    #", "#   #", " ### "],
	K: ["#   #", "#  # ", "###  ", "#  # ", "#   #"],
	L: ["#    ", "#    ", "#    ", "#    ", "#####"],
	M: ["#   #", "## ##", "# # #", "#   #", "#   #"],
	N: ["#   #", "##  #", "# # #", "#  ##", "#   #"],
	O: [" ### ", "#   #", "#   #", "#   #", " ### "],
	P: ["#### ", "#   #", "#### ", "#    ", "#    "],
	Q: [" ### ", "#   #", "# # #", "#  # ", " ## #"],
	R: ["#### ", "#   #", "#### ", "#  # ", "#   #"],
	S: [" ####", "#    ", " ### ", "    #", "#### "],
	T: ["#####", "  #  ", "  #  ", "  #  ", "  #  "],
	U: ["#   #", "#   #", "#   #", "#   #", " ### "],
	V: ["#   #", "#   #", "#   #", " # # ", "  #  "],
	W: ["#   #", "#   #", "# # #", "## ##", "#   #"],
	X: ["#   #", " # # ", "  #  ", " # # ", "#   #"],
	Y: ["#   #", " # # ", "  #  ", "  #  ", "  #  "],
	Z: ["#####", "   # ", "  #  ", " #   ", "#####"],
	"0": [" ### ", "#  ##", "# # #", "##  #", " ### "],
	"1": ["  #  ", " ##  ", "  #  ", "  #  ", " ### "],
	"2": ["#### ", "    #", " ### ", "#    ", "#####"],
	"3": ["#### ", "    #", " ### ", "    #", "#### "],
	"4": ["#   #", "#   #", "#####", "    #", "    #"],
	"5": ["#####", "#    ", "#### ", "    #", "#### "],
	"6": [" ### ", "#    ", "#### ", "#   #", " ### "],
	"7": ["#####", "    #", "   # ", "  #  ", "  #  "],
	"8": [" ### ", "#   #", " ### ", "#   #", " ### "],
	"9": [" ### ", "#   #", " ####", "    #", " ### "],
	".": ["     ", "     ", "     ", "     ", "  #  "],
	"-": ["     ", "     ", " ### ", "     ", "     "],
	_: ["     ", "     ", "     ", "     ", "#####"],
	"/": ["    #", "   # ", "  #  ", " #   ", "#    "],
	">": [" #   ", "  #  ", "   # ", "  #  ", " #   "],
	"$": [" ####", "# #  ", " ### ", "  # #", "#### "],
	"%": ["#   #", "   # ", "  #  ", " #   ", "#   #"],
	":": ["     ", "  #  ", "     ", "  #  ", "     "],
	",": ["     ", "     ", "     ", "  #  ", " #   "],
	" ": ["     ", "     ", "     ", "     ", "     "],
};

export const BIG_HEIGHT = 5;
/** Narrow glyphs (punctuation) use 3 pixel columns. */
const NARROW = new Set([".", ":", ",", " "]);

/** Cells per glyph including spacing; `px` = cells per pixel (2 = default, 1 = compact). */
function glyphWidth(ch: string, px: number): number {
	return (NARROW.has(ch) ? 3 : 5) * px + px;
}

export function bigTextWidth(text: string, px = 2): number {
	let w = 0;
	for (const ch of text.toUpperCase()) w += glyphWidth(ch, px);
	return Math.max(0, w - px);
}

/** Largest pixel width (2 or 1) at which `text` fits in `width` cells, or 0 if it does not fit. */
export function bigTextScale(text: string, width: number): number {
	if (bigTextWidth(text, 2) <= width) return 2;
	if (bigTextWidth(text, 1) <= width) return 1;
	return 0;
}

/**
 * Draw pixel text with an offset drop shadow (1 right, 1 down). Height is BIG_HEIGHT + 1.
 * `reveal` (0..1) draws only the first fraction of columns, for typing-in animations.
 */
export function drawBigText(
	s: Surface,
	x: number,
	y: number,
	text: string,
	face: Style,
	shadow: Style,
	reveal = 1,
	px = 2,
): void {
	const chars = [...text.toUpperCase()];
	const limit = Math.floor(bigTextWidth(text, px) * reveal);
	const lit = "█".repeat(px);
	const shade = "▒".repeat(px);
	for (const pass of [0, 1] as const) {
		let cx = x;
		for (const ch of chars) {
			const g = FONT[ch] ?? FONT[" "]!;
			const offset = NARROW.has(ch) ? -px : 0;
			for (let row = 0; row < 5; row++) {
				for (let col = 0; col < 5; col++) {
					if (g[row]![col] !== "#") continue;
					const cellX = cx + offset + col * px;
					if (cellX - x >= limit) continue;
					if (pass === 0) s.text(cellX + 1, y + row + 1, shade, shadow);
					else s.text(cellX, y + row, lit, face);
				}
			}
			cx += glyphWidth(ch, px);
		}
	}
}
