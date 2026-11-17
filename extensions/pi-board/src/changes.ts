// Change log (DESIGN §6): <main repo>/.pi/changes/<sessionId>.jsonl, one file per pi session.

import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ChangeEvent, ChangeLogEvent, MergedEvent, TurnEvent } from "./shared/types.ts";

const MAX_LINE_BYTES = 1024 * 1024;
const IGNORE_ENTRIES = new Set([".pi/changes/", ".pi/changes", "/.pi/changes/", "/.pi/changes", ".pi/", ".pi", "/.pi/", "/.pi"]);

export interface LeadState {
	session: string;
	turn: number;
	time: string;
}

export function changesDir(mainRoot: string): string {
	return join(mainRoot, ".pi", "changes");
}

/** One state file per lead session, so several leads in one repository do not overwrite each other. */
export function leadStateDir(mainRoot: string): string {
	return join(changesDir(mainRoot), "lead-state");
}

export function leadStatePath(mainRoot: string, leadSession: string): string {
	return join(leadStateDir(mainRoot), `${leadSession}.json`);
}

function readStateFile(path: string): LeadState | undefined {
	try {
		const data = JSON.parse(readFileSync(path, "utf8")) as Partial<LeadState>;
		if (typeof data.session === "string" && typeof data.turn === "number") {
			return { session: data.session, turn: data.turn, time: data.time ?? "" };
		}
	} catch {
		// missing or half-written: treated as unknown
	}
	return undefined;
}

/**
 * The lead state a member or subagent tags its changes with. Team members find their lead through
 * `run.json` in PI_TEAM_RUN_DIR; subagents (and members whose run file is unreadable) take the most recently updated file.
 */
export function readLeadState(mainRoot: string, env: NodeJS.ProcessEnv = process.env): LeadState | undefined {
	const runDir = env.PI_TEAM_RUN_DIR;
	if (runDir) {
		try {
			const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as { leadSessionId?: string };
			if (typeof run.leadSessionId === "string" && run.leadSessionId !== "") {
				return readStateFile(leadStatePath(mainRoot, run.leadSessionId)) ?? { session: run.leadSessionId, turn: 0, time: "" };
			}
		} catch {
			// fall through to the newest state
		}
	}
	const dir = leadStateDir(mainRoot);
	let newest: { path: string; mtime: number } | undefined;
	try {
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".json")) continue;
			const path = join(dir, name);
			const mtime = statSync(path).mtimeMs;
			if (!newest || mtime > newest.mtime) newest = { path, mtime };
		}
	} catch {
		return undefined;
	}
	return newest ? readStateFile(newest.path) : undefined;
}

export interface ChangeLog {
	readonly session: string;
	/** Current lead turn (lead only; members read the lead state instead). */
	turn(): number;
	nextTurn(prompt: string): number;
	nextChangeId(): string;
	append(event: ChangeLogEvent): void;
	writeLeadState(): void;
}

/**
 * `gitRoot` is the main repository root when it is a git repository (so that `.pi/changes/` gets ignored there),
 * undefined otherwise.
 */
