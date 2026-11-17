// Builds the rows of the Plan and Changes pages. A row is one selectable item (or a
// non-selectable header) rendered as one or more terminal lines.

import { canonicalId } from "../shared/parse.ts";
import type { BoardEntry, ChangeEvent, SectionSchema } from "../shared/types.ts";
import type { BoardState, ChangeLog, TurnGroup } from "./data.ts";
import { renderDiff } from "./diff.ts";
import { DEFAULT_PREFIXES, idColor, inline, renderMarkdown, richWrap } from "./rich.ts";
import type { FileChange } from "./turn.ts";
import { type Paint, spread, style, truncate, width } from "./term.ts";

export type RowItem =
	| { kind: "entry"; entry: BoardEntry }
	| { kind: "change"; change: ChangeEvent }
	| { kind: "file"; file: FileChange };

export interface Row {
	/** Stable across reloads; used for cursor, expansion and marks. */
	key: string;
	selectable: boolean;
	item?: RowItem;
	/** Lines when collapsed / expanded. Width already fitted to the content area. */
	lines: string[];
	expanded?: string[];
}

export interface ViewOptions {
	cols: number;
	showClosed: boolean;
	expanded: Set<string>;
}

// ---- shared pieces ----

const ID_PAINT: Record<string, Paint> = {
	task: (s) => style.bold(style.cyan(s)),
	decision: (s) => style.bold(style.magenta(s)),
	conflict: (s) => style.bold(style.red(s)),
	custom: (s) => style.bold(style.green(s)),
};

function sectionOf(sections: SectionSchema[], e: BoardEntry): SectionSchema | undefined {
	return sections.find((s) => s.prefix === e.prefix);
}

function owner(value: string | undefined): string {
	if (!value) return "";
	if (value === "user") return style.bold(style.brightYellow("@you"));
	if (value === "ai") return style.gray("@ai");
	return style.blue(`@${value}`);
}

function priority(value: string | undefined): string {
	if (value === "high") return style.bold(style.brightRed("high"));
	if (value === "medium") return style.yellow("med");
	if (value === "low") return style.gray("low");
	return "";
}

const STATUS_GLYPH: Record<string, string> = {
	todo: style.gray("○"),
	doing: style.brightCyan("▶"),
	waiting: style.brightYellow("?"),
	paused: style.gray("‖"),
	done: style.green("✓"),
	dropped: style.gray("✗"),
	active: style.magenta("◇"),
	superseded: style.gray("◇"),
	open: style.brightRed("◆"),
	resolved: style.green("◆"),
};

function glyph(e: BoardEntry): string {
	return STATUS_GLYPH[e.status] ?? (e.closed ? style.gray("•") : style.green("•"));
}

/** Header line of a section: `── TITLE 3 ───────`. */
function sectionHeader(title: string, count: number, paint: Paint, cols: number): string {
	const label = ` ${title} ${style.dim(String(count))} `;
	const rest = Math.max(2, cols - width(label) - 2);
	return paint(`──${style.bold(label)}${"─".repeat(rest)}`);
}

function refText(e: BoardEntry, field: string): string {
	return e.refs
		.filter((r) => r.field === field)
		.map((r) => (r.kind === "entry" ? (r.id ?? "") : (r.text ?? r.target ?? "")))
		.join(", ");
}

/** Short fields shown as one line of chips at the top of an expanded entry. */
const CHIP_FIELDS = new Set(["status", "priority", "owner", "date", "by"]);
/** Prose fields, in display order; unknown fields follow. */
const TEXT_FIELDS = ["next", "result", "reason", "rejected"];
/** Fields holding references, rendered with coloured ids and underlined links. */
const REF_FIELDS = ["between", "supersedes", "superseded-by", "resolved-by", "affects", "refs", "branch", "commits"];

const PRIORITY_CHIP: Record<string, string> = {
	high: style.bold(style.brightRed("▲ high")),
	medium: style.yellow("■ medium"),
	low: style.gray("▽ low"),
};

