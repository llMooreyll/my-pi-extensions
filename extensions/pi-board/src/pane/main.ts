// Board pane entry. Started by the pi-board extension in a tmux pane next to pi:
//   node <ext>/src/pane/main.ts --root <main repo root> --session <lead sessionId> --socket <path>
// Read-only view of docs/board/ and .pi/changes/; the only output channel is the quote socket.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { PaneArgs } from "../shared/types.ts";
import { ChangeLog, type BoardState, loadBoard, watchSources } from "./data.ts";
import { type TurnSummary, contentAfterChange, contentBeforeChange, currentTurn as computeTurn, turnBox, turnRows } from "./turn.ts";
import { BAR_BG, SELECT_BG, screen, spread, style, truncate, width, withBackground } from "./term.ts";
import {
	type Row,
	type RowItem,
	type TabId,
	type TabSpec,
	changeCount,
	changeRows,
	issueLines,
	issueQuote,
	planTabRows,
	planTabs,
} from "./views.ts";

type Tab = TabId;

interface TabState {
	cursor?: string;
	scroll: number;
	expanded: Set<string>;
	marked: Set<string>;
}

function parseArgs(argv: string[]): PaneArgs {
	const get = (name: string) => {
		const i = argv.indexOf(`--${name}`);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const root = get("root") ?? process.cwd();
	return { root, session: get("session") ?? "", socket: get("socket") ?? "" };
}

const args = parseArgs(process.argv.slice(2));
const changeLog = new ChangeLog(args.root);
let board: BoardState = loadBoard(args.root);
changeLog.poll();

const tabStates = new Map<Tab, TabState>();
function tabState(id: Tab = tab): TabState {
	let st = tabStates.get(id);
	if (!st) {
		st = { scroll: 0, expanded: new Set(), marked: new Set() };
		tabStates.set(id, st);
	}
	return st;
}

/** Plan tabs in fixed order, then Changes last. */
function tabList(): TabSpec[] {
	return [...planTabs(board), { id: "changes", label: "Changes", paint: (s) => s, count: changeCount(changeLog) }];
}

/** Opens on whatever needs attention first: conflicts, then questions for the user, then work in progress. */
function initialTab(): Tab {
	const specs = planTabs(board);
	for (const id of ["conflicts", "waiting"] as const) {
		if ((specs.find((t) => t.id === id)?.count ?? 0) > 0) return id;
	}
	return "doing";
}

let tab: Tab = initialTab();
/** Screen rows used above the list (tab bar + pinned format issues + divider); set by render(). */
let headerHeight = 2;
/** Clickable tab regions from the last render: row, first and last column (1-based). */
let tabHits: Array<{ row: number; x0: number; x1: number; id: Tab }> = [];
let showClosed = false;
let showPlanChanges = false;
let taskFilter: string | undefined;
let flash: { text: string; ok: boolean; until: number } | undefined;
let rows: Row[] = [];
let lastFrame: string[] = [];
let paused = false;
/** Set by cursor moves; free scrolling (wheel, page keys) leaves it false so long diffs can be read. */
let followCursor = true;

const out = process.stdout;
const cols = () => out.columns || 80;
const height = () => out.rows || 24;

// ---- layout ----

function buildRows(): Row[] {
	const opt = { cols: cols() - 1, showClosed, expanded: tabState().expanded };
	if (tab === "turn") {
		const t = currentTurn();
		return t
			? turnRows(t, board.board.sections, opt.cols, opt.expanded)
			: [{ key: "empty:turn", selectable: false, lines: ["", style.gray("   nothing changed in the latest turn · t goes back")] }];
	}
	return tab !== "changes"
		? planTabRows(board, tab, opt)
		: changeRows(changeLog, args.session, { showPlan: showPlanChanges, task: taskFilter }, opt);
}

function selectable(): Row[] {
	return rows.filter((r) => r.selectable);
}

function currentRow(): Row | undefined {
	const st = tabState();
	const sel = selectable();
	return sel.find((r) => r.key === st.cursor) ?? sel[0];
}

/** Flattens rows to lines; returns the line range of every row. */
function layout(): { lines: string[]; ranges: Map<string, [number, number]> } {
	const st = tabState();
	const cur = currentRow();
	const lines: string[] = [];
	const ranges = new Map<string, [number, number]>();
	for (const r of rows) {
		const start = lines.length;
		const body = [...r.lines, ...(r.expanded ?? [])];
		const isCur = r.selectable && r === cur;
		const isMarked = st.marked.has(r.key);
		body.forEach((l, i) => {
			const gutter = i === 0 && isMarked ? style.green("●") : isCur ? style.brightCyan("▌") : " ";
			const line = gutter + l;
			lines.push(isCur && i < r.lines.length ? withBackground(fit(line), SELECT_BG) : line);
		});
		ranges.set(r.key, [start, lines.length]);
	}
	return { lines, ranges };
}

function fit(line: string): string {
	const w = width(line);
	const c = cols();
	return w >= c ? truncate(line, c) : line + " ".repeat(c - w);
}

/**
 * Tab bar wrapped over as many rows as needed. Each tab reads `Label 3`; the active tab is
 * reversed in its category colour, empty tabs are dimmed. Records click regions in `tabHits`.
 */
function tabBar(): string[] {
	const width0 = cols();
	const rowsOut: string[] = [];
	tabHits = [];
	let line = "";
	let x = 1;
	const flush = () => {
		rowsOut.push(line);
		line = "";
		x = 1;
	};
	for (const t of tabList()) {
		const text = ` ${t.label} ${t.count} `;
		const w = width(text);
		if (x > 1 && x + w > width0) flush();
		let label: string;
		if (t.id === tab) label = style.bold(style.inverse(t.paint(text)));
		else if (t.count === 0) label = style.gray(text);
		else label = `${t.paint(` ${t.label} `)}${style.bold(t.paint(String(t.count)))} `;
		tabHits.push({ row: rowsOut.length, x0: x, x1: x + w - 1, id: t.id });
		line += label;
		x += w;
	}
	const lastWidth = x;
	if (line) flush();
	// Project name on the right of the last row when there is room.
	const name = style.gray(`${basename(args.root)} `);
	const showName = lastWidth + width(name) + 1 <= width0;
	return rowsOut.map((r, i) =>
		withBackground(spread(r, showName && i === rowsOut.length - 1 ? name : "", width0), BAR_BG),
	);
}

/** Everything above the list: tab bar, pinned format issues, and a divider. */
/** Tab bar, pinned format issues, the boxed "this turn" summary (hidden in the full turn view), divider. */
function headerLines(): string[] {
	const lines = tabBar();
	// Keep at least 3 list rows and the status bar; the turn box gives way first, then issues.
	let room = height() - lines.length - 1 - 3;
	const issues = issueLines(board, cols(), Math.max(2, Math.min(6, Math.floor(height() / 5), room - 1)));
	if (issues.length <= room - 1) {
		lines.push(...issues);
		room -= issues.length;
	}
	const t = tab === "turn" ? undefined : currentTurn();
	const boxMax = Math.min(12, Math.floor(height() / 3), room);
	if (t && boxMax >= 4) lines.push(...turnBox(t, cols(), boxMax));
	else if (t) lines.push(style.brightCyan(truncate(`─ this turn #${t.turn}: ${t.plan.length} plan · ${t.files.length} files · t shows them `, cols())));
	else lines.push(style.gray("─".repeat(cols())));
	return lines;
}

/** The latest turn's summary, recomputed only when the board or the change log changed. */
let turnCache: { key: string; value: TurnSummary | undefined } | undefined;
function currentTurn(): TurnSummary | undefined {
	const key = `${board.loadedAt.getTime()}:${changeLog.changes.length}:${changeLog.turns.size}:${changeLog.merged.size}`;
	if (turnCache?.key !== key) turnCache = { key, value: computeTurn(board, changeLog, args.session) };
	return turnCache.value;
}

function viewHeight(): number {
	return Math.max(1, height() - headerHeight - 1);
}

function statusBar(): string {
	if (flash && Date.now() < flash.until) {
		return fit(` ${flash.ok ? style.green(flash.text) : style.brightRed(flash.text)}`);
	}
	const st = tabState();
	const marks = st.marked.size ? style.green(`${st.marked.size} marked · `) : "";
	const common = "⏎ open · ␣ mark · y quote · o nvim";
	if (tab === "turn") return fit(` ${marks}${style.gray(`THIS TURN · ${common} · T in Changes · t/esc back · q`)}`);
	const extra = tab !== "changes"
		? `h ${showClosed ? "hide" : "show"} closed · c changes`
		: `h ${showPlanChanges ? "hide" : "show"} plan edits${taskFilter ? " · f clear" : ""}`;
	return fit(` ${marks}${style.gray(`${common} · ${extra} · t this turn · tab/←→ · q`)}`);
}

function render(): void {
	if (paused) return;
	// A custom section may have disappeared since the last render.
	if (tab !== "turn" && !tabList().some((s) => s.id === tab)) tab = initialTab();
	rows = buildRows();
	const header = headerLines();
	headerHeight = header.length;
	const st = tabState();
	const cur = currentRow();
	if (cur) st.cursor = cur.key;
	const { lines, ranges } = layout();
	const viewH = viewHeight();
	// Keep the cursor row (with its expansion) in view; tall rows align to the top.
	if (cur && followCursor) {
		const [a, b] = ranges.get(cur.key) ?? [0, 1];
		// Pull preceding non-selectable header lines into view when scrolling up to the first item of a section.
		let top = a;
		const idx = rows.indexOf(cur);
		if (idx > 0 && !rows[idx - 1].selectable) top = ranges.get(rows[idx - 1].key)?.[0] ?? a;
		if (top < st.scroll) st.scroll = top;
		else if (b > st.scroll + viewH) st.scroll = Math.min(a, b - viewH);
	}
	st.scroll = Math.max(0, Math.min(st.scroll, Math.max(0, lines.length - viewH)));
	followCursor = false;

	const frame = [...header, ...Array.from({ length: viewH }, (_, i) => lines[st.scroll + i] ?? ""), statusBar()];
	let buf = "";
	for (let i = 0; i < frame.length; i++) {
		if (frame[i] === lastFrame[i]) continue;
		buf += screen.moveTo(i) + screen.clearLine + truncate(frame[i], cols());
	}
	if (buf) out.write(buf);
	lastFrame = frame;
}

function fullRedraw(): void {
	lastFrame = [];
	out.write("\x1b[2J");
	render();
}

function say(text: string, ok = true): void {
	flash = { text, ok, until: Date.now() + 2500 };
	render();
	setTimeout(render, 2600);
}

// ---- actions ----

function moveCursor(delta: number): void {
	const sel = selectable();
	if (!sel.length) return;
	const st = tabState();
	const i = Math.max(0, sel.findIndex((r) => r.key === st.cursor));
	st.cursor = sel[Math.max(0, Math.min(sel.length - 1, i + delta))].key;
	followCursor = true;
	render();
}

function scrollBy(delta: number): void {
	const st = tabState();
	st.scroll = Math.max(0, st.scroll + delta);
	// Move the cursor along so the next render does not snap the view back.
	// Keep the cursor on a row that is at least partly visible, without snapping the view to it.
	const { ranges } = layout();
	const viewH = viewHeight();
	const visible = selectable().filter((r) => {
		const [a, b] = ranges.get(r.key) ?? [0, 0];
		return b > st.scroll && a < st.scroll + viewH;
	});
	const cur = currentRow();
	if (visible.length && cur && !visible.includes(cur)) st.cursor = (delta > 0 ? visible[0] : visible[visible.length - 1]).key;
	render();
}

function toggleExpand(): void {
	const cur = currentRow();
	if (!cur) return;
	const ex = tabState().expanded;
	if (ex.has(cur.key)) ex.delete(cur.key);
	else ex.add(cur.key);
	followCursor = true;
	render();
}

function toggleMark(): void {
	const cur = currentRow();
	if (!cur?.item) return;
	const m = tabState().marked;
	if (m.has(cur.key)) m.delete(cur.key);
	else m.add(cur.key);
	moveCursor(1);
}

function quoteText(item: RowItem): string {
	if (item.kind === "entry") return `〔${item.entry.id} ${item.entry.title}〕`;
	if (item.kind === "change") return `〔改动 ${item.change.path}：${item.change.message}〕`;
	return `〔改动 ${item.file.path}：${item.file.changes.map((c) => c.message).join("；")}〕`;
}

function quote(): void {
	const st = tabState();
	const items = rows.filter((r) => r.item && st.marked.has(r.key)).map((r) => r.item as RowItem);
	const cur = currentRow();
	if (!items.length && cur?.item) items.push(cur.item);
	if (!items.length) return;
	sendQuote(items.map(quoteText).join("\n"), items.length, () => st.marked.clear());
}

function quoteIssues(): void {
	if (!board.issues.length) {
		say("no format issues", false);
		return;
	}
	sendQuote(issueQuote(board), board.issues.length);
}

/** Sends text to pi's editor over the quote socket and reports the outcome in the status bar. */
function sendQuote(text: string, count: number, onOk?: () => void): void {
	if (!args.socket) {
		say("no pi connection (missing --socket)", false);
		return;
	}
	const sock = connect(args.socket);
	let done = false;
	const finish = (ok: boolean, msg: string) => {
		if (done) return;
		done = true;
		sock.destroy();
		if (ok) onOk?.();
		say(msg, ok);
	};
	sock.setTimeout(1500, () => finish(false, "pi did not answer"));
	sock.on("error", () => finish(false, "pi is not reachable"));
	sock.on("connect", () => {
		sock.end(`${JSON.stringify({ type: "quote", text })}\n`, () =>
			finish(true, `quoted ${count} item${count === 1 ? "" : "s"} into pi`),
		);
	});
}

/** Runs a full-screen program (nvim) in a tmux popup, or inline when not in tmux. */
function runViewer(argv: string[]): void {
	if (process.env.TMUX) {
		const cmd = argv.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" ");
		spawnSync("tmux", ["display-popup", "-E", "-w", "92%", "-h", "90%", "-d", args.root, cmd], { stdio: "ignore" });
		fullRedraw();
		return;
	}
	paused = true;
	out.write(screen.leave);
	process.stdin.setRawMode(false);
	spawnSync(argv[0], argv.slice(1), { stdio: "inherit", cwd: args.root });
	process.stdin.setRawMode(true);
	out.write(screen.enter);
	paused = false;
	fullRedraw();
}