export function openChangeLog(mainRoot: string, session: string, gitRoot: string | undefined): ChangeLog {
	const dir = changesDir(mainRoot);
	const file = join(dir, `${session}.jsonl`);
	let loaded = false;
	let turn = 0;
	let seq = 0;
	let prepared = false;

	// A resumed session continues its own numbering.
	const load = () => {
		if (loaded) return;
		loaded = true;
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			return;
		}
		for (const line of text.split("\n")) {
			if (line === "") continue;
			try {
				const ev = JSON.parse(line) as ChangeLogEvent;
				if (ev.type === "turn") turn = Math.max(turn, ev.turn);
				else if (ev.type === "change") seq = Math.max(seq, Number(ev.id.slice(ev.id.lastIndexOf(":") + 1)) || 0);
			} catch {
				// skip torn lines
			}
		}
	};

	const prepare = () => {
		if (prepared) return;
		mkdirSync(dir, { recursive: true });
		if (gitRoot) ensureIgnored(gitRoot);
		prepared = true;
	};

	return {
		session,
		turn: () => {
			load();
			return turn;
		},
		nextTurn: (prompt) => {
			load();
			turn += 1;
			const event: TurnEvent = {
				type: "turn",
				time: new Date().toISOString(),
				session,
				turn,
				prompt: firstLine(prompt),
			};
			prepare();
			appendFileSync(file, `${JSON.stringify(event)}\n`);
			return turn;
		},
		nextChangeId: () => {
			load();
			seq += 1;
			return `${session}:${seq}`;
		},
		append: (event) => {
			prepare();
			let line = JSON.stringify(event);
			// A single huge line is hard for readers; keep the record but drop its diff.
			if (event.type === "change" && Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
				line = JSON.stringify({ ...event, diff: "", truncated: true });
			}
			appendFileSync(file, `${line}\n`);
		},
		writeLeadState: () => {
			load();
			prepare();
			mkdirSync(leadStateDir(mainRoot), { recursive: true });
			const state: LeadState = { session, turn, time: new Date().toISOString() };
			const path = leadStatePath(mainRoot, session);
			const tmp = `${path}.${process.pid}.tmp`;
			writeFileSync(tmp, `${JSON.stringify(state)}\n`);
			renameSync(tmp, path);
		},
	};
}

function firstLine(prompt: string): string {
	const line = prompt.split("\n").find((l) => l.trim() !== "") ?? "";
	const text = line.trim();
	return text === "" ? "(no text)" : [...text].slice(0, 120).join("");
}

function ensureIgnored(gitRoot: string): void {
	const path = join(gitRoot, ".gitignore");
	let text = "";
	try {
		text = readFileSync(path, "utf8");
	} catch {
		// no .gitignore yet
	}
	if (text.split(/\r?\n/).some((l) => IGNORE_ENTRIES.has(l.trim()))) return;
	appendFileSync(path, `${text === "" || text.endsWith("\n") ? "" : "\n"}.pi/changes/\n`);
}

export function mergedEvent(session: string, memberId: string): MergedEvent {
	return { type: "merged", time: new Date().toISOString(), session, memberId };
}

// ---------------------------------------------------------------------------------------------
// Counting for the widget
// ---------------------------------------------------------------------------------------------

interface FileScan {
	pos: number;
	counts: Map<string, number>;
	/** Bytes of an incomplete trailing line carried to the next read. */
	rest: Buffer;
}

/** Counts change events per (leadSession, turn) across all session files, reading each file incrementally. */
export function createTurnCounter(mainRoot: string): (leadSession: string, turn: number) => number {
	const dir = changesDir(mainRoot);
	const scans = new Map<string, FileScan>();

	return (leadSession, turn) => {
		if (!existsSync(dir)) return 0;
		let total = 0;
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(dir, name);
			let size: number;
			try {
				size = statSync(path).size;
			} catch {
				continue;
			}
			let scan = scans.get(path);
			if (!scan || size < scan.pos) {
				scan = { pos: 0, counts: new Map(), rest: Buffer.alloc(0) };
				scans.set(path, scan);
			}
			if (size > scan.pos) {
				const buf = Buffer.alloc(size - scan.pos);
				const fd = openSync(path, "r");
				try {
					readSync(fd, buf, 0, buf.length, scan.pos);
				} finally {
					closeSync(fd);
				}
				scan.pos = size;
				const data = Buffer.concat([scan.rest, buf]);
				const lastNewline = data.lastIndexOf(0x0a);
				scan.rest = data.subarray(lastNewline + 1);
				const complete = lastNewline < 0 ? "" : data.subarray(0, lastNewline).toString("utf8");
				for (const line of complete.split("\n")) {
					if (!line.includes('"type":"change"')) continue;
					try {
						const ev = JSON.parse(line) as ChangeEvent;
						const key = `${ev.leadSession}#${ev.turn}`;
						scan.counts.set(key, (scan.counts.get(key) ?? 0) + 1);
					} catch {
						// skip torn lines
					}
				}
			}
			total += scan.counts.get(`${leadSession}#${turn}`) ?? 0;
		}
		return total;
	};
}