function chips(e: BoardEntry): string {
	const f = e.fields;
	const out: string[] = [`${glyph(e)} ${statusPaint(e.status)(e.status)}`];
	if (f.priority) out.push(PRIORITY_CHIP[f.priority] ?? f.priority);
	if (f.owner) out.push(owner(f.owner));
	if (f.date) out.push(style.gray(f.date));
	if (f.by) out.push(style.gray(`by ${f.by === "user" ? "you" : f.by}`));
	return out.join("   ");
}

function statusPaint(status: string): Paint {
	if (status === "done" || status === "resolved") return style.green;
	if (status === "doing") return (s) => style.bold(style.brightCyan(s));
	if (status === "waiting" || status === "open") return (s) => style.bold(style.brightYellow(s));
	if (status === "active") return style.magenta;
	if (status === "dropped" || status === "superseded" || status === "paused") return style.gray;
	return (s) => s;
}

/**
 * Expanded entry as a card: a left rule in the entry's colour, a chip line (status, priority,
 * owner, date), labelled prose fields, labelled reference fields with coloured ids, then the
 * body rendered as light Markdown, and the source location right-aligned at the bottom.
 */
export function entryCard(e: BoardEntry, sections: SectionSchema[], cols: number): string[] {
	const accent = idColor(e.prefix);
	const prefixes = new Set(sections.map((s) => s.prefix));
	const rule = accent("┃");
	const inner = Math.max(20, cols - 8);
	const out: string[] = [];
	const line = (s = "") => out.push(`   ${rule} ${s}`);

	line(chips(e));

	const rest = Object.keys(e.fields).filter((k) => !CHIP_FIELDS.has(k));
	const text = [...TEXT_FIELDS.filter((k) => rest.includes(k)), ...rest.filter((k) => !TEXT_FIELDS.includes(k) && !REF_FIELDS.includes(k))];
	const refs = REF_FIELDS.filter((k) => rest.includes(k));
	const labelW = Math.min(Math.floor(inner / 3), Math.max(6, ...[...text, ...refs].map((k) => k.length)) + 2);
	const labelled = (k: string, value: string, paintLabel: Paint) => {
		const valueLines = richWrap(k === "between" ? value.split(/\s*,\s*/).join("  ↔  ") : value, inner - labelW, prefixes);
		valueLines.forEach((v, i) => line(`${i === 0 ? paintLabel(k.padEnd(labelW)) : " ".repeat(labelW)}${v}`));
	};
	if (text.length) {
		line();
		for (const k of text) labelled(k, e.fields[k], (s) => style.bold(style.gray(s)));
	}
	if (refs.length) {
		line();
		for (const k of refs) labelled(k, e.fields[k], style.gray);
	}
	if (e.body) {
		line();
		for (const l of renderMarkdown(e.body, inner, prefixes, accent)) line(l);
	}
	const loc = style.gray(`${e.file.replace(/^docs\/board\//, "")}:${e.line} · o opens it`);
	out.push(`   ${accent("┗")}${spread("", loc, cols - 4)}`);
	out.push("");
	return out;
}

// ---- Plan tabs ----

