import { visibleWidth } from "@earendil-works/pi-tui";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const widthCache = new Map<string, number>();
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** Cell width of one grapheme: 0, 1 or 2. Control characters count as 0. */
export function graphemeWidth(g: string): number {
	if (g.length === 1) {
		const code = g.charCodeAt(0);
		if (code >= 0x20 && code < 0x7f) return 1;
		if (code < 0x20 || code === 0x7f) return 0;
	}
	let w = widthCache.get(g);
	if (w === undefined) {
		w = Math.min(2, visibleWidth(g));
		widthCache.set(g, w);
	}
	return w;
}

export function graphemes(s: string): string[] {
	if (PRINTABLE_ASCII.test(s)) return s.split("");
	const out: string[] = [];
	for (const { segment } of segmenter.segment(s)) out.push(segment);
	return out;
}

export function strWidth(s: string): number {
	if (PRINTABLE_ASCII.test(s)) return s.length;
	let w = 0;
	for (const g of graphemes(s)) w += graphemeWidth(g);
	return w;
}

/** Cut s to at most `width` cells, appending `ellipsis` when something was dropped. */
export function truncate(s: string, width: number, ellipsis = "…"): string {
	if (width <= 0) return "";
	if (strWidth(s) <= width) return s;
	const ew = strWidth(ellipsis);
	if (ew >= width) return ellipsis.slice(0, width);
	let out = "";
	let w = 0;
	for (const g of graphemes(s)) {
		const gw = graphemeWidth(g);
		if (w + gw > width - ew) break;
		out += g;
		w += gw;
	}
	return out + ellipsis;
}

/**
 * Wrap s into at most `maxLines` lines of `width` cells. Latin words break at the last space when
 * one is near the line end; CJK text breaks anywhere. Overflow ends the last line with an ellipsis.
 */
export function wrapLines(s: string, width: number, maxLines: number): string[] {
	if (width <= 0 || maxLines <= 0) return [];
	const lines: string[] = [];
	let rest = graphemes(s.replace(/\s+/g, " ").trim());
	while (rest.length && lines.length < maxLines) {
		let w = 0;
		let end = 0;
		while (end < rest.length && w + graphemeWidth(rest[end]!) <= width) w += graphemeWidth(rest[end++]!);
		if (end < rest.length) {
			const space = rest.lastIndexOf(" ", end);
			if (space > end * 0.6) end = space;
		}
		if (lines.length === maxLines - 1 && end < rest.length) {
			lines.push(truncate(rest.join(""), width));
			return lines;
		}
		lines.push(rest.slice(0, end).join("").trimEnd());
		rest = rest.slice(end);
		while (rest[0] === " ") rest.shift();
	}
	return lines;
}

export function padEnd(s: string, width: number): string {
	const t = truncate(s, width);
	return t + " ".repeat(Math.max(0, width - strWidth(t)));
}

export function padStart(s: string, width: number): string {
	const t = truncate(s, width);
	return " ".repeat(Math.max(0, width - strWidth(t))) + t;
}

/** Collapse whitespace and control characters into single spaces (for one-line previews). */
export function oneLine(s: string): string {
	return s.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
}
