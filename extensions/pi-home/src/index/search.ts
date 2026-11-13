import { spawn } from "node:child_process";

export interface FullTextResult {
	query: string;
	/** Matching lines per session file. */
	counts: Map<string, number>;
	error?: string;
}

/**
 * Case-insensitive literal search over session files with ripgrep (SESSIONS.md §4).
 * Session text is not stored in the index, so this scans the jsonl files directly.
 */
export function fullTextSearch(query: string, roots: string[], signal?: AbortSignal): Promise<FullTextResult> {
	return new Promise((resolve) => {
		const counts = new Map<string, number>();
		const child = spawn("rg", ["--count", "--ignore-case", "--fixed-strings", "--glob", "*.jsonl", "--", query, ...roots], {
			stdio: ["ignore", "pipe", "pipe"],
			signal,
		});
		let out = "";
		let err = "";
		child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
		child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
		child.on("error", (e) => resolve({ query, counts, error: e.message }));
		child.on("close", (code) => {
			for (const line of out.split("\n")) {
				const i = line.lastIndexOf(":");
				if (i <= 0) continue;
				counts.set(line.slice(0, i), Number(line.slice(i + 1)) || 0);
			}
			// rg exits 1 when nothing matched; that is not an error.
			resolve({ query, counts, error: code !== null && code > 1 ? err.trim() || `rg exit ${code}` : undefined });
		});
	});
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Up to `max` short context snippets around matches in one file. */
export function snippets(query: string, file: string, max = 3): Promise<string[]> {
	return new Promise((resolve) => {
		const pattern = `.{0,40}${escapeRegex(query)}.{0,60}`;
		const child = spawn("rg", ["--only-matching", "--ignore-case", "--max-count", String(max), "--no-filename", "--no-line-number", "--", pattern, file], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		let out = "";
		child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
		child.on("error", () => resolve([]));
		child.on("close", () =>
			resolve(
				out
					.split("\n")
					.filter(Boolean)
					.slice(0, max)
					// Undo JSON escaping enough to read the text.
					.map((s) => s.replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\")),
			),
		);
	});
}