function entryRow(e: BoardEntry, sections: SectionSchema[], cols: number, expanded: Set<string>): Row {
	const sec = sectionOf(sections, e);
	const kind = sec?.kind ?? "custom";
	const idPaint = ID_PAINT[kind] ?? ID_PAINT.custom;
	const titlePaint: Paint = e.closed ? style.dim : (s) => s;
	const left = ` ${glyph(e)} ${idPaint(e.id.padEnd(4))} ${titlePaint(e.title)}`;

	let right = "";
	let detail = "";
	const f = e.fields;
	const prefixes = new Set(sections.map((s) => s.prefix));
	if (kind === "task") {
		right = [priority(f.priority), owner(f.owner)].filter(Boolean).join(" ");
		if (e.status === "done" && f.result) detail = `${style.green("result ›")} ${inline(f.result, prefixes)}`;
		else if (e.status === "dropped") detail = style.gray("dropped");
		else if (f.next) detail = `${style.gray("next ›")} ${inline(f.next, prefixes)}`;
	} else if (kind === "decision") {
		right = style.gray([f.date, f.by === "user" ? "you" : f.by].filter(Boolean).join(" · "));
		const parts: string[] = [];
		if (e.status === "superseded") parts.push(style.yellow(`replaced by ${refText(e, "superseded-by")}`));
		const sup = refText(e, "supersedes");
		if (sup) parts.push(style.magenta(`replaces ${sup}`));
		if (f.reason) parts.push(style.gray(f.reason));
		detail = parts.join(style.gray(" · "));
	} else if (kind === "conflict") {
		right = owner(f.owner);
		const between = e.refs.filter((r) => r.field === "between").map((r) => (r.kind === "entry" ? r.id : r.text ?? r.target));
		detail = e.status === "resolved"
			? `${style.green("resolved by")} ${refText(e, "resolved-by")}`
			: `${style.gray("between ›")} ${between.join(style.red(" ↔ "))}`;
	} else {
		right = style.gray(e.status);
		const extra = sec?.required.map((k) => f[k]).filter(Boolean)[0];
		if (extra) detail = style.gray(extra);
	}

	const lines = [spread(left, right ? `${right} ` : "", cols)];
	if (detail) lines.push(`      ${truncate(detail, cols - 7)}`);
	const key = `entry:${e.id}`;
	return {
		key,
		selectable: true,
		item: { kind: "entry", entry: e },
		lines,
		expanded: expanded.has(key) ? entryCard(e, sections, cols) : undefined,
	};
}

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

function byPriority(a: BoardEntry, b: BoardEntry): number {
	return (PRIORITY_RANK[a.fields.priority] ?? 3) - (PRIORITY_RANK[b.fields.priority] ?? 3) || a.num - b.num;
}

/** `turn` is the full "this turn" view; it has no tab of its own (opened with `t`). */
export type TabId = "conflicts" | "waiting" | "doing" | "todo" | "decisions" | "changes" | "turn" | `custom:${string}`;

export interface TabSpec {
	id: TabId;
	label: string;
	paint: Paint;
	/** Open items in this category (Changes: recorded code changes). */
	count: number;
}

/** Open and closed entries per plan tab; the single place that decides which entry belongs where. */
function partition(state: BoardState, id: TabId): { open: BoardEntry[]; closed: BoardEntry[] } {
	const { board } = state;
	const kindOf = (e: BoardEntry) => sectionOf(board.sections, e)?.kind;
	const of = (kind: string) => board.entries.filter((e) => kindOf(e) === kind);
	const tasks = of("task");
	const waitsOnUser = (e: BoardEntry) => e.fields.owner === "user" || e.status === "waiting";
	switch (id) {
		case "conflicts": {
			const all = of("conflict");
			return { open: all.filter((e) => !e.closed).sort((a, b) => a.num - b.num), closed: all.filter((e) => e.closed).sort((a, b) => b.num - a.num) };
		}
		case "waiting":
			return { open: tasks.filter((e) => !e.closed && waitsOnUser(e)).sort(byPriority), closed: [] };
		case "doing":
			return { open: tasks.filter((e) => e.status === "doing" && !waitsOnUser(e)).sort(byPriority), closed: [] };
		case "todo":
			return {
				open: tasks
					.filter((e) => (e.status === "todo" || e.status === "paused") && !waitsOnUser(e))
					.sort((a, b) => Number(a.status === "paused") - Number(b.status === "paused") || byPriority(a, b)),
				closed: tasks.filter((e) => e.closed).sort((a, b) => b.num - a.num),
			};
		case "decisions": {
			const all = of("decision").sort((a, b) => (b.fields.date ?? "").localeCompare(a.fields.date ?? "") || b.num - a.num);
			return { open: all.filter((e) => !e.closed), closed: all.filter((e) => e.closed) };
		}
		default: {
			const prefix = id.slice("custom:".length);
			const all = board.entries.filter((e) => e.prefix === prefix).sort((a, b) => b.num - a.num);
			return { open: all.filter((e) => !e.closed), closed: all.filter((e) => e.closed) };
		}
	}
}

