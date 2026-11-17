// "This turn": everything the newest user turn changed, both plan entries and code files.
// Plan entry changes are exact: the turn-start board is rebuilt by undoing this turn's plan
// diffs (newest first) on the current files and compared entry by entry. When a diff no longer
// fits the file (hand edit, truncated diff) the affected file falls back to "touched" entries.

import { canonicalId, parseBoard } from "../shared/parse.ts";
import type { BoardEntry, BoardFile, ChangeEvent, SectionSchema, TurnEvent } from "../shared/types.ts";
import type { BoardState, ChangeLog } from "./data.ts";
import { parseDiff, renderDiff, reverseApply } from "./diff.ts";
import { DEFAULT_PREFIXES, inline, richWrap } from "./rich.ts";
import { type Paint, spread, style, truncate, width, wrap } from "./term.ts";
import { type Row, entryCard } from "./views.ts";

export type PlanChangeKind = "new" | "status" | "edit" | "removed" | "touched";

export interface PlanChange {
	id: string;
	title: string;
	kind: PlanChangeKind;
	from?: string;
	to?: string;
	/** Field keys (plus "title"/"body") whose value changed, for kind "edit"/"status". */
	fields: string[];
	/** Current entry, absent when removed. */
	entry?: BoardEntry;
}

export interface FileChange {
	path: string;
	added: number;
	removed: number;
	created: boolean;
	actors: string[];
	/** Every write/edit of this file in the turn, oldest first. */
	changes: ChangeEvent[];
}

export interface TurnSummary {
	key: string;
	turn: number;
	info?: TurnEvent;
	time: string;
	plan: PlanChange[];
	files: FileChange[];
	/** False when some plan file could not be rebuilt and its entries are only "touched". */
	exact: boolean;
}

/** Newest turn of the current lead session, or undefined when nothing changed in it. */
export function currentTurn(state: BoardState, log: ChangeLog, session: string): TurnSummary | undefined {
	let latest: TurnEvent | undefined;
	for (const t of log.turns.values()) {
		if (t.session === session && (!latest || t.turn > latest.turn)) latest = t;
	}
	const group = log.groups((c) => c.leadSession === session && (!latest || c.turn === latest.turn))[0];
	if (!group || (latest && group.turn !== latest.turn)) return undefined;
	const changes = group.changes;

	const plan = planChanges(state, log, changes.filter((c) => c.category === "plan"));
	const files = fileChanges(changes.filter((c) => c.category !== "plan"));
	if (!plan.changes.length && !files.length) return undefined;
	return { key: group.key, turn: group.turn, info: group.info, time: group.time, plan: plan.changes, files, exact: plan.exact };
}

/**
 * Undoes `changes` (oldest first in the array) on `current`, newest first. Undefined when a diff
 * does not fit the text. Changes that recorded no difference (a write of identical content) are skipped.
 */
export function contentBefore(current: string, changes: ChangeEvent[]): string | undefined {
	let text: string | undefined = current;
	for (const c of [...changes].reverse()) {
		if (!c.diff && !c.truncated && c.added === 0 && c.removed === 0) continue;
		if (c.truncated || !c.diff) return undefined;
		if (c.created) return "";
		text = reverseApply(text, c.diff);
		if (text === undefined) return undefined;
	}
	return text;
}

/** Recorded changes of `path` that are present in the main worktree, oldest first. */
export function fileHistory(log: ChangeLog, path: string): ChangeEvent[] {
	return log.changes.filter((c) => c.path === path && !log.isUnmerged(c)).sort((a, b) => a.time.localeCompare(b.time));
}

/** Content of `path` just before `first`: every recorded change from `first` onwards is undone. */
export function contentBeforeChange(current: string, log: ChangeLog, first: ChangeEvent): string | undefined {
	const history = fileHistory(log, first.path);
	const at = history.indexOf(first);
	return at < 0 ? undefined : contentBefore(current, history.slice(at));
}

