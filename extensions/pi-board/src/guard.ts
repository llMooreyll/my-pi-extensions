// tool_call checks: write/edit arguments (DESIGN §5), plan-document validation (§4.1-§4.3), bash writes to docs/board/.

import { join } from "node:path";
import { BOARD_DIR, allIssues, canonicalId, markdownAnchors, parseBoard } from "./shared/parse.ts";
import type { Board, BoardFile, BoardIssue, ValidationContext } from "./shared/types.ts";
import { fileExists as pathExists, headBoardFiles, readBoardDir, readText } from "./project.ts";

export const MESSAGE_MIN = 10;
export const MESSAGE_MAX = 120;

/** Projected plan content of write/edit calls that passed validation and have not finished executing yet. */
export type PendingPlanWrites = Map<string, { abs: string; repoPath: string; content: string }>;

export function checkMessage(input: Record<string, unknown>): string | undefined {
	const raw = typeof input.message === "string" ? input.message.trim() : "";
	const length = [...raw].length;
	if (length >= MESSAGE_MIN && length <= MESSAGE_MAX) return undefined;
	return (
		`pi-board: \`message\` must be ${MESSAGE_MIN}-${MESSAGE_MAX} characters (got ${length}). ` +
		"Write one sentence saying what changed and why, e.g. \"Default punctuation engine switched to ct-punc, implementing D26\"; " +
		"\"update file\" is not acceptable. Resubmit the same call with a proper message."
	);
}

/** Validates the optional `task` argument against the tasks of the given plan files. */
export function checkTask(input: Record<string, unknown>, files: Map<string, string>): string | undefined {
	const task = typeof input.task === "string" ? input.task.trim() : "";
	if (task === "") return undefined;
	const board = parseBoard(toBoardFiles(files));
	if (/^T\d+$/.test(task) && board.byId.has(canonicalId(task))) return undefined;
	return `pi-board: \`task\` ${task} does not exist in ${BOARD_DIR}/tasks.md; pass an existing task id such as T12, or omit \`task\`.`;
}

function toBoardFiles(files: Map<string, string>): BoardFile[] {
	return [...files].map(([path, content]) => ({ path, content: stripBom(content) }));
}

function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Identity of an issue across edits: line numbers are deliberately not part of it. */
function issueKey(i: BoardIssue): string {
	return `${i.file}|${i.rule ?? ""}|${i.id ?? ""}|${i.message}`;
}

function formatIssue(i: BoardIssue): string {
	const where = i.line > 0 ? `${i.file}:${i.line}` : i.file;
	return `- ${where}${i.id ? ` [${i.id}]` : ""} ${i.message}`;
}

/**
 * Applies write/edit input to `base` in memory. A string is the new content, an object carries the rejection reason,
 * undefined means the file is missing and the built-in edit will report that itself.
 */
export function projectContent(
	toolName: "write" | "edit",
	input: Record<string, unknown>,
	base: string | undefined,
): string | { error: string } | undefined {
	if (toolName === "write") {
		return typeof input.content === "string" ? input.content : { error: "write needs a string `content`." };
	}
	if (base === undefined) return undefined;
	const edits = input.edits;
	if (!Array.isArray(edits) || edits.length === 0) return { error: "edit needs a non-empty `edits` array." };

	const text = stripBom(base).replace(/\r\n/g, "\n");
	const found: Array<{ index: number; length: number; newText: string }> = [];
	for (let i = 0; i < edits.length; i++) {
		const oldText = typeof edits[i]?.oldText === "string" ? (edits[i].oldText as string).replace(/\r\n/g, "\n") : "";
		const newText = typeof edits[i]?.newText === "string" ? (edits[i].newText as string).replace(/\r\n/g, "\n") : "";
		const index = oldText === "" ? -1 : text.indexOf(oldText);
		if (index < 0 || text.indexOf(oldText, index + 1) >= 0) {
			return {
				error:
					`pi-board: edits to docs/board/ files must copy oldText verbatim, but edits[${i}].oldText does not match the current file exactly once (no fuzzy matching here). ` +
					"Read the file again with the read tool and resubmit with oldText copied exactly, whitespace and quotes included.",
			};
		}
		found.push({ index, length: oldText.length, newText });
	}
	found.sort((a, b) => a.index - b.index);
	let out = "";
	let pos = 0;
	for (const f of found) {
		if (f.index < pos) {
			return { error: "pi-board: edits overlap; merge nearby changes into one edit." };
		}
		out += text.slice(pos, f.index) + f.newText;
		pos = f.index + f.length;
	}
	return out + text.slice(pos);
}

export interface PlanCheckArgs {
	root: string;
	/** Repo-relative path of the written file. */
	repoPath: string;
	/** Full content after the write. */
	content: string;
	/** Plan files of this call's predecessors that are still executing, overlaid on the disk state. */
	pending: PendingPlanWrites;
}

/** Plan files as the disk (plus in-flight writes) has them; the base state a new write is compared with. */
export function currentPlanFiles(root: string, pending: PendingPlanWrites): Map<string, string> {
	const files = readBoardDir(root);
	for (const p of pending.values()) {
		if (/^docs\/board\/[^/]+\.md$/.test(p.repoPath)) files.set(p.repoPath, p.content);
	}
	return files;
}