export function planTabs(state: BoardState): TabSpec[] {
	const count = (id: TabId) => partition(state, id).open.length;
	const tabs: TabSpec[] = [
		{ id: "conflicts", label: "Conflicts", paint: style.brightRed, count: count("conflicts") },
		{ id: "waiting", label: "Waiting on you", paint: style.brightYellow, count: count("waiting") },
		{ id: "doing", label: "Doing", paint: style.brightCyan, count: count("doing") },
		{ id: "todo", label: "Todo", paint: (s) => s, count: count("todo") },
		{ id: "decisions", label: "Decisions", paint: style.magenta, count: count("decisions") },
	];
	for (const sec of state.board.sections.filter((s) => s.kind === "custom")) {
		const id: TabId = `custom:${sec.prefix}`;
		tabs.push({ id, label: sec.title, paint: style.green, count: count(id) });
	}
	return tabs;
}

const EMPTY_TEXT: Record<string, string> = {
	conflicts: "no open conflicts",
	waiting: "nothing is waiting on you",
	doing: "nothing in progress",
	todo: "no open tasks",
	decisions: "no active decisions",
};

const CLOSED_TITLE: Record<string, string> = {
	conflicts: "RESOLVED",
	todo: "DONE & DROPPED",
	decisions: "SUPERSEDED",
};

/** Rows of one plan tab. Closed entries follow under their own divider when `showClosed` is on. */
export function planTabRows(state: BoardState, id: TabId, opt: ViewOptions): Row[] {
	const { open, closed } = partition(state, id);
	const rows: Row[] = open.map((e) => entryRow(e, state.board.sections, opt.cols, opt.expanded));
	if (open.length === 0) {
		rows.push({ key: `empty:${id}`, selectable: false, lines: ["", style.gray(`   ${EMPTY_TEXT[id] ?? "no open entries"}`)] });
	}
	if (closed.length > 0) {
		if (opt.showClosed) {
			rows.push({ key: `hdr:closed:${id}`, selectable: false, lines: ["", sectionHeader(CLOSED_TITLE[id] ?? "CLOSED", closed.length, style.gray, opt.cols)] });
			for (const e of closed) rows.push(entryRow(e, state.board.sections, opt.cols, opt.expanded));
		} else {
			rows.push({ key: `more:${id}`, selectable: false, lines: ["", style.gray(`   ${closed.length} closed · h shows them`)] });
		}
	}
	return rows;
}

/** Format issues pinned under the tab bar on every tab; at most `max` lines including the overflow note. */
export function issueLines(state: BoardState, cols: number, max: number): string[] {
	const n = state.issues.length;
	if (n === 0) return [];
	const head = `${style.bold(style.brightRed(` ✕ ${n} FORMAT ISSUE${n === 1 ? "" : "S"}`))} ${style.gray("· x quotes them into pi")}`;
	const lines = [truncate(head, cols)];
	const room = Math.max(1, max - 1 - (n > max - 1 ? 1 : 0));
	for (const issue of state.issues.slice(0, room)) {
		const loc = style.gray(`${issue.file.replace(/^docs\/board\//, "")}:${issue.line}`);
		const id = issue.id ? `${style.bold(issue.id)} ` : "";
		lines.push(truncate(`   ${loc} ${id}${style.red(issue.message)}`, cols));
	}
	if (n > room) lines.push(style.gray(`   … ${n - room} more`));
	return lines;
}

export function issueQuote(state: BoardState): string {
	return state.issues.map((i) => `〔格式问题 ${i.file}:${i.line}${i.id ? ` ${i.id}` : ""}：${i.message}〕`).join("\n");
}

// ---- Changes page ----

function clock(iso: string, withDate: boolean): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	if (!withDate) return hm;
	return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

function isToday(iso: string): boolean {
	return new Date(iso).toDateString() === new Date().toDateString();
}

/** Directory in grey, file name bold; long paths lose leading directories first. */
function pathLabel(path: string, max: number): string {
	let p = path;
	while (width(p) > max && p.includes("/")) p = p.slice(p.indexOf("/") + 1);
	const prefix = p === path ? "" : "…/";
	const slash = p.lastIndexOf("/");
	const dir = slash >= 0 ? p.slice(0, slash + 1) : "";
	const base = slash >= 0 ? p.slice(slash + 1) : p;
	return truncate(style.gray(prefix + dir) + style.bold(base), max);
}

