// Data contract shared by the pi extension (writer/validator) and the board pane (reader).
// Spec: ../../DESIGN.md §3, §6, §8.4. Both sides import only from this file and parse.ts.

/** Built-in sections. Extra sections come from frontmatter in docs/board/<name>.md (DESIGN §3.5). */
export type SectionKind = "task" | "decision" | "conflict" | "custom";

export interface SectionSchema {
	kind: SectionKind;
	/** Repo-relative path, e.g. "docs/board/tasks.md". */
	file: string;
	/** Display name: "Tasks", "Decisions", "Conflicts", or frontmatter `section`. */
	title: string;
	/** Id prefix: "T", "D", "C", or frontmatter `prefix`. */
	prefix: string;
	statuses: string[];
	/** Subset of `statuses` that counts as closed (hidden by default in the pane). */
	closed: string[];
	/** Required field keys besides `status`. Custom sections: frontmatter `fields`. */
	required: string[];
}

export interface EntryRef {
	/** Field the reference came from: refs, between, affects, supersedes, superseded-by, resolved-by. */
	field: string;
	kind: "entry" | "link";
	/** kind=entry: "T12". */
	id?: string;
	/** kind=link: link text, repo-relative target path, optional anchor (without '#'). */
	text?: string;
	target?: string;
	anchor?: string;
}

export interface BoardEntry {
	/** "T12" */
	id: string;
	prefix: string;
	num: number;
	title: string;
	/** Repo-relative file path. */
	file: string;
	/** 1-based line of the `## ` heading. */
	line: number;
	/** Field values in source order, keys lowercased. */
	fields: Record<string, string>;
	fieldLines: Record<string, number>;
	/** Free text after the field lines, trimmed. */
	body: string;
	status: string;
	closed: boolean;
	refs: EntryRef[];
}

export interface BoardIssue {
	file: string;
	/** 1-based; 0 when the issue concerns the whole file. */
	line: number;
	id?: string;
	/** Stable rule name (e.g. "heading", "field", "dup-id", "ref", "supersede"); with file, id and message it identifies an issue across edits. */
	rule?: string;
	/** One actionable sentence: what is wrong and how to fix it. */
	message: string;
}

export interface Board {
	sections: SectionSchema[];
	entries: BoardEntry[];
	byId: Map<string, BoardEntry>;
	/** Format problems found while parsing. Consistency problems come from validateBoard(). */
	issues: BoardIssue[];
}

export interface BoardFile {
	/** Repo-relative path under docs/board/. */
	path: string;
	content: string;
}

/** Filesystem/git facts the validator needs; injected so the parser stays pure. */
export interface ValidationContext {
	/** Entry ids present in docs/board/ at git HEAD (rule 3: ids may not disappear). */
	headIds: Set<string>;
	/** Repo-relative path exists. */
	fileExists(path: string): boolean;
	/** GitHub-style anchors of the Markdown file at `path`, or undefined if not Markdown/unreadable. */
	anchorsOf(path: string): Set<string> | undefined;
}

// ---- Change log: <main repo>/.pi/changes/<sessionId>.jsonl, one JSON object per line ----

export type Actor = "lead" | `team:${string}` | `sub:${string}`;

/** Written by the lead when a user message starts a new turn; groups the Changes page. */
export interface TurnEvent {
	type: "turn";
	time: string; // ISO
	session: string;
	/** Monotonic per session, starts at 1. */
	turn: number;
	/** First line of the user message, at most 120 chars. */
	prompt: string;
}

export interface ChangeEvent {
	type: "change";
	id: string; // `${session}:${seq}`
	time: string;
	session: string;
	actor: Actor;
	memberId?: string;
	branch?: string;
	/** Lead turn active when the change happened (members: read from the lead's state file). */
	turn: number;
	/** Lead session id the turn belongs to (equals `session` for the lead). */
	leadSession: string;
	tool: "write" | "edit";
	/** Repo-relative path, relative to the worktree root for members. */
	path: string;
	message: string;
	task?: string;
	category: "plan" | "code";
	/** write to a path that did not exist before. */
	created?: boolean;
	added: number;
	removed: number;
	/** Unified diff with 3 lines of context, headers `--- a/<path>` / `+++ b/<path>`. */
	diff: string;
	truncated?: boolean;
	/** Members only, set at write time. Merging is reported by MergedEvent. */
	status?: "unmerged";
}

/** Appended by the lead after a successful team_integrate of a member. */
export interface MergedEvent {
	type: "merged";
	time: string;
	session: string;
	memberId: string;
}

export type ChangeLogEvent = TurnEvent | ChangeEvent | MergedEvent;

// ---- Pane -> extension socket: $XDG_RUNTIME_DIR/pi-board/<sessionId>.sock, newline-delimited JSON ----

export interface QuoteRequest {
	type: "quote";
	/** Text inserted at the editor cursor, not sent. One line per quoted item. */
	text: string;
}

export type PaneRequest = QuoteRequest;

/** Pane command line (DESIGN §8.1):
 *  node <ext>/src/pane/main.ts --root <main repo root> --session <lead sessionId> --socket <path>
 */
export interface PaneArgs {
	root: string;
	session: string;
	socket: string;
}
