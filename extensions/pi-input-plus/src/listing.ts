import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

export interface Entry {
	/** Name shown in a directory listing; the relative path in search results. */
	label: string;
	path: string;
	isDirectory: boolean;
}

export type Accept = (absolutePath: string) => boolean;

const SEARCH_LIMIT = 5000;
const WALK_SKIP = new Set([".git", "node_modules"]);

function byDirectoryThenName(a: Entry, b: Entry): number {
	if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
	return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" });
}

/** One directory level. Directories always show; `accept` only filters files. */
export async function listDirectory(dir: string, showHidden: boolean, accept?: Accept): Promise<Entry[]> {
	const dirents = await readdir(dir, { withFileTypes: true });
	const entries: Entry[] = [];
	for (const dirent of dirents) {
		if (!showHidden && dirent.name.startsWith(".")) continue;
		const path = join(dir, dirent.name);
		let isDirectory = dirent.isDirectory();
		if (dirent.isSymbolicLink()) {
			try {
				isDirectory = (await stat(path)).isDirectory();
			} catch {
				continue; // dangling link
			}
		}
		if (!isDirectory && accept && !accept(path)) continue;
		entries.push({ label: dirent.name, path, isDirectory });
	}
	return entries.sort(byDirectoryThenName);
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Query without the leading slash typed to start a search, split into lowercase terms. */
function queryTerms(query: string): string[] {
	return query.toLowerCase().split(/\s+/).map((t) => t.replace(/^\/+/, "")).filter(Boolean);
}

function runFd(dir: string, args: string[], signal: AbortSignal): Promise<string[] | undefined> {
	return new Promise((resolve) => {
		const child = spawn("fd", args, { cwd: dir, stdio: ["ignore", "pipe", "ignore"], signal });
		let out = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			out += chunk;
		});
		// undefined means fd could not be started (not installed) or the search was aborted.
		child.once("error", () => resolve(undefined));
		child.once("close", () => resolve(out.split("\n").filter(Boolean)));
	});
}

/**
 * Candidates for a search below `dir`: entries whose name (or path, when the query
 * contains a slash) contains the first term, case-insensitively. fd honours .gitignore.
 * A shallow and a deep run go in parallel so near matches are not crowded out by the
 * many deep ones when the result cap is hit (fd's output order is not by depth).
 */
export async function searchTree(dir: string, showHidden: boolean, accept: Accept | undefined, query: string, signal: AbortSignal): Promise<Entry[]> {
	const terms = queryTerms(query);
	if (terms.length === 0) return [];
	const first = terms[0]!;
	const base = ["--type", "f", "--type", "d", "--exclude", ".git", "--ignore-case", "--color", "never"];
	if (showHidden) base.push("--hidden");
	if (first.includes("/")) base.push("--full-path");
	const pattern = ["--", escapeRegex(first)];
	const runs = await Promise.all([
		runFd(dir, [...base, "--max-depth", "3", "--max-results", "1000", ...pattern], signal),
		runFd(dir, [...base, "--max-results", "4000", ...pattern], signal),
	]);
	if (signal.aborted) return [];
	if (runs.every((r) => r === undefined)) return walk(dir, showHidden, accept, signal);

	const seen = new Set<string>();
	const entries: Entry[] = [];
	for (const line of runs.flatMap((r) => r ?? [])) {
		if (seen.has(line)) continue;
		seen.add(line);
		const isDirectory = line.endsWith("/");
		const label = isDirectory ? line.slice(0, -1) : line;
		const path = join(dir, label);
		if (!isDirectory && accept && !accept(path)) continue;
		entries.push({ label: isDirectory ? `${label}/` : label, path, isDirectory });
	}
	return entries;
}

/**
 * Keeps entries containing every term (case-insensitive substring of the relative path)
 * and ranks them: exact name, name prefix, word start in the name, name contains, path
 * contains; ties go to shallower and shorter paths.
 */
export function matchEntries(entries: Entry[], query: string): Entry[] {
	const terms = queryTerms(query);
	if (terms.length === 0) return entries;
	const ranked: { entry: Entry; rank: number; depth: number }[] = [];
	for (const entry of entries) {
		const label = entry.label.replace(/\/$/, "").toLowerCase();
		const name = label.slice(label.lastIndexOf("/") + 1);
		if (!terms.every((t) => label.includes(t))) continue;
		let rank = 0;
		for (const term of terms) {
			const at = name.indexOf(term);
			rank += name === term ? 0 : at === 0 ? 1 : at > 0 && /[^a-z0-9]/.test(name[at - 1]!) ? 2 : at > 0 ? 3 : 4;
		}
		ranked.push({ entry, rank, depth: label.split("/").length });
	}
	return ranked.sort((a, b) => a.rank - b.rank || a.depth - b.depth || a.entry.label.length - b.entry.label.length || a.entry.label.localeCompare(b.entry.label)).map((r) => r.entry);
}

async function walk(root: string, showHidden: boolean, accept: Accept | undefined, signal: AbortSignal): Promise<Entry[]> {
	const found: Entry[] = [];
	const queue: { dir: string; rel: string; depth: number }[] = [{ dir: root, rel: "", depth: 0 }];
	while (queue.length > 0 && found.length < SEARCH_LIMIT && !signal.aborted) {
		const { dir, rel, depth } = queue.shift()!;
		let dirents;
		try {
			dirents = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const dirent of dirents) {
			if (WALK_SKIP.has(dirent.name) || (!showHidden && dirent.name.startsWith("."))) continue;
			const path = join(dir, dirent.name);
			const label = rel ? `${rel}/${dirent.name}` : dirent.name;
			if (dirent.isDirectory()) {
				found.push({ label: `${label}/`, path, isDirectory: true });
				if (depth < 6) queue.push({ dir: path, rel: label, depth: depth + 1 });
			} else if (!accept || accept(path)) {
				found.push({ label, path, isDirectory: false });
			}
		}
	}
	return found;
}

export function displayName(path: string): string {
	return basename(path) || path;
}