/** One scratch directory per pane process for nvim's before/after files; removed on quit. */
let scratchDir: string | undefined;
function scratch(): string {
	scratchDir ??= mkdtempSync(join(tmpdir(), "pi-board-"));
	return scratchDir;
}

function openInEditor(): void {
	const item = currentRow()?.item;
	if (!item) return;
	if (item.kind === "entry") {
		runViewer(["nvim", "-R", `+${Math.max(1, item.entry.line)}`, join(args.root, item.entry.file)]);
		return;
	}
	// A single change, or a whole file's changes in this turn: compare the file before the first
	// and after the last of them, undoing every later recorded change of that file first.
	const span = item.kind === "change" ? [item.change] : item.file.changes;
	const first = span[0];
	const last = span[span.length - 1];
	const dir = scratch();
	const abs = join(args.root, first.path);
	const current = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
	const after = current !== undefined ? contentAfterChange(current, changeLog, last) : undefined;
	const before = current !== undefined ? contentBeforeChange(current, changeLog, first) : undefined;
	if (after !== undefined && before !== undefined) {
		const name = basename(first.path);
		const a = join(dir, `before.${name}`);
		const b = join(dir, `after.${name}`);
		writeFileSync(a, before);
		writeFileSync(b, after);
		runViewer(["nvim", "-R", "-d", a, b]);
		return;
	}
	// The file was edited outside recorded changes, lives in an unmerged worktree, or was deleted:
	// show the recorded diffs instead.
	const p = join(dir, `${basename(first.path)}.diff`);
	writeFileSync(p, span.map((c) => `# ${c.time} ${c.message}\n${c.diff}`).join("\n"));
	runViewer(["nvim", "-R", p]);
	say("file differs from the recorded history; showing the recorded diffs");
}

