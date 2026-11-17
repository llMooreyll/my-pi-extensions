// Unified diff parsing, styled rendering, and reconstruction of before/after files for `nvim -d`.

import { style, truncate } from "./term.ts";

export interface DiffLine {
	kind: "hunk" | "add" | "del" | "ctx" | "meta";
	text: string;
	oldNo?: number;
	newNo?: number;
}

export interface Hunk {
	oldStart: number;
	newStart: number;
	lines: DiffLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

export function parseDiff(diff: string): { lines: DiffLine[]; hunks: Hunk[] } {
	const lines: DiffLine[] = [];
	const hunks: Hunk[] = [];
	let oldNo = 0;
	let newNo = 0;
	let hunk: Hunk | undefined;
	for (const raw of diff.split("\n")) {
		// File headers only appear before the first hunk; inside hunks `--- x` is a removed line `-- x`.
		if (!hunk && (raw.startsWith("--- ") || raw.startsWith("+++ "))) continue;
		const m = HUNK_RE.exec(raw);
		if (m) {
			oldNo = Number(m[1]);
			newNo = Number(m[2]);
			hunk = { oldStart: oldNo, newStart: newNo, lines: [] };
			hunks.push(hunk);
			const line: DiffLine = { kind: "hunk", text: m[3].trim() };
			lines.push(line);
			continue;
		}
		let line: DiffLine;
		if (raw.startsWith("+")) line = { kind: "add", text: raw.slice(1), newNo: newNo++ };
		else if (raw.startsWith("-")) line = { kind: "del", text: raw.slice(1), oldNo: oldNo++ };
		else if (raw.startsWith(" ")) line = { kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ };
		else if (raw.startsWith("\\")) line = { kind: "meta", text: raw };
		else continue;
		lines.push(line);
		hunk?.lines.push(line);
	}
	return { lines, hunks };
}

/** Styled diff rows with an old/new line-number gutter; `indent` columns are left blank. */
export function renderDiff(diff: string, cols: number, indent: number, truncated?: boolean): string[] {
	const { lines } = parseDiff(diff);
	const maxNo = lines.reduce((m, l) => Math.max(m, l.oldNo ?? 0, l.newNo ?? 0), 0);
	const nw = Math.max(3, String(maxNo).length);
	const lead = " ".repeat(indent);
	const textCols = cols - indent - nw * 2 - 4;
	const out: string[] = [];
	for (const l of lines) {
		if (l.kind === "hunk") {
			out.push(lead + style.cyan(truncate(`${"┄".repeat(nw * 2 + 1)} ${l.text}`, cols - indent)));
			continue;
		}
		if (l.kind === "meta") {
			out.push(lead + style.gray(truncate(l.text, cols - indent)));
			continue;
		}
		const o = l.oldNo !== undefined ? String(l.oldNo).padStart(nw) : " ".repeat(nw);
		const n = l.newNo !== undefined ? String(l.newNo).padStart(nw) : " ".repeat(nw);
		const gutter = style.gray(`${o} ${n} `);
		const text = truncate(l.text.replaceAll("\t", "  "), textCols);
		if (l.kind === "add") out.push(`${lead}${gutter}${style.green(`+ ${text}`)}`);
		else if (l.kind === "del") out.push(`${lead}${gutter}${style.red(`- ${text}`)}`);
		else out.push(`${lead}${gutter}${style.dim(`  ${text}`)}`);
	}
	if (truncated) out.push(lead + style.yellow("… diff truncated at 200 KB; press o to view the full file"));
	return out;
}

/**
 * Rebuilds the file before the change from its current content by undoing each hunk.
 * Returns undefined when the current file no longer matches the diff's new side
 * (the file was changed again later), so the caller can fall back to the raw diff.
 */
export function reverseApply(current: string, diff: string): string | undefined {
	// End-of-file newline changes are not modelled line-wise; let the caller fall back.
	if (diff.includes("\n\\ No newline at end of file")) return undefined;
	const { hunks } = parseDiff(diff);
	const lines = current.split("\n");
	// Apply bottom-up so earlier offsets stay valid.
	for (const h of [...hunks].reverse()) {
		const newSide = h.lines.filter((l) => l.kind === "add" || l.kind === "ctx").map((l) => l.text);
		const oldSide = h.lines.filter((l) => l.kind === "del" || l.kind === "ctx").map((l) => l.text);
		const at = Math.max(0, h.newStart - (newSide.length === 0 ? 0 : 1));
		for (let i = 0; i < newSide.length; i++) {
			if (lines[at + i] !== newSide[i]) return undefined;
		}
		lines.splice(at, newSide.length, ...oldSide);
	}
	return lines.join("\n");
}
