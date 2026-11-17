// Small line-based unified diff (Myers) so the change log needs no diff dependency.

export interface DiffResult {
	/** Unified diff with `--- a/<path>` / `+++ b/<path>` headers; empty when nothing changed. */
	diff: string;
	added: number;
	removed: number;
}

type Op = { t: " " | "-" | "+"; line: string };

/** Beyond this edit distance the middle part is reported as a full replacement. */
const MAX_EDIT_DISTANCE = 1500;

function toLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Edit script between two line arrays; undefined when the edit distance exceeds the limit. */
function myers(a: string[], b: string[]): Op[] | undefined {
	const n = a.length;
	const m = b.length;
	if (n === 0) return b.map((line): Op => ({ t: "+", line }));
	if (m === 0) return a.map((line): Op => ({ t: "-", line }));

	const maxD = Math.min(n + m, MAX_EDIT_DISTANCE);
	const offset = maxD + 1;
	const v = new Int32Array(2 * maxD + 3);
	const trace: Int32Array[] = [];
	let found = -1;

	for (let d = 0; d <= maxD && found < 0; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
			else x = v[offset + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				found = d;
				break;
			}
		}
	}
	if (found < 0) return undefined;

	const ops: Op[] = [];
	let x = n;
	let y = m;
	for (let d = found; d > 0; d--) {
		const prev = trace[d];
		const k = x - y;
		const prevK = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]) ? k + 1 : k - 1;
		const prevX = prev[offset + prevK];
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			ops.push({ t: " ", line: a[x - 1] });
			x--;
			y--;
		}
		if (x === prevX) ops.push({ t: "+", line: b[y - 1] });
		else ops.push({ t: "-", line: a[x - 1] });
		x = prevX;
		y = prevY;
	}
	while (x > 0 && y > 0) {
		ops.push({ t: " ", line: a[x - 1] });
		x--;
		y--;
	}
	return ops.reverse();
}

function editScript(a: string[], b: string[]): Op[] {
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

	const midA = a.slice(head, a.length - tail);
	const midB = b.slice(head, b.length - tail);
	const mid = myers(midA, midB) ?? [
		...midA.map((line): Op => ({ t: "-", line })),
		...midB.map((line): Op => ({ t: "+", line })),
	];
	return [
		...a.slice(0, head).map((line): Op => ({ t: " ", line })),
		...mid,
		...a.slice(a.length - tail).map((line): Op => ({ t: " ", line })),
	];
}

/** `before` undefined means the file did not exist (every line counts as added). */
export function unifiedDiff(path: string, before: string | undefined, after: string, context = 3): DiffResult {
	const ops = editScript(toLines(before ?? ""), toLines(after));

	let added = 0;
	let removed = 0;
	const changes: number[] = [];
	// oldBefore[i] / newBefore[i]: lines of each side that precede op i.
	const oldBefore: number[] = new Array(ops.length + 1);
	const newBefore: number[] = new Array(ops.length + 1);
	let o = 0;
	let nw = 0;
	for (let i = 0; i < ops.length; i++) {
		oldBefore[i] = o;
		newBefore[i] = nw;
		if (ops[i].t === "+") {
			added++;
			nw++;
			changes.push(i);
		} else if (ops[i].t === "-") {
			removed++;
			o++;
			changes.push(i);
		} else {
			o++;
			nw++;
		}
	}
	oldBefore[ops.length] = o;
	newBefore[ops.length] = nw;
	if (changes.length === 0) return { diff: "", added: 0, removed: 0 };

	const ranges: Array<[number, number]> = [];
	let start = changes[0];
	let end = changes[0];
	for (const c of changes.slice(1)) {
		if (c - end - 1 <= 2 * context) {
			end = c;
		} else {
			ranges.push([start, end]);
			start = c;
			end = c;
		}
	}
	ranges.push([start, end]);

	const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
	for (const [s, e] of ranges) {
		const from = Math.max(0, s - context);
		const to = Math.min(ops.length, e + context + 1);
		const oldCount = oldBefore[to] - oldBefore[from];
		const newCount = newBefore[to] - newBefore[from];
		const oldStart = oldCount === 0 ? oldBefore[from] : oldBefore[from] + 1;
		const newStart = newCount === 0 ? newBefore[from] : newBefore[from] + 1;
		out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
		for (let i = from; i < to; i++) out.push(`${ops[i].t}${ops[i].line}`);
	}
	return { diff: `${out.join("\n")}\n`, added, removed };
}

/**
 * Re-labels a patch produced by pi's edit tool (`details.patch`) with the a/ b/ headers of the change log
 * and counts its added and removed lines.
 */
export function normalizePatch(patch: string, path: string): DiffResult {
	const lines = patch.split("\n");
	const first = lines.findIndex((l) => l.startsWith("--- "));
	if (first < 0 || !(lines[first + 1] ?? "").startsWith("+++ ")) return { diff: "", added: 0, removed: 0 };
	const body = lines.slice(first + 2);
	let added = 0;
	let removed = 0;
	for (const l of body) {
		if (l.startsWith("+")) added++;
		else if (l.startsWith("-")) removed++;
	}
	const diff = [`--- a/${path}`, `+++ b/${path}`, ...body].join("\n");
	return { diff: diff.endsWith("\n") ? diff : `${diff}\n`, added, removed };
}

export const MAX_DIFF_BYTES = 200 * 1024;

/** Cuts a diff to the 200 KB limit at a line boundary. */
export function truncateDiff(diff: string): { diff: string; truncated: boolean } {
	if (Buffer.byteLength(diff, "utf8") <= MAX_DIFF_BYTES) return { diff, truncated: false };
	const lines = diff.split("\n");
	const kept: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		const size = Buffer.byteLength(line, "utf8") + 1;
		if (bytes + size > MAX_DIFF_BYTES) break;
		kept.push(line);
		bytes += size;
	}
	return { diff: `${kept.join("\n")}\n`, truncated: true };
}