function actorLabel(actor: string): string {
	if (actor === "lead") return style.gray("lead");
	if (actor.startsWith("team:")) return style.blue(actor);
	return style.magenta(actor);
}

function changeRow(c: ChangeEvent, log: ChangeLog, cols: number, expanded: Set<string>): Row {
	const icon = c.created ? style.green("+") : c.tool === "write" ? style.yellow("●") : style.cyan("✎");
	const stats = `${style.green(`+${c.added}`)} ${style.red(`−${c.removed}`)}`;
	const right = `${actorLabel(c.actor)} ${style.gray(clock(c.time, false))} `;
	const pathMax = Math.max(12, cols - width(stats) - width(right) - 6);
	const line1 = spread(`  ${icon} ${pathLabel(c.path, pathMax)}  ${stats}`, right, cols);

	const tags: string[] = [];
	if (c.task) tags.push(style.cyan(c.task));
	if (c.category === "plan") tags.push(style.gray("plan"));
	if (log.isUnmerged(c)) tags.push(style.yellow("unmerged"));
	else if (c.memberId) tags.push(style.gray("merged"));
	const tagText = tags.length ? ` ${tags.join(" ")}` : "";
	const msgCols = cols - 5 - width(tagText);
	const msgLines = richWrap(c.message, Math.max(10, msgCols), DEFAULT_PREFIXES);
	const lines = [line1, ...msgLines.slice(0, 2).map((l, i) => `    ${l}${i === 0 ? tagText : ""}`)];
	if (msgLines.length > 2) lines[2] = truncate(`${lines[2]}…`, cols);

	const key = `change:${c.id}`;
	return {
		key,
		selectable: true,
		item: { kind: "change", change: c },
		lines,
		expanded: expanded.has(key) ? ["", ...renderDiff(c.diff, cols, 4, c.truncated), ""] : undefined,
	};
}

function groupHeader(g: TurnGroup, currentSession: string, cols: number): string[] {
	const when = clock(g.time, !isToday(g.time));
	const earlier = g.leadSession !== currentSession ? style.gray(" · earlier session") : "";
	const count = style.gray(`${g.changes.length} change${g.changes.length === 1 ? "" : "s"} `);
	const title = `${style.bold(style.brightCyan(`#${g.turn}`))} ${style.gray(when)}${earlier}`;
	const prompt = g.info?.prompt ? `   ${style.italic(`“${g.info.prompt}”`)}` : "";
	return ["", style.gray("─".repeat(cols)), spread(` ${title}`, count, cols), ...(prompt ? [truncate(prompt, cols)] : [])];
}

export interface ChangesFilter {
	showPlan: boolean;
	task?: string;
}

export function changeRows(log: ChangeLog, currentSession: string, filter: ChangesFilter, opt: ViewOptions): Row[] {
	const want = filter.task ? canonicalId(filter.task) : undefined;
	const groups = log.groups(
		(c) => (filter.showPlan || c.category !== "plan") && (!want || (c.task !== undefined && canonicalId(c.task) === want)),
	);
	const rows: Row[] = [];
	if (filter.task) {
		rows.push({ key: "filter", selectable: false, lines: [` ${style.cyan(`filter: ${filter.task}`)} ${style.gray("· f clears")}`] });
	}
	for (const g of groups) {
		rows.push({ key: `turn:${g.key}`, selectable: false, lines: groupHeader(g, currentSession, opt.cols) });
		for (const c of g.changes) rows.push(changeRow(c, log, opt.cols, opt.expanded));
	}
	if (groups.length === 0) {
		rows.push({ key: "empty:changes", selectable: false, lines: ["", style.gray(filter.task ? `   no changes tagged ${filter.task}` : "   no changes recorded yet")] });
	}
	return rows;
}

/** Recorded code changes (plan edits excluded); the count shown on the Changes tab. */
export function changeCount(log: ChangeLog): number {
	return log.changes.filter((c) => c.category !== "plan").length;
}