function showTaskChanges(): void {
	const item = currentRow()?.item;
	if (item?.kind !== "entry" || item.entry.prefix !== "T") {
		say("c works on a task (T…)", false);
		return;
	}
	taskFilter = item.entry.id;
	tabState("changes").cursor = undefined;
	tabState("changes").scroll = 0;
	switchTab("changes");
}

/** Tab to return to when leaving the full "this turn" view. */
let prevTab: Tab = tab;
/** Set when Changes was opened from the turn view with T, so Esc goes back there. */
let returnToTurn = false;

function toggleTurnView(): void {
	if (tab === "turn") return switchTab(prevTab);
	if (returnToTurn) return switchTab("turn");
	prevTab = tab;
	tabState("turn").cursor = undefined;
	tabState("turn").scroll = 0;
	switchTab("turn");
}

/** Opens Changes unfiltered with the cursor on the first change of the latest turn. */
function showTurnInChanges(): void {
	const fromTurn = tab === "turn";
	const t = currentTurn();
	taskFilter = undefined;
	const first = t?.files[0]?.changes[0];
	if (first) tabState("changes").cursor = `change:${first.id}`;
	switchTab("changes");
	returnToTurn = fromTurn;
}

/** Switches to `t`, or moves `step` tabs along the bar (wrapping). */
function switchTab(t?: Tab, step = 1): void {
	returnToTurn = false;
	if (t) tab = t;
	else if (tab === "turn") tab = prevTab;
	else {
		const ids = tabList().map((s) => s.id);
		const i = Math.max(0, ids.indexOf(tab));
		tab = ids[(i + step + ids.length) % ids.length];
	}
	lastFrame = [];
	followCursor = true;
	render();
}

