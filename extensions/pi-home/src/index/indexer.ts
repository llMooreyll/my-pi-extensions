import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { saveJsonAtomic } from "../config.ts";
import { agentDir, defaultSessionsDir, indexPath, settingsPath } from "../paths.ts";
import { type ParseOptions, parseSessionFile } from "./parse.ts";
import { INDEX_VERSION, type IndexFile, type SessionRecord } from "./types.ts";

export interface IndexProgress {
	done: number;
	total: number;
	/** True once the scan finished and the cache was written. */
	finished: boolean;
	/** Files re-parsed in this run. */
	parsed: number;
	error?: string;
}

/** Session directories pi writes to: settings.sessionDir (if set) plus the default location. */
export function sessionRoots(): string[] {
	const roots = new Set<string>([defaultSessionsDir()]);
	try {
		const s = JSON.parse(readFileSync(settingsPath(), "utf8")) as { sessionDir?: unknown };
		if (typeof s.sessionDir === "string" && s.sessionDir) {
			roots.add(s.sessionDir.startsWith("/") ? s.sessionDir : join(agentDir(), s.sessionDir));
		}
	} catch {
		/* no settings */
	}
	return [...roots].filter((r) => existsSync(r));
}

/** All *.jsonl files one directory level below each root (pi's --<cwd>--/ layout). */
export function listSessionFiles(): string[] {
	const out: string[] = [];
	for (const root of sessionRoots()) {
		for (const dir of readdirSync(root, { withFileTypes: true })) {
			if (!dir.isDirectory()) continue;
			const p = join(root, dir.name);
			for (const f of readdirSync(p)) if (f.endsWith(".jsonl")) out.push(join(p, f));
		}
	}
	return out;
}

/**
 * In-memory session index with an on-disk cache. `refresh()` stats every file and re-parses only
 * those whose size or mtime changed; deleted files are dropped.
 */
export class SessionIndex {
	records = new Map<string, SessionRecord>();
	progress: IndexProgress = { done: 0, total: 0, finished: false, parsed: 0 };
	/** Bumped whenever records change; pages use it to invalidate cached aggregates. */
	revision = 0;
	private readonly opts: ParseOptions;
	private readonly wordsKey: string;
	private running: Promise<void> | null = null;
	onChange: () => void = () => {};

	constructor(opts: ParseOptions) {
		this.opts = opts;
		this.wordsKey = JSON.stringify([opts.politeWords, opts.rushWords]);
	}

	loadCache(): void {
		try {
			const data = JSON.parse(readFileSync(indexPath(), "utf8")) as IndexFile;
			if (data.version !== INDEX_VERSION || data.wordsKey !== this.wordsKey) return;
			for (const [k, v] of Object.entries(data.records)) this.records.set(k, v);
			this.revision++;
		} catch {
			/* first run or corrupt cache: rebuild */
		}
	}

	saveCache(): void {
		const data: IndexFile = { version: INDEX_VERSION, wordsKey: this.wordsKey, records: Object.fromEntries(this.records) };
		saveJsonAtomic(indexPath(), data);
	}

	refresh(): Promise<void> {
		this.running ??= this.run().finally(() => {
			this.running = null;
		});
		return this.running;
	}

	/** Re-parse one file now (after rename/profile edits). */
	async reparse(file: string): Promise<void> {
		try {
			const st = statSync(file);
			this.records.set(file, await parseSessionFile(file, st, this.opts));
		} catch {
			this.records.delete(file);
		}
		this.revision++;
		this.onChange();
	}

	remove(file: string): void {
		if (this.records.delete(file)) {
			this.revision++;
			this.onChange();
		}
	}

	private async run(): Promise<void> {
		let files: string[];
		try {
			files = listSessionFiles();
		} catch (e) {
			this.progress = { done: 0, total: 0, finished: true, parsed: 0, error: String(e) };
			this.onChange();
			return;
		}
		const seen = new Set(files);
		for (const k of [...this.records.keys()]) if (!seen.has(k)) this.records.delete(k);
		const stale: { file: string; size: number; mtimeMs: number }[] = [];
		for (const file of files) {
			try {
				const st = statSync(file);
				const r = this.records.get(file);
				if (!r || r.size !== st.size || r.mtimeMs !== st.mtimeMs) stale.push({ file, size: st.size, mtimeMs: st.mtimeMs });
			} catch {
				this.records.delete(file);
			}
		}
		// Newest first so the home page fills in with recent sessions immediately.
		stale.sort((a, b) => b.mtimeMs - a.mtimeMs);
		this.progress = { done: files.length - stale.length, total: files.length, finished: false, parsed: 0 };
		this.revision++;
		this.onChange();
		let lastNotify = Date.now();
		for (const s of stale) {
			try {
				this.records.set(s.file, await parseSessionFile(s.file, s, this.opts));
			} catch {
				/* unreadable file: skip, retried next run */
			}
			this.progress.done++;
			this.progress.parsed++;
			if (Date.now() - lastNotify > 150) {
				lastNotify = Date.now();
				this.revision++;
				this.onChange();
			}
		}
		if (stale.length > 0) {
			try {
				this.saveCache();
			} catch (e) {
				this.progress.error = `cache write failed: ${String(e)}`;
			}
		}
		this.progress.finished = true;
		this.revision++;
		this.onChange();
	}
}
