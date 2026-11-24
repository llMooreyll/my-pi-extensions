// Per-session trigger state, one JSON file per session under ~/.pi/agent/pi-trigger/sessions/.
//
// The pi-trigger extension of the process that has the session open is the only writer. The trigger
// hub in pi-hostd reads these files (alias, sessionFile, nextWakeAt, paused) to route events and to
// reopen closed sessions; keep extensions/pi-remote/packages/hostd/src/triggers/types.ts in sync.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SendPolicy } from "./cache-timer.js";

export type ContextPolicy = "keep" | "rebase";

export type TimerSchedule =
	| { kind: "once"; at: number }
	| { kind: "every"; everyMs: number }
	/** Local wall-clock time "HH:MM". */
	| { kind: "daily"; time: string };

export interface Timer {
	id: string;
	/** What to do when the timer fires, written by the agent for itself. */
	prompt: string;
	schedule: TimerSchedule;
	nextFireAt: number;
	runs: number;
	maxRuns?: number;
	expiresAt?: number;
	/** "skip": drop a run that comes due while the agent is working. */
	whenBusy: "queue" | "skip";
	/** "once": fire one catch-up run for runs missed while the session was closed; "skip": drop them. */
	catchUp: "once" | "skip";
	/** Ask pi-hostd to reopen the session when the timer comes due while it is closed. */
	wake: boolean;
	createdAt: number;
	lastFiredAt?: number;
}

/** A trigger waiting to be delivered into the conversation. */
export interface PendingItem {
	/** Dedupe key: "timer:<id>:<run>" or the hub's event key. */
	key: string;
	kind: "timer" | "event";
	/** Timer id, or "<source>/<kind>" of an event. */
	label: string;
	title: string;
	/** Text given to the model. */
	body: string;
	at: number;
	/** Route id of an event. */
	route?: string;
	/** Tools the run may use; undefined means all. */
	allowedTools?: string[];
	run?: number;
	maxRuns?: number;
	/** Timer that fires again; only these get the hint to cancel. */
	repeating?: boolean;
}

export interface SessionState {
	version: 1;
	sessionId: string;
	sessionFile?: string;
	cwd: string;
	/** Name external triggers use to address this session ("archive" for "@archive"). */
	alias?: string;
	/** When the alias was taken; the newest claim wins when two sessions use the same alias. */
	aliasSetAt?: number;
	contextPolicy: ContextPolicy;
	/** Entry each trigger run starts from under the "rebase" policy. */
	baseEntryId?: string;
	/** Overrides pi-cache-timer's extensionSends["pi-trigger"] for this session. */
	sends?: SendPolicy;
	paused: boolean;
	/** Overrides the configured daily budget; 0 means no limit. */
	dailyBudgetUsd?: number;
	spent: { day: string; usd: number };
	timers: Timer[];
	pending: PendingItem[];
	/** Recently delivered keys, newest last. */
	delivered: string[];
	/** Earliest nextFireAt of timers with wake: true; read by the hub. */
	nextWakeAt?: number;
	updatedAt: number;
}

export const DELIVERED_LIMIT = 500;
export const PENDING_LIMIT = 200;

export function triggerDir(): string {
	return join(getAgentDir(), "pi-trigger");
}

export function sessionsDir(): string {
	return join(triggerDir(), "sessions");
}

function stateFile(sessionId: string): string {
	return join(sessionsDir(), `${sessionId}.json`);
}

export function localDay(time: number): string {
	const d = new Date(time);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function emptyState(sessionId: string, sessionFile: string | undefined, cwd: string): SessionState {
	return {
		version: 1,
		sessionId,
		...(sessionFile ? { sessionFile } : {}),
		cwd,
		contextPolicy: "keep",
		paused: false,
		spent: { day: localDay(Date.now()), usd: 0 },
		timers: [],
		pending: [],
		delivered: [],
		updatedAt: Date.now(),
	};
}

export function loadState(sessionId: string, sessionFile: string | undefined, cwd: string): SessionState {
	const fresh = emptyState(sessionId, sessionFile, cwd);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(stateFile(sessionId), "utf8"));
	} catch {
		return fresh;
	}
	if (!isRecord(raw) || raw.version !== 1) return fresh;
	const loaded = { ...fresh, ...(raw as Partial<SessionState>) };
	// The session file and folder come from the running session, not from the stored copy.
	loaded.sessionId = sessionId;
	loaded.cwd = cwd;
	if (sessionFile) loaded.sessionFile = sessionFile;
	if (!Array.isArray(loaded.timers)) loaded.timers = [];
	if (!Array.isArray(loaded.pending)) loaded.pending = [];
	if (!Array.isArray(loaded.delivered)) loaded.delivered = [];
	if (!isRecord(loaded.spent)) loaded.spent = fresh.spent;
	return loaded;
}

/** True when the state holds nothing worth keeping, so no file is needed. */
function isEmpty(state: SessionState): boolean {
	return (
		state.timers.length === 0 &&
		state.pending.length === 0 &&
		!state.alias &&
		state.contextPolicy === "keep" &&
		state.sends === undefined &&
		!state.paused &&
		state.dailyBudgetUsd === undefined
	);
}

/** Writes atomically; sessions without a session file (--no-session) are kept in memory only. */
export function saveState(state: SessionState): void {
	if (!state.sessionFile) return;
	state.updatedAt = Date.now();
	const file = stateFile(state.sessionId);
	if (isEmpty(state)) {
		rmSync(file, { force: true });
		return;
	}
	mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
}

/** Other sessions' states, for alias conflicts. Unreadable files are skipped. */
export function otherStates(sessionId: string): SessionState[] {
	let names: string[];
	try {
		names = readdirSync(sessionsDir());
	} catch {
		return [];
	}
	const states: SessionState[] = [];
	for (const name of names) {
		if (!name.endsWith(".json") || name === `${sessionId}.json`) continue;
		try {
			const raw: unknown = JSON.parse(readFileSync(join(sessionsDir(), name), "utf8"));
			if (isRecord(raw) && raw.version === 1) states.push(raw as unknown as SessionState);
		} catch {
			// Being written or not ours.
		}
	}
	return states;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