/** Content of `path` just after `last`: every recorded change after `last` is undone. */
export function contentAfterChange(current: string, log: ChangeLog, last: ChangeEvent): string | undefined {
	const history = fileHistory(log, last.path);
	const at = history.indexOf(last);
	return at < 0 ? undefined : contentBefore(current, history.slice(at + 1));
}

function planChanges(state: BoardState, log: ChangeLog, changes: ChangeEvent[]): { changes: PlanChange[]; exact: boolean } {
	if (!changes.length) return { changes: [], exact: true };
	const byPath = new Map<string, ChangeEvent[]>();
	for (const c of changes) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c]);

	const oldFiles: BoardFile[] = [];
	const failed = new Set<string>();
	// A plan file changed this turn but gone now cannot be rebuilt from the current files.
	const gone = [...byPath.keys()].filter((p) => !state.files.some((f) => f.path === p));
	for (const f of state.files) {
		const own = byPath.get(f.path);
		if (!own) {
			oldFiles.push(f);
			continue;
		}
		const before = contentBeforeChange(f.content, log, own[0]);
		if (before === undefined) failed.add(f.path);
		else if (before !== "") oldFiles.push({ path: f.path, content: before });
	}

	const now = state.board.entries;
	const old = new Map(parseBoard(oldFiles).entries.map((e) => [canonicalId(e.id), e]));
	const out: PlanChange[] = [];
	const seen = new Set<string>();
	for (const e of now) {
		const key = canonicalId(e.id);
		seen.add(key);
		if (failed.has(e.file)) continue;
		const prev = old.get(key);
		if (!prev) {
			out.push({ id: e.id, title: e.title, kind: "new", to: e.status, fields: [], entry: e });
			continue;
		}
		const fields = changedFields(prev, e);
		if (!fields.length) continue;
		const statusChanged = prev.status !== e.status;
		out.push({
			id: e.id,
			title: e.title,
			kind: statusChanged ? "status" : "edit",
			from: statusChanged ? prev.status : undefined,
			to: statusChanged ? e.status : undefined,
			fields: fields.filter((f) => f !== "status"),
			entry: e,
		});
	}
	for (const [key, prev] of old) {
		if (!seen.has(key) && !failed.has(prev.file)) out.push({ id: prev.id, title: prev.title, kind: "removed", fields: [] });
	}
	for (const path of failed) out.push(...touchedEntries(state, path, byPath.get(path) ?? []));
	return { changes: out.sort(planOrder), exact: failed.size === 0 && gone.length === 0 };
}

function changedFields(a: BoardEntry, b: BoardEntry): string[] {
	const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
	const out = [...keys].filter((k) => (a.fields[k] ?? "") !== (b.fields[k] ?? ""));
	if (a.title !== b.title) out.push("title");
	if (a.body !== b.body) out.push("body");
	return out;
}

/** Approximate: entries of the current file whose lines appear on the new side of this turn's diffs. */
function touchedEntries(state: BoardState, path: string, changes: ChangeEvent[]): PlanChange[] {
	const entries = state.board.entries.filter((e) => e.file === path).sort((a, b) => a.line - b.line);
	const ids = new Set<string>();
	for (const c of changes) {
		for (const l of parseDiff(c.diff).lines) {
			if (l.kind !== "add" || l.newNo === undefined) continue;
			const owner = entries.filter((e) => e.line <= (l.newNo as number)).pop();
			if (owner) ids.add(owner.id);
		}
	}
	return entries.filter((e) => ids.has(e.id)).map((e) => ({ id: e.id, title: e.title, kind: "touched" as const, fields: [], entry: e }));
}

const KIND_RANK: Record<PlanChangeKind, number> = { new: 0, status: 1, edit: 2, touched: 3, removed: 4 };
const PREFIX_RANK: Record<string, number> = { C: 0, T: 1, D: 2 };

function planOrder(a: PlanChange, b: PlanChange): number {
	const pa = PREFIX_RANK[a.id.replace(/\d+$/, "")] ?? 3;
	const pb = PREFIX_RANK[b.id.replace(/\d+$/, "")] ?? 3;
	return pa - pb || KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.id.localeCompare(b.id, undefined, { numeric: true });
}

