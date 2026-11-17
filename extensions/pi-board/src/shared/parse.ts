// Plan-document parser and validator shared by the pi extension and the board pane.
// Spec: ../../DESIGN.md §3 (format) and §4.2 (rules).
// Must stay free of node imports and of non-erasable TypeScript syntax (enums, parameter properties):
// the pane runs it directly with `node` type stripping.

import type {
	Board,
	BoardEntry,
	BoardFile,
	BoardIssue,
	EntryRef,
	SectionSchema,
	ValidationContext,
} from "./types.ts";

export const BOARD_DIR = "docs/board";

export const BUILTIN_SECTIONS: SectionSchema[] = [
	{
		kind: "task",
		file: `${BOARD_DIR}/tasks.md`,
		title: "Tasks",
		prefix: "T",
		statuses: ["todo", "doing", "waiting", "paused", "done", "dropped"],
		closed: ["done", "dropped"],
		required: ["priority", "owner"],
	},
	{
		kind: "decision",
		file: `${BOARD_DIR}/decisions.md`,
		title: "Decisions",
		prefix: "D",
		statuses: ["active", "superseded"],
		closed: ["superseded"],
		required: ["date", "by", "reason"],
	},
	{
		kind: "conflict",
		file: `${BOARD_DIR}/conflicts.md`,
		title: "Conflicts",
		prefix: "C",
		statuses: ["open", "resolved"],
		closed: ["resolved"],
		required: ["between", "owner"],
	},
];

const KNOWN_FIELDS: Record<string, string[]> = {
	task: ["status", "priority", "owner", "next", "refs", "branch", "commits", "result"],
	decision: ["status", "date", "by", "rejected", "reason", "supersedes", "superseded-by", "affects"],
	conflict: ["status", "between", "owner", "resolved-by"],
};

/** Fields whose value is a list of entry ids and/or document links (DESIGN §3.4). */
const REF_FIELDS = ["refs", "between", "affects", "supersedes", "superseded-by", "resolved-by"];
/** Reference fields that accept D ids only. */
const DECISION_ID_FIELDS = ["supersedes", "superseded-by", "resolved-by"];