// ---- input ----

function onMouse(b: number, x: number, y: number, release: boolean): void {
	if (b === 64) return scrollBy(-3);
	if (b === 65) return scrollBy(3);
	if (release || b !== 0) return;
	const row = y - 1; // terminal rows are 1-based
	if (row < headerHeight) {
		const hit = tabHits.find((h) => h.row === row && x >= h.x0 && x <= h.x1);
		if (hit) switchTab(hit.id);
		return;
	}
	const st = tabState();
	const lineNo = st.scroll + row - headerHeight;
	const { ranges } = layout();
	for (const r of rows) {
		const [a, z] = ranges.get(r.key) ?? [0, 0];
		if (lineNo >= a && lineNo < z && r.selectable) {
			if (st.cursor === r.key) toggleExpand();
			else {
				st.cursor = r.key;
				followCursor = true;
				render();
			}
			return;
		}
	}
}

function onKey(k: string): void {
	switch (k) {
		case "q":
		case "\x03":
			return quit();
		case "\t":
		case "\x1bOC":
		case "\x1b[C":
			return switchTab(undefined, 1);
		case "\x1b[Z":
		case "\x1bOD":
		case "\x1b[D":
			return switchTab(undefined, -1);
		case "x":
			return quoteIssues();
		case "j":
		case "\x1bOB":
		case "\x1b[B":
			return moveCursor(1);
		case "k":
		case "\x1bOA":
		case "\x1b[A":
			return moveCursor(-1);
		case "\x04":
		case "\x1b[6~":
			return scrollBy(Math.floor(height() / 2));
		case "\x15":
		case "\x1b[5~":
			return scrollBy(-Math.floor(height() / 2));
		case "g":
			return moveCursor(-1e9);
		case "G":
			return moveCursor(1e9);
		case "\r":
		case "l":
			return toggleExpand();
		case " ":
			return toggleMark();
		case "y":
			return quote();
		case "o":
			return openInEditor();
		case "h":
			if (tab !== "changes") showClosed = !showClosed;
			else showPlanChanges = !showPlanChanges;
			return render();
		case "c":
			if (tab !== "changes") showTaskChanges();
			return;
		case "t":
			return toggleTurnView();
		case "T":
			return showTurnInChanges();
		case "f":
			taskFilter = undefined;
			return render();
		case "\x1b":
			if (tab === "turn" && tabState().marked.size === 0) return switchTab(prevTab);
			if (returnToTurn && tabState().marked.size === 0) return switchTab("turn");
			tabState().marked.clear();
			return render();
		case "r":
			board = loadBoard(args.root);
			changeLog.poll();
			return fullRedraw();
	}
	// Number keys jump straight to the n-th tab.
	if (/^[1-9]$/.test(k)) {
		const spec = tabList()[Number(k) - 1];
		if (spec) switchTab(spec.id);
	}
}

const MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
// CSI and SS3 sequences are one key each; a lone ESC stays its own key (no Alt+key parsing).
const KEY_RE = /\x1b\[[0-9;]*[~A-Za-z]|\x1bO[A-Za-z]|[\s\S]/g;

function onData(data: Buffer): void {
	let s = data.toString("utf8");
	s = s.replace(MOUSE_RE, (_m, b, x, y, kind) => {
		onMouse(Number(b), Number(x), Number(y), kind === "m");
		return "";
	});
	for (const k of s.match(KEY_RE) ?? []) onKey(k);
}

// ---- lifecycle ----

let stopWatch = () => {};

function quit(): void {
	stopWatch();
	if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
	out.write(style.reset + screen.leave);
	process.exit(0);
}

function main(): void {
	if (!process.stdin.isTTY) {
		console.error("pi-board pane needs a terminal");
		process.exit(1);
	}
	process.stdin.setRawMode(true);
	process.stdin.on("data", onData);
	out.write(screen.enter + screen.title(`board · ${basename(args.root)}`));
	out.on("resize", fullRedraw);
	process.on("SIGTERM", quit);
	process.on("SIGHUP", quit);
	process.on("exit", () => out.write(screen.leave));
	stopWatch = watchSources(args.root, () => {
		const before = JSON.stringify(board.board.entries.map((e) => [e.id, e.status, e.fields, e.body])) + board.issues.length;
		board = loadBoard(args.root);
		const after = JSON.stringify(board.board.entries.map((e) => [e.id, e.status, e.fields, e.body])) + board.issues.length;
		const logChanged = changeLog.poll();
		if (before !== after || logChanged) render();
		else if (flash && Date.now() >= flash.until) render();
	});
	fullRedraw();
}

main();
