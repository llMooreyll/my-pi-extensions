// Reads docs/board/ and .pi/changes/ from the main repo and keeps them current.
// The pane never writes either location.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { markdownAnchors, parseBoard, validateBoard } from "../shared/parse.ts";
import type { Board, BoardFile, BoardIssue, ChangeEvent, ChangeLogEvent, TurnEvent } from "../shared/types.ts";

export const BOARD_DIR = "docs/board";
export const CHANGES_DIR = ".pi/changes";

export interface BoardState {
	board: Board;
	/** Raw docs/board/*.md contents the board was parsed from (used to rebuild the turn-start board). */
	files: BoardFile[];
	/** Parse issues plus consistency issues (rule 3 skipped: it needs git HEAD). */
	issues: BoardIssue[];
	loadedAt: Date;
}

export function loadBoard(root: string): BoardState {
	const dir = join(root, BOARD_DIR);
	const files: BoardFile[] = [];
	if (existsSync(dir)) {
		for (const name of readdirSync(dir).sort()) {
			if (!name.endsWith(".md")) continue;
			const path = `${BOARD_DIR}/${name}`;
			try {
				files.push({ path, content: readFileSync(join(root, path), "utf8") });
			} catch {
				// File vanished between readdir and read; the watcher reloads shortly.
			}
		}
	}
	const board = parseBoard(files);
	const anchorCache = new Map<string, Set<string> | undefined>();
	const consistency = validateBoard(board, {
		headIds: new Set(),
		fileExists: (p) => existsSync(join(root, p)),
		anchorsOf: (p) => {
			if (anchorCache.has(p)) return anchorCache.get(p);
			let anchors: Set<string> | undefined;
			if (p.endsWith(".md")) {
				try {
					anchors = markdownAnchors(readFileSync(join(root, p), "utf8"));
				} catch {
					anchors = undefined;
				}
			}
			anchorCache.set(p, anchors);
			return anchors;
		},
	});
	const seen = new Set<string>();
	const issues = [...board.issues, ...consistency].filter((i) => {
		const key = `${i.file}:${i.line}:${i.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return { board, files, issues, loadedAt: new Date() };
}

export interface TurnGroup {
	key: string;
	leadSession: string;
	turn: number;
	/** Undefined when the turn event was not found (e.g. log started mid-turn). */
	info?: TurnEvent;
	changes: ChangeEvent[];
	/** Sort time: the turn event, else the first change. */
	time: string;
}

/** Tails every .jsonl file in .pi/changes/, reading only appended bytes. */
export class ChangeLog {
	readonly turns = new Map<string, TurnEvent>();
	readonly changes: ChangeEvent[] = [];
	readonly merged = new Set<string>();
	private offsets = new Map<string, number>();
	/** Bytes after the last newline; kept as bytes so a read never splits a UTF-8 character. */
	private partial = new Map<string, Buffer>();
	private dir: string;

	constructor(root: string) {
		this.dir = join(root, CHANGES_DIR);
	}

	/** Returns true when something new was read. */
	poll(): boolean {
		if (!existsSync(this.dir)) return false;
		let changed = false;
		for (const name of readdirSync(this.dir)) {
			if (!name.endsWith(".jsonl")) continue;
			if (this.readFile(join(this.dir, name))) changed = true;
		}
		return changed;
	}

	private readFile(path: string): boolean {
		let size: number;
		try {
			size = statSync(path).size;
		} catch {
			return false;
		}
		const from = this.offsets.get(path) ?? 0;
		if (size <= from) return false;
		const buf = Buffer.alloc(size - from);
		const fd = openSync(path, "r");
		try {
			readSync(fd, buf, 0, buf.length, from);
		} finally {
			closeSync(fd);
		}
		this.offsets.set(path, size);
		const bytes = Buffer.concat([this.partial.get(path) ?? Buffer.alloc(0), buf]);
		const cut = bytes.lastIndexOf(0x0a);
		this.partial.set(path, bytes.subarray(cut + 1));
		if (cut < 0) return false;
		const lines = bytes.subarray(0, cut).toString("utf8").split("\n");
		let changed = false;
		for (const line of lines) {
			if (!line.trim()) continue;
			let ev: ChangeLogEvent;
			try {
				ev = JSON.parse(line) as ChangeLogEvent;
			} catch {
				continue;
			}
			this.add(ev);
			changed = true;
		}
		return changed;
	}

	private add(ev: ChangeLogEvent): void {
		if (ev.type === "turn") this.turns.set(`${ev.session}:${ev.turn}`, ev);
		else if (ev.type === "merged") this.merged.add(ev.memberId);
		else if (ev.type === "change") this.changes.push(ev);
	}

	isUnmerged(c: ChangeEvent): boolean {
		return c.status === "unmerged" && !(c.memberId && this.merged.has(c.memberId));
	}

	/** Turn groups, newest first; changes inside a group oldest first. */
	groups(filter: (c: ChangeEvent) => boolean): TurnGroup[] {
		const map = new Map<string, TurnGroup>();
		for (const c of this.changes) {
			if (!filter(c)) continue;
			const key = `${c.leadSession}:${c.turn}`;
			let g = map.get(key);
			if (!g) {
				const info = this.turns.get(key);
				g = { key, leadSession: c.leadSession, turn: c.turn, info, changes: [], time: info?.time ?? c.time };
				map.set(key, g);
			}
			g.changes.push(c);
		}
		for (const g of map.values()) g.changes.sort((a, b) => a.time.localeCompare(b.time));
		return [...map.values()].sort((a, b) => b.time.localeCompare(a.time));
	}
}

function sourcesSignature(root: string): string {
	const parts: string[] = [];
	for (const rel of [BOARD_DIR, CHANGES_DIR]) {
		const abs = join(root, rel);
		if (!existsSync(abs)) continue;
		for (const name of readdirSync(abs)) {
			try {
				const s = statSync(join(abs, name));
				parts.push(`${rel}/${name}:${s.size}:${s.mtimeMs}`);
			} catch {
				// Removed between readdir and stat.
			}
		}
	}
	return parts.join("|");
}

/** Watches the board and change directories; calls `onChange` debounced. Re-arms when a directory appears. */
export function watchSources(root: string, onChange: () => void): () => void {
	const watchers = new Map<string, FSWatcher>();
	let timer: NodeJS.Timeout | undefined;
	const fire = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(onChange, 120);
	};
	const arm = () => {
		for (const rel of [BOARD_DIR, CHANGES_DIR]) {
			const abs = join(root, rel);
			if (watchers.has(abs) || !existsSync(abs)) continue;
			try {
				const w = watch(abs, fire);
				w.on("error", () => {
					watchers.delete(abs);
					w.close();
				});
				watchers.set(abs, w);
			} catch {
				// Directory not watchable right now; the interval below retries.
			}
		}
	};
	arm();
	// fs.watch misses events on some setups and cannot watch directories that do not exist yet;
	// the interval re-arms and fires only when a file's size or mtime changed.
	let signature = sourcesSignature(root);
	const interval = setInterval(() => {
		arm();
		const next = sourcesSignature(root);
		if (next !== signature) {
			signature = next;
			fire();
		}
	}, 2000);
	return () => {
		clearInterval(interval);
		if (timer) clearTimeout(timer);
		for (const w of watchers.values()) w.close();
	};
}