const PRIORITIES = ["high", "medium", "low"];
const FIELD_RE = /^- ([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/;

// ---------------------------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------------------------

/** GitHub-style heading anchor, without the leading '#'. */
export function slugAnchor(heading: string): string {
	let s = heading.trim();
	s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
	s = s.replace(/<[^>]+>/g, "");
	s = s.replace(/[`*~]/g, "");
	s = s.toLowerCase();
	s = s.replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "");
	return s.replace(/ /g, "-");
}

/** All GitHub-style anchors of a Markdown document (ATX headings only; duplicates get -1, -2, ...). */
export function markdownAnchors(content: string): Set<string> {
	const anchors = new Set<string>();
	const seen = new Map<string, number>();
	const fence = new FenceTracker();
	for (const line of splitLines(content)) {
		if (fence.consume(line)) continue;
		const m = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
		if (!m) continue;
		const base = slugAnchor(m[1]);
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		anchors.add(n === 0 ? base : `${base}-${n}`);
	}
	return anchors;
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

export function parseBoard(files: BoardFile[]): Board {
	const issues: BoardIssue[] = [];
	const sections: SectionSchema[] = BUILTIN_SECTIONS.map((s) => ({
		...s,
		statuses: [...s.statuses],
		closed: [...s.closed],
		required: [...s.required],
	}));
	const entries: BoardEntry[] = [];

	const mdFiles = files.filter((f) => f.path.endsWith(".md")).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	for (const file of mdFiles) {
		const lines = splitLines(file.content);
		const builtin = sections.find((s) => s.kind !== "custom" && s.file === file.path);
		if (builtin) {
			const from = frontmatterEnd(lines);
			parseEntries(file.path, lines, from, builtin, entries, issues);
			continue;
		}

		const fm = parseFrontmatter(lines);
		if (!fm) {
			issues.push({
				file: file.path,
				line: 0,
				rule: "frontmatter",
				message:
					"File has no frontmatter; start it with a `---` block declaring section, prefix, status, closed and fields (see the pi-board skill), or move its content into tasks.md, decisions.md or conflicts.md.",
			});
			continue;
		}
		const schema = customSchema(file.path, fm, sections, issues);
		if (!schema) continue;
		sections.push(schema);
		parseEntries(file.path, lines, fm.end, schema, entries, issues);
	}

	// Ids are identified by (prefix, num): T5 and T05 are the same entry. byId holds each entry under its written id and
	// its canonical id; look references up with canonicalId().
	const byId = new Map<string, BoardEntry>();
	for (const e of entries) {
		const first = byId.get(canonicalId(e.id));
		if (!first) {
			byId.set(canonicalId(e.id), e);
			byId.set(e.id, e);
			continue;
		}
		issues.push({
			file: e.file,
			line: e.line,
			id: e.id,
			rule: "dup-id",
			message: `${e.id} is already defined as ${first.id} in ${first.file} (T5 and T05 count as the same number); give this entry a number above the highest existing ${e.prefix} number and never reuse numbers.`,
		});
	}

	return { sections, entries, byId, issues };
}

/** "T05" -> "T5": prefix plus the number without leading zeros. */
export function canonicalId(id: string): string {
	const m = /^([A-Za-z]+)(\d+)$/.exec(id);
	return m ? `${m[1]}${parseInt(m[2], 10)}` : id;
}

function splitLines(content: string): string[] {
	return content.split(/\r?\n/);
}

/** Tracks fenced code blocks so `## ` inside them is not read as a heading. */
class FenceTracker {
	marker: string | undefined;

	/** Returns true when the line is a fence delimiter or inside a fence. */
	consume(line: string): boolean {
		const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (this.marker === undefined) {
			if (!m) return false;
			if (m[1][0] === "`" && m[2].includes("`")) return false;
			this.marker = m[1];
			return true;
		}
		if (m && m[1][0] === this.marker[0] && m[1].length >= this.marker.length && m[2].trim() === "") {
			this.marker = undefined;
		}
		return true;
	}
}

interface Frontmatter {
	data: Map<string, { value: string | string[]; line: number }>;
	/** Index of the first line after the closing `---`. */
	end: number;
}

/** Line index after a leading frontmatter block, or 0 when there is none. */
function frontmatterEnd(lines: string[]): number {
	return parseFrontmatter(lines)?.end ?? 0;
}

/** Minimal frontmatter reader: `key: value`, `key: [a, b]` and `key:` followed by `- item` lines. */
function parseFrontmatter(lines: string[]): Frontmatter | undefined {
	// A lone `---` (thematic break) is not frontmatter: the next line must be a `key:` line.
	if (lines.length < 2 || lines[0].trim() !== "---" || !/^[A-Za-z][A-Za-z0-9_-]*:/.test(lines[1])) return undefined;
	let close = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			close = i;
			break;
		}
	}
	if (close < 0) return undefined;

	const data = new Map<string, { value: string | string[]; line: number }>();
	for (let i = 1; i < close; i++) {
		const m = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(lines[i]);
		if (!m) continue;
		const key = m[1].toLowerCase();
		const raw = m[2].trim();
		if (raw === "") {
			const items: string[] = [];
			while (i + 1 < close && /^\s*-\s+/.test(lines[i + 1])) {
				items.push(unquote(lines[i + 1].replace(/^\s*-\s+/, "").trim()));
				i++;
			}
			data.set(key, { value: items.length > 0 ? items : "", line: i + 1 });
			continue;
		}
		if (raw.startsWith("[") && raw.endsWith("]")) {
			const inner = raw.slice(1, -1).trim();
			const items = inner === "" ? [] : inner.split(",").map((s) => unquote(s.trim())).filter((s) => s !== "");
			data.set(key, { value: items, line: i + 1 });
			continue;
		}
		data.set(key, { value: unquote(raw), line: i + 1 });
	}
	return { data, end: close + 1 };
}

function unquote(s: string): string {
	if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) return s.slice(1, -1);
	return s;
}

function customSchema(
	path: string,
	fm: Frontmatter,
	existing: SectionSchema[],
	issues: BoardIssue[],
): SectionSchema | undefined {
	const problems: string[] = [];
	const get = (key: string) => fm.data.get(key);
	const lineOf = (key: string) => get(key)?.line ?? 1;
	const asText = (key: string): string => {
		const v = get(key)?.value;
		return typeof v === "string" ? v.trim() : "";
	};
	const asList = (key: string): string[] | undefined => {
		const v = get(key)?.value;
		return Array.isArray(v) ? v : undefined;
	};
	const bad = (key: string, message: string) => issues.push({ file: path, line: lineOf(key), rule: "frontmatter", message });

	const title = asText("section");
	const prefix = asText("prefix");
	const statuses = asList("status");
	const closed = asList("closed") ?? [];
	const fields = asList("fields") ?? [];

	if (!title) {
		bad("section", "Frontmatter needs `section: <display name>`, e.g. `section: Findings`.");
		problems.push("section");
	}
	if (!/^[A-Z]+$/.test(prefix)) {
		bad("prefix", "Frontmatter `prefix` must be one or more capital letters, e.g. `prefix: F`.");
		problems.push("prefix");
	} else if (existing.some((s) => s.prefix === prefix)) {
		bad("prefix", `Frontmatter prefix ${prefix} is already used by another section; choose an unused capital-letter prefix.`);
		problems.push("prefix");
	}
	if (!statuses || statuses.length === 0) {
		bad("status", "Frontmatter `status` must list the allowed statuses, e.g. `status: [valid, superseded]`.");
		problems.push("status");
	} else if (closed.some((c) => !statuses.includes(c))) {
		bad("closed", "Every `closed` value must also appear in `status`; fix the lists in the frontmatter.");
		problems.push("closed");
	}
	if (!asList("closed") && !get("closed")) {
		bad("closed", "Frontmatter needs `closed: [<statuses that count as closed>]`; use `closed: []` if none.");
		problems.push("closed");
	}
	if (fields.some((f) => !/^[a-z][a-z0-9-]*$/.test(f))) {
		bad("fields", "Every `fields` name must be lowercase English letters, digits or hyphens, e.g. `fields: [date, verdict]`.");
		problems.push("fields");
	}
	if (problems.length > 0) return undefined;

	return {
		kind: "custom",
		file: path,
		title,
		prefix,
		statuses: statuses as string[],
		closed,
		required: fields.filter((f) => f !== "status"),
	};
}

interface Heading {
	index: number;
	text: string;
}

function findHeadings(path: string, lines: string[], from: number, issues: BoardIssue[]): Heading[] {
	const out: Heading[] = [];
	const fence = new FenceTracker();
	for (let i = from; i < lines.length; i++) {
		if (fence.consume(lines[i])) continue;
		const m = /^##(?!#)(?:[ \t]+(.*))?$/.exec(lines[i]);
		if (m) {
			out.push({ index: i, text: (m[1] ?? "").trim() });
		} else if (/^##[^#\s]/.test(lines[i])) {
			issues.push({
				file: path,
				line: i + 1,
				rule: "heading",
				message: `"${lines[i].slice(0, 40)}" looks like a level-2 heading but has no space after ##, so it is not read as an entry; write \`## <id> <title>\` with a space.`,
			});
		}
	}
	return out;
}

function parseEntries(
	path: string,
	lines: string[],
	from: number,
	schema: SectionSchema,
	entries: BoardEntry[],
	issues: BoardIssue[],
): void {
	const headings = findHeadings(path, lines, from, issues);
	const example = `## ${schema.prefix}12 <title>`;

	for (let h = 0; h < headings.length; h++) {
		const start = headings[h].index;
		const end = h + 1 < headings.length ? headings[h + 1].index : lines.length;
		const text = headings[h].text;
		const line = start + 1;

		const m = /^([A-Za-z]+)(\d+)(.*)$/.exec(text);
		if (!m) {
			issues.push({ file: path, line, rule: "heading", message: `Heading "## ${text}" has no id; write it as \`${example}\` (prefix ${schema.prefix} plus a positive integer, a space, then the title).` });
			continue;
		}
		const [, prefix, digits, rest] = m;
		const id = `${prefix}${digits}`;
		if (prefix !== schema.prefix) {
			issues.push({ file: path, line, id, rule: "heading", message: `${id} is in ${path}, whose ids use prefix ${schema.prefix}; rename it to ${schema.prefix}<number> or move it to the file for prefix ${prefix}.` });
			continue;
		}
		if (parseInt(digits, 10) < 1) {
			issues.push({ file: path, line, id, rule: "heading", message: `${id} has number 0; ids use positive integers, e.g. ${prefix}1.` });
			continue;
		}
		if (!/^\s+\S/.test(rest)) {
			issues.push({ file: path, line, id, rule: "heading", message: `Heading of ${id} needs a space and a title after the id; write it as \`## ${id} <title>\` (no colon).` });
			continue;
		}

		const fields: Record<string, string> = {};
		const fieldLines: Record<string, number> = {};
		let i = start + 1;
		for (; i < end; i++) {
			const fm = FIELD_RE.exec(lines[i]);
			if (!fm) break;
			const key = fm[1].toLowerCase();
			if (key !== fm[1]) {
				issues.push({ file: path, line: i + 1, id, rule: "field", message: `${id}: field key "${fm[1]}" must be lowercase; write \`- ${key}: ...\`.` });
			}
			if (key in fields) {
				issues.push({ file: path, line: i + 1, id, rule: "field", message: `${id}: field \`${key}\` appears twice; keep one \`- ${key}:\` line.` });
				continue;
			}
			fields[key] = fm[2].trim();
			fieldLines[key] = i + 1;
		}
		const body = lines.slice(i, end).join("\n").trim();
		const misplaced = body.split("\n").some((l) => FIELD_RE.test(l));

		const status = fields.status ?? "";
		const entry: BoardEntry = {
			id,
			prefix,
			num: parseInt(digits, 10),
			title: rest.trim(),
			file: path,
			line,
			fields,
			fieldLines,
			body,
			status,
			closed: schema.closed.includes(status),
			refs: [],
		};
		checkEntry(entry, schema, misplaced, issues);
		entries.push(entry);
	}
}

function checkEntry(e: BoardEntry, schema: SectionSchema, misplaced: boolean, issues: BoardIssue[]): void {
	const at = (key: string) => e.fieldLines[key] ?? e.line;
	const issue = (key: string | undefined, message: string) =>
		issues.push({ file: e.file, line: key ? at(key) : e.line, id: e.id, rule: key ? `field:${key}` : "field", message: `${e.id}: ${message}` });
	const hint = misplaced ? " (field lines were found after a blank line; they must directly follow the heading with no blank line)" : "";
	const missing = (key: string, why = "") =>
		issue(undefined, `missing required field \`${key}\`${why}; add \`- ${key}: ...\` directly below the heading${hint}.`);
	const has = (key: string) => (e.fields[key] ?? "") !== "";

	// Rule 2: known keys.
	if (schema.kind !== "custom") {
		const known = KNOWN_FIELDS[schema.kind];
		for (const key of Object.keys(e.fields)) {
			if (!known.includes(key)) {
				issue(key, `unknown field \`${key}\`; allowed fields are ${known.join(", ")}. Remove it or put the text in the body.`);
			}
		}
	}

	// Rule 2: status.
	if (!has("status")) {
		missing("status");
	} else if (!schema.statuses.includes(e.status)) {
		issue("status", `status "${e.status}" is not allowed in ${schema.title}; use one of ${schema.statuses.join(", ")}.`);
	}

	// Rule 2: required fields.
	for (const key of schema.required) {
		if (!has(key)) missing(key);
	}

	if (schema.kind === "task") {
		if (has("priority") && !PRIORITIES.includes(e.fields.priority)) {
			issue("priority", `priority "${e.fields.priority}" is invalid; use high, medium or low.`);
		}
		if (has("owner") && !/^[^\s,]+$/.test(e.fields.owner)) {
			issue("owner", `owner "${e.fields.owner}" is invalid; use user, ai or a single team member name.`);
		}
		if (e.status === "waiting" && has("owner") && e.fields.owner !== "user") {
			issue("owner", `status waiting means waiting on the user, so owner must be user (now "${e.fields.owner}"); set \`- owner: user\` or change the status.`);
		}
		if (["todo", "doing", "waiting"].includes(e.status) && !has("next")) {
			missing("next", ` when status is ${e.status}`);
		}
		if (e.status === "done" && !has("result")) {
			missing("result", " when status is done");
		}
	} else if (schema.kind === "decision") {
		if (has("date")) {
			const d = e.fields.date;
			const valid = /^\d{4}-\d{2}-\d{2}$/.test(d) && isRealDate(d);
			if (!valid) issue("date", `date "${d}" is invalid; use a real date as YYYY-MM-DD.`);
		}
		if (has("by") && !["user", "ai"].includes(e.fields.by)) {
			issue("by", `by "${e.fields.by}" is invalid; use user or ai.`);
		}
		if (e.status === "superseded" && !has("superseded-by")) {
			missing("superseded-by", " when status is superseded");
		}
	} else if (schema.kind === "conflict") {
		if (has("owner") && !["user", "ai"].includes(e.fields.owner)) {
			issue("owner", `owner "${e.fields.owner}" is invalid; use user or ai.`);
		}
		if (e.status === "resolved" && !has("resolved-by")) {
			missing("resolved-by", " when status is resolved");
		}
	}

	// References (rules 4 and 7 are checked later by validateBoard()).
	for (const key of REF_FIELDS) {
		if (!has(key)) continue;
		const { refs, problems } = parseRefs(key, e.fields[key], e.file);
		for (const p of problems) {
			issue(key, `${p}; in \`${key}\` use entry ids such as ${key === "between" ? "T12, D26" : "D26"} or links like [text](path.md#anchor), separated by commas.`);
		}
		if (DECISION_ID_FIELDS.includes(key)) {
			for (const r of refs) {
				if (r.kind !== "entry") issue(key, `\`${key}\` takes decision ids such as D26, not links.`);
				else if (!r.id?.startsWith("D")) issue(key, `\`${key}\` must point to decisions (D<number>), but ${r.id} is not one.`);
			}
		}
		e.refs.push(...refs);
	}
	if (schema.kind === "conflict" && has("between")) {
		const n = e.refs.filter((r) => r.field === "between").length;
		if (n < 2) issue("between", "`between` must name two sources of the conflict (entry ids or document links), separated by a comma.");
	}
}

function isRealDate(s: string): boolean {
	const [y, m, d] = s.split("-").map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Splits on commas that are outside `[...]` and `(...)`. */
function splitList(value: string): string[] {
	const out: string[] = [];
	let depthSquare = 0;
	let depthRound = 0;
	let cur = "";
	for (const ch of value) {
		if (ch === "[") depthSquare++;
		else if (ch === "]") depthSquare = Math.max(0, depthSquare - 1);
		else if (ch === "(") depthRound++;
		else if (ch === ")") depthRound = Math.max(0, depthRound - 1);
		if (ch === "," && depthSquare === 0 && depthRound === 0) {
			out.push(cur);
			cur = "";
		} else {
			cur += ch;
		}
	}
	out.push(cur);
	return out.map((s) => s.trim()).filter((s) => s !== "");
}

function parseRefs(field: string, value: string, file: string): { refs: EntryRef[]; problems: string[] } {
	const refs: EntryRef[] = [];
	const problems: string[] = [];
	for (const token of splitList(value)) {
		if (/^[A-Z]+\d+$/.test(token) && parseInt(token.replace(/^[A-Z]+/, ""), 10) >= 1) {
			refs.push({ field, kind: "entry", id: token });
			continue;
		}
		const link = /^\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+[^)]*)?\)$/.exec(token);
		if (link) {
			const [, text, href] = link;
			if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) continue; // external URL: not checked
			const hash = href.indexOf("#");
			const rawPath = hash < 0 ? href : href.slice(0, hash);
			const rawAnchor = hash < 0 ? "" : href.slice(hash + 1);
			const ref: EntryRef = {
				field,
				kind: "link",
				text,
				target: rawPath === "" ? file : resolveRelative(dirnameOf(file), safeDecode(rawPath)),
			};
			if (rawAnchor !== "") ref.anchor = safeDecode(rawAnchor).toLowerCase();
			refs.push(ref);
			continue;
		}
		problems.push(`"${token}" is not a valid reference`);
	}
	return { refs, problems };
}