function fileChanges(changes: ChangeEvent[]): FileChange[] {
	const map = new Map<string, FileChange>();
	for (const c of changes) {
		let f = map.get(c.path);
		if (!f) {
			f = { path: c.path, added: 0, removed: 0, created: Boolean(c.created), actors: [], changes: [] };
			map.set(c.path, f);
		}
		f.added += c.added;
		f.removed += c.removed;
		f.changes.push(c);
		if (!f.actors.includes(c.actor)) f.actors.push(c.actor);
	}
	// Most recently touched file first.
	return [...map.values()].sort((a, b) => b.changes[b.changes.length - 1].time.localeCompare(a.changes[a.changes.length - 1].time));
}

// ---- rendering ----

const ID_COLOR: Record<string, Paint> = { T: style.cyan, D: style.magenta, C: style.red };

function idLabel(id: string): string {
	const paint = ID_COLOR[id.replace(/\d+$/, "")] ?? style.green;
	return style.bold(paint(id.padEnd(4)));
}

function statusWord(s: string | undefined): string {
	if (!s) return "";
	if (s === "done" || s === "resolved") return style.green(s);
	if (s === "doing") return style.brightCyan(s);
	if (s === "waiting" || s === "open") return style.brightYellow(s);
	if (s === "dropped" || s === "superseded") return style.gray(s);
	return s;
}

/** Marker + id + title on the left, what happened on the right. */
function planLine(p: PlanChange, cols: number): string {
	const mark: Record<PlanChangeKind, string> = {
		new: style.green("+"),
		status: style.yellow("~"),
		edit: style.yellow("~"),
		touched: style.gray("≈"),
		removed: style.red("−"),
	};
	let what = "";
	if (p.kind === "new") what = `${style.green("new")} ${statusWord(p.to)}`;
	else if (p.kind === "status") what = `${statusWord(p.from)} ${style.gray("→")} ${statusWord(p.to)}`;
	else if (p.kind === "edit") what = style.gray(`edited ${p.fields.join(", ")}`);
	else if (p.kind === "touched") what = style.gray("edited");
	else what = style.red("removed");
	if (p.kind === "status" && p.fields.length) what += style.gray(` · ${p.fields.join(", ")}`);
	return spread(`${mark[p.kind]} ${idLabel(p.id)} ${p.kind === "removed" ? style.dim(p.title) : p.title}`, `${what} `, cols);
}

function fileHead(f: FileChange, cols: number): string {
	const icon = f.created ? style.green("+") : style.cyan("✎");
	const count = f.changes.length > 1 ? style.gray(` ×${f.changes.length}`) : "";
	const stats = `${style.green(`+${f.added}`)} ${style.red(`−${f.removed}`)}${count}`;
	const actors = f.actors.filter((a) => a !== "lead").map((a) => (a.startsWith("team:") ? style.blue(a) : style.magenta(a))).join(" ");
	const slash = f.path.lastIndexOf("/");
	const path = `${style.gray(f.path.slice(0, slash + 1))}${style.bold(f.path.slice(slash + 1))}`;
	return spread(`${icon} ${path}  ${stats}`, actors ? `${actors} ` : "", cols);
}