function validationContext(root: string, files: Map<string, string>, headIds: Set<string>): ValidationContext {
	const anchorCache = new Map<string, Set<string> | undefined>();
	return {
		headIds,
		fileExists: (path) => files.has(path) || pathExists(join(root, path)),
		anchorsOf: (path) => {
			if (anchorCache.has(path)) return anchorCache.get(path);
			let anchors: Set<string> | undefined;
			const inBoard = files.get(path);
			if (inBoard !== undefined) anchors = markdownAnchors(stripBom(inBoard));
			else if (path.endsWith(".md")) {
				const text = readText(join(root, path));
				if (text !== undefined) anchors = markdownAnchors(stripBom(text));
			}
			anchorCache.set(path, anchors);
			return anchors;
		},
	};
}

function boardIssues(root: string, files: Map<string, string>, headIds: Set<string>): { board: Board; issues: BoardIssue[] } {
	const board = parseBoard(toBoardFiles(files));
	return { board, issues: allIssues(board, validationContext(root, files, headIds)) };
}

export interface PlanCheckResult {
	/** Rejection text for the AI; undefined when the write may proceed. */
	reason?: string;
	/** Plan files after the write, for the `task` check. */
	projected: Map<string, string>;
}

/**
 * DESIGN §4.1: validates all of docs/board/ with the written file replaced by its new content.
 * A write is rejected when it introduces problems that the current files do not already have, so that a board with
 * several broken files can still be repaired one file at a time.
 */
export function checkPlanWrite(args: PlanCheckArgs): PlanCheckResult {
	const baseFiles = currentPlanFiles(args.root, args.pending);
	const projected = new Map(baseFiles);
	// Nested or non-Markdown files under docs/board/ are not part of the board.
	if (!/^docs\/board\/[^/]+\.md$/.test(args.repoPath)) return { projected };
	projected.set(args.repoPath, args.content);

	const headIds = new Set(parseBoard(headBoardFiles(args.root)).entries.map((e) => e.id));
	const before = new Set(boardIssues(args.root, baseFiles, headIds).issues.map(issueKey));
	const after = boardIssues(args.root, projected, headIds).issues;
	const introduced = after.filter((i) => !before.has(issueKey(i)));
	if (introduced.length === 0) return { projected };

	const older = after.length - introduced.length;
	const reason = [
		`pi-board: ${BOARD_DIR}/ would have ${introduced.length} new problem(s) after this change, so nothing was written (line numbers refer to the file after your change):`,
		...introduced.slice(0, 30).map(formatIssue),
		...(introduced.length > 30 ? [`- ... and ${introduced.length - 30} more`] : []),
		"Fix these and resubmit the same call." + (older > 0 ? ` (${older} older problem(s) elsewhere in ${BOARD_DIR}/ are not counted here.)` : ""),
	].join("\n");
	return { reason, projected };
}

// ---------------------------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------------------------

const BOARD_PATH_RE = /docs\/board(?:\/|\b)/;
const REDIRECT_RE = /(?:^|[^>=-])\d*>{1,2}\s*(["']?)([^\s"';&|<>]+)\1/g;

/**
 * Text-based approximation of "this command writes to docs/board/" (DESIGN §4.3).
 * Read-only commands such as cat or rg pass.
 */
export function bashWritesBoard(command: string): boolean {
	if (!BOARD_PATH_RE.test(command)) return false;
	let inBoardDir = false;
	for (const raw of command.split(/\n|&&|\|\||;|\|/)) {
		const seg = raw.trim();
		if (seg === "") continue;
		const mentions = BOARD_PATH_RE.test(seg);
		if (/^(cd|pushd)(\s|$)/.test(seg)) {
			inBoardDir = mentions;
			continue;
		}
		if (!mentions && !inBoardDir) continue;

		const cleaned = seg.replace(/\d*>&\d+/g, "").replace(/&>\s*\S+/g, "");
		for (const m of cleaned.matchAll(REDIRECT_RE)) {
			const target = m[2];
			if (target === "/dev/null") continue;
			if (BOARD_PATH_RE.test(target) || (inBoardDir && !target.startsWith("/"))) return true;
		}
		if (/(^|\s)tee(\s|$)/.test(seg)) return true;
		if (/(^|\s)sed\s(?:[^|]*\s)?(-[A-Za-z]*i\b|--in-place)/.test(seg)) return true;
		if (/(^|\s)perl\s(?:[^|]*\s)?-[A-Za-z]*i/.test(seg)) return true;
		if (/(^|\s)(mv|rm|truncate)(\s|$)/.test(seg)) return true;
		if (/(^|\s)git\s(?:-\S+\s+)*(checkout|restore)(\s|$)/.test(seg)) return true;
		if (/(^|\s)g?awk\s(?:[^|]*\s)?-i\s*inplace/.test(seg)) return true;
		if (/(^|\s)dd\s(?:[^|]*\s)?of=/.test(seg)) return true;
		if (/(^|\s)cp(\s|$)/.test(seg)) {
			const args = seg.split(/\s+/).filter((t) => !t.startsWith("-"));
			const last = args[args.length - 1] ?? "";
			if (BOARD_PATH_RE.test(last) || inBoardDir) return true;
		}
	}
	return false;
}

export const BASH_BOARD_REASON =
	`pi-board: do not modify ${BOARD_DIR}/ through bash. Use the edit or write tool, which validates the plan documents ` +
	"(only the lead agent may change them; members and subagents report the needed change to the lead instead).";

export const MEMBER_BOARD_REASON =
	`pi-board: only the lead agent may modify ${BOARD_DIR}/. Do not write it; describe the plan change you need ` +
	"in your report to the lead (team_report or your final answer) and let the lead record it.";