function safeDecode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

function dirnameOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

function resolveRelative(dir: string, rel: string): string {
	const parts = (rel.startsWith("/") ? rel.slice(1) : dir === "" ? rel : `${dir}/${rel}`).split("/");
	const out: string[] = [];
	for (const p of parts) {
		if (p === "" || p === ".") continue;
		if (p === "..") {
			if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
			else out.push("..");
		} else {
			out.push(p);
		}
	}
	return out.join("/");
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

/**
 * Consistency rules of DESIGN §4.2: 3 (ids may not disappear since git HEAD), 4, 5, 6, 7, 8.
 * Format rules 1, 2 and the duplicate-id half of 3 are reported by parseBoard() in `board.issues`;
 * this function does not repeat them. Use allIssues() for both.
 */
export function validateBoard(board: Board, ctx: ValidationContext): BoardIssue[] {
	const issues: BoardIssue[] = [];
	const idsOf = (e: BoardEntry, field: string): string[] =>
		e.refs.filter((r) => r.field === field && r.kind === "entry").map((r) => r.id as string);
	const fileFor = (prefix: string): string => board.sections.find((s) => s.prefix === prefix)?.file ?? BOARD_DIR;

	// Rule 3: ids present at HEAD may not disappear.
	for (const id of [...ctx.headIds].sort(naturalCompare)) {
		if (board.byId.has(canonicalId(id))) continue;
		const prefix = /^[A-Z]+/.exec(id)?.[0] ?? "";
		issues.push({
			file: fileFor(prefix),
			line: 0,
			id,
			rule: "head-id",
					message: `${id} exists at git HEAD but is gone now; restore its entry and only change its status (e.g. done, dropped, superseded) instead of deleting it.`,
		});
	}

	// Rules 4 and 7: references resolve.
	const anchorCache = new Map<string, Set<string> | undefined>();
	for (const e of board.entries) {
		const reported = new Set<string>();
		for (const ref of e.refs) {
			const line = e.fieldLines[ref.field] ?? e.line;
			if (ref.kind === "entry") {
				if (!board.byId.has(canonicalId(ref.id as string))) {
					const key = `${ref.field}:${ref.id}`;
					if (reported.has(key)) continue;
					reported.add(key);
					issues.push({
						file: e.file,
						line,
						id: e.id,
						rule: "ref",
					message: `${e.id}: \`${ref.field}\` points to ${ref.id}, which does not exist; use an existing id or create ${ref.id} first.`,
					});
				}
				continue;
			}
			const target = ref.target as string;
			if (!ctx.fileExists(target)) {
				issues.push({
					file: e.file,
					line,
					id: e.id,
					rule: "link-file",
					message: `${e.id}: link in \`${ref.field}\` points to missing file ${target}; fix the relative path (it is relative to ${e.file}).`,
				});
				continue;
			}
			if (ref.anchor) {
				if (!anchorCache.has(target)) anchorCache.set(target, ctx.anchorsOf(target));
				const anchors = anchorCache.get(target);
				if (anchors && !anchors.has(ref.anchor)) {
					issues.push({
						file: e.file,
						line,
						id: e.id,
						rule: "link-anchor",
					message: `${e.id}: link in \`${ref.field}\` points to #${ref.anchor}, but ${target} has no such heading; use an existing heading's GitHub-style anchor.`,
					});
				}
			}
		}
	}

	// Rules 5 and 6: decisions agree on supersession; resolved conflicts point at active decisions.
	for (const d of board.entries) {
		if (d.prefix !== "D") continue;
		const line = (field: string) => d.fieldLines[field] ?? d.line;
		const supersedes = idsOf(d, "supersedes");
		const supersededBy = idsOf(d, "superseded-by");

		for (const id of supersedes) {
			const t = board.byId.get(canonicalId(id));
			if (!t || t.prefix !== "D") continue;
			if (t.status !== "superseded") {
				issues.push({
					file: d.file,
					line: line("supersedes"),
					id: d.id,
					rule: "supersede",
					message: `${d.id} supersedes ${id}, but ${id} is "${t.status}"; set \`- status: superseded\` and \`- superseded-by: ${d.id}\` on ${id}.`,
				});
			} else if (!sameIdIn(idsOf(t, "superseded-by"), d.id)) {
				issues.push({
					file: d.file,
					line: line("supersedes"),
					id: d.id,
					rule: "supersede",
					message: `${d.id} supersedes ${id}, but ${id} has no \`superseded-by: ${d.id}\`; add ${d.id} to its \`superseded-by\`.`,
				});
			}
		}
		for (const id of supersededBy) {
			const t = board.byId.get(canonicalId(id));
			if (!t || t.prefix !== "D") continue;
			if (!sameIdIn(idsOf(t, "supersedes"), d.id)) {
				issues.push({
					file: d.file,
					line: line("superseded-by"),
					id: d.id,
					rule: "supersede",
					message: `${d.id} says it is superseded by ${id}, but ${id} does not list it; add \`- supersedes: ${d.id}\` to ${id}.`,
				});
			}
		}
		if (supersededBy.length > 0 && d.status !== "superseded") {
			issues.push({
				file: d.file,
				line: line("superseded-by"),
				id: d.id,
				rule: "supersede",
					message: `${d.id} has \`superseded-by\` but its status is "${d.status}"; set \`- status: superseded\` or remove \`superseded-by\`.`,
			});
		}
	}
	for (const c of board.entries) {
		for (const id of idsOf(c, "resolved-by")) {
			const t = board.byId.get(canonicalId(id));
			if (!t || t.prefix !== "D") continue;
			if (t.status !== "active") {
				issues.push({
					file: c.file,
					line: c.fieldLines["resolved-by"] ?? c.line,
					id: c.id,
					rule: "resolved-by",
					message: `${c.id}: \`resolved-by\` points to ${id}, which is "${t.status}"; point to the currently active decision instead.`,
				});
			}
		}
	}

	// Rule 8: open tasks must not rely on superseded decisions.
	for (const t of board.entries) {
		if (t.prefix !== "T" || t.closed) continue;
		for (const id of idsOf(t, "refs")) {
			const d = board.byId.get(canonicalId(id));
			if (!d || d.prefix !== "D" || d.status !== "superseded") continue;
			const replacement = d.fields["superseded-by"];
			issues.push({
				file: t.file,
				line: t.fieldLines.refs ?? t.line,
				id: t.id,
				rule: "open-task-superseded",
					message: `${t.id} is open but refs ${id}, which is superseded${replacement ? ` by ${replacement}` : ""}; ${replacement ? `reference ${replacement} instead, ` : ""}or close ${t.id}.`,
			});
		}
	}

	return issues;
}

/** Parse-time issues followed by validateBoard() issues: the complete DESIGN §4.2 result. */
export function allIssues(board: Board, ctx: ValidationContext): BoardIssue[] {
	return [...board.issues, ...validateBoard(board, ctx)];
}

function sameIdIn(ids: string[], id: string): boolean {
	const want = canonicalId(id);
	return ids.some((x) => canonicalId(x) === want);
}

function naturalCompare(a: string, b: string): number {
	const pa = /^([A-Z]+)(\d+)$/.exec(a);
	const pb = /^([A-Z]+)(\d+)$/.exec(b);
	if (pa && pb) {
		if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
		return Number(pa[2]) - Number(pb[2]);
	}
	return a < b ? -1 : a > b ? 1 : 0;
}