function clock(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function title(t: TurnSummary): string {
	const counts: string[] = [];
	if (t.files.length) counts.push(`${t.files.length} file${t.files.length === 1 ? "" : "s"}`);
	if (t.plan.length) counts.push(`${t.plan.length} plan`);
	return `THIS TURN #${t.turn} · ${clock(t.time)} · ${counts.join(" · ")}`;
}

const BORDER: Paint = style.brightCyan;

/** Boxed summary pinned in the header; at most `maxLines` lines including both borders. */
export function turnBox(t: TurnSummary, cols: number, maxLines: number): string[] {
	const inner = cols - 4;
	const body: string[] = [];
	if (t.info?.prompt) body.push(style.italic(truncate(`“${t.info.prompt}”`, inner)));
	for (const p of t.plan) body.push(planLine(p, inner));
	for (const f of t.files) {
		body.push(fileHead(f, inner));
		const last = f.changes[f.changes.length - 1].message;
		const more = f.changes.length > 1 ? style.gray(` (+${f.changes.length - 1} more)`) : "";
		body.push(`  ${truncate(inline(last, DEFAULT_PREFIXES), inner - 2 - width(more))}${more}`);
	}
	if (!t.exact) body.push(style.gray("≈ some plan edits could not be replayed; entries marked ≈ are approximate"));

	const room = Math.max(1, maxLines - 2);
	const shown = body.length > room ? [...body.slice(0, room - 1), style.gray(`… ${body.length - room + 1} more · t shows all`)] : body;
	const head = ` ${style.bold(title(t))} `;
	const top = BORDER("╭─") + head + BORDER(`${"─".repeat(Math.max(1, cols - 3 - width(head)))}╮`);
	const hint = style.gray(" t full view · T in Changes ");
	const bottom = BORDER("╰─") + hint + BORDER(`${"─".repeat(Math.max(1, cols - 3 - width(hint)))}╯`);
	return [
		truncate(top, cols),
		...shown.map((l) => `${BORDER("│")} ${spread(l, "", inner)} ${BORDER("│")}`),
		truncate(bottom, cols),
	];
}

/** Rows of the full "this turn" view: every plan change and every file with all its messages. */
export function turnRows(t: TurnSummary, sections: SectionSchema[], cols: number, expanded: Set<string>): Row[] {
	const rows: Row[] = [];
	const header = (key: string, text: string, count: number) =>
		rows.push({ key: `hdr:${key}`, selectable: false, lines: ["", style.bold(BORDER(`── ${text} ${style.dim(String(count))} ${"─".repeat(Math.max(2, cols - width(text) - 8))}`))] });

	rows.push({
		key: "turn:title",
		selectable: false,
		lines: [style.bold(BORDER(` ${title(t)}`)), ...(t.info?.prompt ? wrap(`“${t.info.prompt}”`, cols - 2).map((l) => ` ${style.italic(l)}`) : [])],
	});

	if (t.plan.length) {
		header("plan", "PLAN", t.plan.length);
		for (const p of t.plan) {
			const key = `turnplan:${p.id}`;
			const detail = p.entry?.fields.next ?? p.entry?.fields.result ?? p.entry?.fields.reason;
			rows.push({
				key,
				selectable: Boolean(p.entry),
				item: p.entry ? { kind: "entry", entry: p.entry } : undefined,
				lines: [` ${planLine(p, cols - 1)}`, ...(detail ? [`      ${truncate(inline(detail, DEFAULT_PREFIXES), cols - 7)}`] : [])],
				expanded: p.entry && expanded.has(key) ? entryCard(p.entry, sections, cols) : undefined,
			});
		}
	}

	if (t.files.length) {
		header("files", "FILES", t.files.length);
		for (const f of t.files) {
			const key = `turnfile:${f.path}`;
			const messages = f.changes.flatMap((c) => {
				const prefix = `${style.gray(clock(c.time))} `;
				return richWrap(c.message, cols - 10, DEFAULT_PREFIXES).map((l, i) => `    ${i === 0 ? prefix : "      "}${l}`);
			});
			rows.push({
				key,
				selectable: true,
				item: { kind: "file", file: f },
				lines: [` ${fileHead(f, cols - 1)}`, ...messages],
				expanded: expanded.has(key)
					? f.changes.flatMap((c) => ["", `    ${style.gray(`${clock(c.time)} · ${c.message}`)}`, ...renderDiff(c.diff, cols, 4, c.truncated)])
					: undefined,
			});
		}
	}
	if (!t.exact) rows.push({ key: "turn:approx", selectable: false, lines: ["", style.gray("   ≈ some plan edits could not be replayed; entries marked ≈ are approximate")] });
	return rows;
}
