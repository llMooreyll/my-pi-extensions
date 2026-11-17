// Light Markdown and inline highlighting for entry bodies, field values and change messages.
// Goal: make long Chinese text scannable — ids, code, emphasis, links and list structure
// stand out, plain prose stays in the default colour.

import { type Paint, style, truncate, wrap } from "./term.ts";

/** Built-in id prefixes, for text that is not tied to a parsed board (change messages). */
export const DEFAULT_PREFIXES = new Set(["T", "D", "C"]);

const PREFIX_PAINT: Record<string, Paint> = {
	T: style.cyan,
	D: style.magenta,
	C: style.red,
};

/** Colour of an entry id by prefix; custom sections are green. */
export function idColor(prefix: string): Paint {
	return PREFIX_PAINT[prefix] ?? style.green;
}

const ID_RE = /(?<![A-Za-z0-9_])([A-Z][A-Za-z]?)(\d+)(?![A-Za-z0-9_])/g;
const CODE_RE = /`([^`]+)`/g;
const BOLD_RE = /\*\*([^*]+)\*\*/g;
const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/**
 * Highlights one already-wrapped plain line: entry ids (T12, D26 …), `code`, **bold**,
 * and the texts of links that were flattened before wrapping.
 */
export function inline(line: string, prefixes: Set<string>, linkTexts: Set<string> = new Set()): string {
	// Code spans and link texts are swapped for placeholders first, so later passes (bold, ids)
	// never see their contents or the escape codes inserted for them.
	const held: string[] = [];
	const hold = (styled: string) => {
		held.push(styled);
		return `\u0000${held.length - 1}\u0000`;
	};
	let s = line.replace(CODE_RE, (_m, c: string) => hold(style.yellow(c)));
	const texts = [...linkTexts].filter(Boolean).sort((a, b) => b.length - a.length);
	if (texts.length) {
		const escaped = texts.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
		const re = new RegExp(`(?<![A-Za-z0-9_])(?:${escaped.join("|")})(?![A-Za-z0-9_])`, "g");
		s = s.replace(re, (m) => hold(style.underline(style.blue(m))));
	}
	s = s.replace(BOLD_RE, (_m, b: string) => style.bold(b));
	s = s.replace(ID_RE, (m, p: string) => (prefixes.has(p) ? style.bold(idColor(p)(m)) : m));
	return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => held[Number(i)]);
}

/** Replaces Markdown links with their text, collecting the texts for later underlining. */
export function flattenLinks(text: string, into: Set<string>): string {
	return text.replace(LINK_RE, (_m, t: string) => {
		into.add(t);
		return t;
	});
}

/** Wraps and highlights a single-paragraph value (field values, messages). */
export function richWrap(text: string, cols: number, prefixes: Set<string>): string[] {
	const links = new Set<string>();
	return wrap(flattenLinks(text, links), cols).map((l) => inline(l, prefixes, links));
}

/**
 * Renders an entry body: headings, bullet and numbered lists with hanging indent,
 * block quotes, fenced code, paragraphs. Returns styled lines of at most `cols` columns.
 */
export function renderMarkdown(text: string, cols: number, prefixes: Set<string>, accent: Paint): string[] {
	const out: string[] = [];
	const links = new Set<string>();
	const src = flattenLinks(text, links).split("\n");
	let inFence = false;
	let blank = false;
	const push = (l: string) => {
		out.push(l);
		blank = false;
	};
	for (const raw of src) {
		if (/^\s*```/.test(raw)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			push(style.gray("  ") + style.yellow(truncate(raw.replaceAll("\t", "  "), cols - 2)));
			continue;
		}
		if (raw.trim() === "") {
			if (!blank && out.length) out.push("");
			blank = true;
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
		if (heading) {
			if (out.length && !blank) out.push("");
			for (const l of wrap(heading[2], cols)) push(style.bold(accent(l)));
			continue;
		}
		const quote = /^\s*>\s?(.*)$/.exec(raw);
		if (quote) {
			for (const l of wrap(quote[1], cols - 2)) push(`${style.gray("▏")} ${style.italic(style.gray(l))}`);
			continue;
		}
		const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
		if (item) {
			const depth = Math.min(3, Math.floor(item[1].replaceAll("\t", "  ").length / 2));
			const marker = /\d/.test(item[2]) ? item[2] : ["•", "◦", "▪", "▫"][depth];
			const indent = "  ".repeat(depth);
			const head = `${indent}${marker} `;
			const hang = " ".repeat(head.length);
			wrap(item[3], cols - head.length).forEach((l, i) => {
				push(`${i === 0 ? indent + accent(marker) + " " : hang}${inline(l, prefixes, links)}`);
			});
			continue;
		}
		for (const l of wrap(raw.trim(), cols)) push(inline(l, prefixes, links));
	}
	while (out.length && out[out.length - 1] === "") out.pop();
	return out;
}
