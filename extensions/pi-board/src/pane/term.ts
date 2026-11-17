// Terminal primitives for the board pane: display width, styling, truncation, wrapping.
// Colors use the 16 base ANSI colors so the pane follows the user's terminal theme;
// only the selection background uses a fixed 256-color grey.

const ESC = "\x1b[";

export const style = {
	reset: `${ESC}0m`,
	bold: (s: string) => `${ESC}1m${s}${ESC}22m`,
	dim: (s: string) => `${ESC}2m${s}${ESC}22m`,
	italic: (s: string) => `${ESC}3m${s}${ESC}23m`,
	underline: (s: string) => `${ESC}4m${s}${ESC}24m`,
	inverse: (s: string) => `${ESC}7m${s}${ESC}27m`,
	red: (s: string) => `${ESC}31m${s}${ESC}39m`,
	green: (s: string) => `${ESC}32m${s}${ESC}39m`,
	yellow: (s: string) => `${ESC}33m${s}${ESC}39m`,
	blue: (s: string) => `${ESC}34m${s}${ESC}39m`,
	magenta: (s: string) => `${ESC}35m${s}${ESC}39m`,
	cyan: (s: string) => `${ESC}36m${s}${ESC}39m`,
	gray: (s: string) => `${ESC}90m${s}${ESC}39m`,
	brightRed: (s: string) => `${ESC}91m${s}${ESC}39m`,
	brightYellow: (s: string) => `${ESC}93m${s}${ESC}39m`,
	brightCyan: (s: string) => `${ESC}96m${s}${ESC}39m`,
};

export type Paint = (s: string) => string;

/** Background used for the cursor row; re-applied after every reset inside the row. */
export const SELECT_BG = `${ESC}48;5;236m`;
/** Background for the pane's top bar. */
export const BAR_BG = `${ESC}48;5;235m`;

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

function isZeroWidth(cp: number): boolean {
	return (
		(cp >= 0x0300 && cp <= 0x036f) ||
		(cp >= 0x200b && cp <= 0x200f) ||
		(cp >= 0xfe00 && cp <= 0xfe0f) ||
		(cp >= 0x20d0 && cp <= 0x20ff) ||
		cp === 0x200d
	);
}

function isWide(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0x303e) ||
		(cp >= 0x3041 && cp <= 0x33ff) ||
		(cp >= 0x3400 && cp <= 0x4dbf) ||
		(cp >= 0x4e00 && cp <= 0x9fff) ||
		(cp >= 0xa000 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) ||
		(cp >= 0x1f680 && cp <= 0x1f6ff) ||
		(cp >= 0x1f900 && cp <= 0x1f9ff) ||
		(cp >= 0x1fa70 && cp <= 0x1faff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	);
}

export function charWidth(ch: string): number {
	const cp = ch.codePointAt(0) ?? 0;
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
	if (isZeroWidth(cp)) return 0;
	return isWide(cp) ? 2 : 1;
}

/** Visible terminal columns of a string that may contain ANSI escapes. */
export function width(s: string): number {
	let w = 0;
	for (const ch of stripAnsi(s)) w += charWidth(ch);
	return w;
}

/** Splits a styled string into tokens: escapes (width 0) and single characters. */
function tokens(s: string): Array<{ text: string; w: number }> {
	const out: Array<{ text: string; w: number }> = [];
	let last = 0;
	for (const m of s.matchAll(ANSI_RE)) {
		for (const ch of s.slice(last, m.index)) out.push({ text: ch, w: charWidth(ch) });
		out.push({ text: m[0], w: 0 });
		last = (m.index ?? 0) + m[0].length;
	}
	for (const ch of s.slice(last)) out.push({ text: ch, w: charWidth(ch) });
	return out;
}

/** Cuts a styled string to at most `max` columns, appending `…` when something was cut. */
export function truncate(s: string, max: number): string {
	if (max <= 0) return "";
	if (width(s) <= max) return s;
	let out = "";
	let w = 0;
	for (const t of tokens(s)) {
		if (t.w === 0) {
			out += t.text;
			continue;
		}
		if (w + t.w > max - 1) break;
		out += t.text;
		w += t.w;
	}
	return `${out}${style.reset}…`;
}

/** Pads a styled string with spaces to exactly `cols` columns (truncating when longer). */
export function pad(s: string, cols: number): string {
	const t = truncate(s, cols);
	return t + " ".repeat(Math.max(0, cols - width(t)));
}

/** Left part, right part, filled with spaces in between; the left part is cut first. */
export function spread(left: string, right: string, cols: number): string {
	const rw = width(right);
	if (rw >= cols) return truncate(right, cols);
	const l = truncate(left, cols - rw - 1);
	return l + " ".repeat(Math.max(1, cols - width(l) - rw)) + right;
}

/** Wraps plain text (no ANSI) to `cols` columns; keeps existing line breaks. CJK text breaks anywhere. */
export function wrap(text: string, cols: number): string[] {
	if (cols <= 0) return [];
	const lines: string[] = [];
	for (const raw of text.split("\n")) {
		if (raw === "") {
			lines.push("");
			continue;
		}
		let line = "";
		let w = 0;
		let lastSpace = -1;
		for (const ch of raw) {
			const cw = charWidth(ch);
			if (w + cw > cols) {
				if (lastSpace > 0 && ch !== " ") {
					const head = line.slice(0, lastSpace);
					const tail = line.slice(lastSpace + 1);
					lines.push(head);
					line = tail;
					w = width(tail);
				} else {
					lines.push(line);
					line = "";
					w = 0;
				}
				lastSpace = -1;
				if (ch === " ") continue;
			}
			if (ch === " ") lastSpace = line.length;
			line += ch;
			w += cw;
		}
		lines.push(line);
	}
	return lines;
}

/** Applies a background to a whole row, surviving inner resets. */
export function withBackground(row: string, bg: string): string {
	return bg + row.split(style.reset).join(style.reset + bg).replaceAll(`${ESC}49m`, bg) + style.reset;
}

export const screen = {
	enter: "\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h",
	leave: "\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l",
	home: "\x1b[H",
	clearLine: "\x1b[2K",
	moveTo: (row: number) => `\x1b[${row + 1};1H`,
	title: (t: string) => `\x1b]2;${t}\x07`,
};
