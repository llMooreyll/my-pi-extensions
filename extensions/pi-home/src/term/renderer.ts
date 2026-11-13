import type { Canvas } from "./canvas.ts";
import { BOLD, DIM, ITALIC, REVERSE, UNDERLINE } from "./canvas.ts";
import { blue, DEFAULT, green, nearest256, red, type RGB } from "./color.ts";

export type ColorMode = "truecolor" | "256" | "none";

function fgCode(c: RGB, mode: ColorMode): string {
	if (c === DEFAULT || mode === "none") return "39";
	if (mode === "256") return `38;5;${nearest256(c)}`;
	return `38;2;${red(c)};${green(c)};${blue(c)}`;
}

function bgCode(c: RGB, mode: ColorMode): string {
	if (c === DEFAULT || mode === "none") return "49";
	if (mode === "256") return `48;5;${nearest256(c)}`;
	return `48;2;${red(c)};${green(c)};${blue(c)}`;
}

function attrCode(a: number): string {
	let s = "22;23;24;27";
	if (a & BOLD) s += ";1";
	if (a & DIM) s += ";2";
	if (a & ITALIC) s += ";3";
	if (a & UNDERLINE) s += ";4";
	if (a & REVERSE) s += ";7";
	return s;
}

/**
 * Turns a Canvas into ANSI output. Each row is serialised to a string and only rows that differ
 * from the previous frame are written, inside a synchronized-output block to avoid tearing.
 */
export class Renderer {
	private prev: string[] = [];
	private readonly write: (s: string) => void;

	constructor(write: (s: string) => void) {
		this.write = write;
	}

	invalidate(): void {
		this.prev = [];
	}

	render(c: Canvas, mode: ColorMode): void {
		let out = "";
		for (let y = 0; y < c.h; y++) {
			const row = this.row(c, y, mode);
			if (this.prev[y] === row) continue;
			this.prev[y] = row;
			out += `\x1b[${y + 1};1H${row}`;
		}
		this.prev.length = c.h;
		if (out) this.write(`\x1b[?2026h${out}\x1b[0m\x1b[?2026l`);
	}

	private row(c: Canvas, y: number, mode: ColorMode): string {
		let s = "\x1b[0m";
		let curFg = -2;
		let curBg = -2;
		let curAt = -1;
		const base = y * c.w;
		for (let x = 0; x < c.w; x++) {
			const i = base + x;
			const ch = c.ch[i]!;
			if (ch === "") continue;
			const fg = c.fg[i]!;
			const bg = c.bg[i]!;
			const at = c.at[i]!;
			const codes: string[] = [];
			if (at !== curAt) {
				codes.push(attrCode(at));
				curAt = at;
			}
			if (fg !== curFg) {
				codes.push(fgCode(fg, mode));
				curFg = fg;
			}
			if (bg !== curBg) {
				codes.push(bgCode(bg, mode));
				curBg = bg;
			}
			if (codes.length) s += `\x1b[${codes.join(";")}m`;
			s += ch;
		}
		return s;
	}
}
