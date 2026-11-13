/**
 * Session index records (SESSIONS.md §3). One SessionRecord per .jsonl file; L1 summary fields at
 * the top level, L2 event columns in `ev`. Timestamps are epoch milliseconds.
 */

export const INDEX_VERSION = 3;

export interface TokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
}

export interface ModelStat {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Sum of assistant durationMs where present. */
	ms: number;
	errors: number;
}

export interface ToolStat {
	calls: number;
	errors: number;
	ms: number;
}

export interface FileStat {
	read: number;
	edit: number;
	write: number;
}

/**
 * Column-oriented events. Arrays prefixed with the same letter have equal length.
 * String-valued columns hold indexes into `dict`.
 */
export interface SessionEvents {
	dict: string[];
	/** Assistant calls. */
	cT: number[];
	/** durationMs, -1 when missing. */
	cDur: number[];
	cIn: number[];
	cOut: number[];
	cCR: number[];
	cCW: number[];
	cRsn: number[];
	cCost: number[];
	/** dict index of "provider/model". */
	cModel: number[];
	/** dict index of thinkingLevel ("" when missing). */
	cThink: number[];
	/** dict index of stopReason. */
	cStop: number[];
	/** Number of toolCall blocks in this message. */
	cTools: number[];
	/** Characters of text / thinking content. */
	cText: number[];
	cThinkLen: number[];

	/** Tool results. */
	tT: number[];
	/** dict index of toolName. */
	tTool: number[];
	tDur: number[];
	/** 1 = isError. */
	tErr: number[];
	/** Characters of text content. */
	tLen: number[];

	/** User messages. */
	uT: number[];
	uLen: number[];
	/** Percentage (0..100) of Han characters among non-space characters. */
	uHan: number[];
	uImg: number[];
	/** Bit flags, see USER_FLAG_*. */
	uFlags: number[];

	/** Other events (compaction, model_change, ...). */
	eT: number[];
	/** dict index of kind name (see EVENT_KINDS). */
	eKind: number[];
	/** compaction: tokensBefore; cache_warm: cost×1e6 (integer micro-dollars); model_change / thinking_level_change: dict index of new value; others 0. */
	eVal: number[];

	/** Edit/write calls. */
	dT: number[];
	dAdd: number[];
	dDel: number[];
	/** dict index of file path. */
	dFile: number[];
}

export const USER_FLAG_BROWSER = 1;
export const USER_FLAG_SKILL = 2;
export const USER_FLAG_IMAGE = 4;
export const USER_FLAG_POLITE = 8;
export const USER_FLAG_RUSH = 16;

export const EVENT_KINDS = [
	"compaction",
	"model_change",
	"thinking_level_change",
	"cache_warm",
	"branch_summary",
	"context_edit",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface SessionRecord {
	file: string;
	size: number;
	mtimeMs: number;
	id: string;
	cwd: string;
	created: number;
	parentSession: string | null;
	/** Latest session_info name. */
	name: string | null;
	/** First user message as one line, at most 200 characters. */
	firstUserMessage: string;
	lastActivity: number;
	isSubagent: boolean;
	/** Lines that failed JSON.parse and were skipped. */
	badLines: number;
	userTurns: number;
	assistantMessages: number;
	toolCalls: number;
	/** Assistant messages with stopReason error / aborted / length. */
	errors: number;
	aborted: number;
	truncated: number;
	tokens: TokenTotals;
	/** Sum of assistant usage.cost.total (excludes cache warm-ups). */
	cost: number;
	/** Cache warm-up spend (type "usage", kind "cache_warm"). */
	warmCost: number;
	warmCount: number;
	models: Record<string, ModelStat>;
	tools: Record<string, ToolStat>;
	/** Up to 300 most-touched paths. */
	files: Record<string, FileStat>;
	compactions: number;
	/** Entries with more than one child. */
	branches: number;
	/** Sum of gaps under 5 minutes between consecutive entries, in minutes. */
	activeMinutes: number;
	/** Largest input+cacheRead+cacheWrite of a single call (≈ context size). */
	maxContext: number;
	/** Latest pi-home/profile custom entry data. */
	profile: unknown;
	/** Counts of custom / custom_message customType values. */
	customTypes: Record<string, number>;
	/** First word of bash commands. */
	bashCmds: Record<string, number>;
	gitSubs: Record<string, number>;
	/** Fenced code block languages in assistant text. */
	codeLangs: Record<string, number>;
	/** Top user-message words (Intl.Segmenter), at most 80. */
	words: Record<string, number>;
	/** Skill names referenced by user messages. */
	skills: Record<string, number>;
	politeCount: number;
	rushCount: number;
	editAdd: number;
	editDel: number;
	/** Longest run recorded by pi-run-timer (ms) and its prompt preview. */
	longestRunMs: number;
	longestRunPrompt: string;
	ev: SessionEvents;
}

export interface IndexFile {
	version: number;
	/** Words lists the records were built with; a change forces a rebuild. */
	wordsKey: string;
	records: Record<string, SessionRecord>;
}
