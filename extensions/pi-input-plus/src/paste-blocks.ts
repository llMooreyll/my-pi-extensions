/**
 * Finds what the prompt editor shows as one unit but that holds more than it displays:
 * the `[paste #n …]` placeholders that replace large pastes, and image files pasted
 * from the clipboard (inserted as plain paths). Everything here works on the public
 * `getText()` / `getExpandedText()` strings, never on the editor's internals.
 */

export type Block =
	| { kind: "text"; start: number; end: number; text: string; label: string }
	| { kind: "image"; start: number; end: number; path: string };

const PASTE_MARKER = /\[paste #(\d+)(?: (?:\+(\d+) lines|(\d+) chars))?\]/g;
const IMAGE_PATH = /(?<![^\s[(])\/[^\s[\]"']+\.(?:png|jpe?g|webp|gif)(?![\w/])/gi;

/** Offset of the cursor in the editor's `lines.join("\n")` text. */
export function cursorOffset(lines: string[], cursor: { line: number; col: number }): number {
	let offset = 0;
	for (let i = 0; i < cursor.line; i++) offset += (lines[i]?.length ?? 0) + 1;
	return offset + cursor.col;
}

/**
 * `text` is the editor text with placeholders, `expanded` the same text with every
 * placeholder replaced by the pasted content. Aligning the two recovers each paste:
 * the text between placeholders is identical in both, and a placeholder states its
 * size (`N chars` or `+N lines`).
 */
export function findBlocks(text: string, expanded: string): Block[] {
	const blocks: Block[] = [];

	if (expanded !== text) {
		const markers = [...text.matchAll(PASTE_MARKER)];
		let textPos = 0;
		let expandedPos = 0;
		for (let i = 0; i < markers.length; i++) {
			const marker = markers[i]!;
			const start = marker.index ?? 0;
			const literal = text.slice(textPos, start);
			if (!expanded.startsWith(literal, expandedPos)) break;
			expandedPos += literal.length;
			textPos = start + marker[0].length;

			// A placeholder whose id is unknown to the editor stays literal in `expanded`.
			if (expanded.startsWith(marker[0], expandedPos)) {
				expandedPos += marker[0].length;
				continue;
			}

			const nextStart = markers[i + 1]?.index ?? text.length;
			const following = text.slice(textPos, nextStart);
			const end = contentEnd(expanded, expandedPos, marker, following, i === markers.length - 1);
			if (end === undefined) break;
			blocks.push({ kind: "text", start, end: textPos, text: expanded.slice(expandedPos, end), label: marker[0].slice(1, -1) });
			expandedPos = end;
		}
	}

	for (const match of text.matchAll(IMAGE_PATH)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (blocks.some((b) => b.kind === "text" && start < b.end && end > b.start)) continue;
		blocks.push({ kind: "image", start, end, path: match[0] });
	}
	return blocks.sort((a, b) => a.start - b.start);
}

function contentEnd(expanded: string, from: number, marker: RegExpMatchArray, following: string, isLast: boolean): number | undefined {
	const lines = marker[2];
	const chars = marker[3];
	if (chars !== undefined) {
		const end = from + Number(chars);
		return end <= expanded.length ? end : undefined;
	}
	if (lines === undefined) return undefined;

	// Move to the start of the pasted text's last line, then to where it ends.
	let pos = from;
	for (let n = Number(lines) - 1; n > 0; n--) {
		const newline = expanded.indexOf("\n", pos);
		if (newline < 0) return undefined;
		pos = newline + 1;
	}
	if (following) {
		const end = expanded.indexOf(following, pos);
		return end < 0 ? undefined : end;
	}
	if (isLast) return expanded.length;
	const newline = expanded.indexOf("\n", pos);
	return newline < 0 ? expanded.length : newline;
}
