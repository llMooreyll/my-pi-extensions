import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	HStack,
	isViewportTUI,
	matchesKey,
	type OverlayHandle,
	type OverlayOptions,
	type StackEntry,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	VStack,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { findTranscript, locateTurns, type Transcript, type TurnRows } from "./transcript.js";
import type { SessionOutline, SessionTurn } from "./turns.js";

/**
 * Rail: one short dash per turn, right-aligned, like the table-of-contents
 * minimap at the edge of a Notion page. One column of gap on each side.
 */
const RAIL_WIDTH = 6;
const RAIL_DASH_LENGTHS = [4, 3, 2];
const RAIL_DASH_MIN = 1;
const RAIL_MAX_ROWS = 15;
const MIN_RAIL_COLUMNS = 60;

/** Card: floats left of the rail, centred in the transcript area. */
const CARD_WIDTH_RATIO = 0.34;
const CARD_MIN_WIDTH = 44;
const CARD_MAX_WIDTH = 64;
const CARD_PROMPT_LINES = 2;
/** Top/bottom border plus one padding row on each side. */
const CARD_CHROME_ROWS = 4;

/** Turn positions are re-measured at most this often unless the transcript shape changes. */
const LOCATE_REFRESH_MS = 1_000;

/** The part of a turn a jump scrolls to: the user's prompt or the reply text. */
type JumpTarget = "prompt" | "answer";

export interface OutlineDeps {
	getOutline(): SessionOutline;
	isRunning(): boolean;
	getTheme(): Theme;
	openTurn(turn: SessionTurn): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface OutlineController {
	readonly mounted: boolean;
	/** Shows or hides the rail; returns the new visibility. */
	toggleVisible(): boolean;
	/** Opens the outline card, or closes it when open. */
	togglePanel(): void;
	refresh(): void;
	dispose(): void;
}

const NOOP_CONTROLLER: OutlineController = {
	mounted: false,
	toggleVisible: () => false,
	togglePanel: () => {},
	refresh: () => {},
	dispose: () => {},
};

const EMPTY: Component = { render: () => [], invalidate: () => {} };

function isComponent(value: unknown): value is Component {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Component).render === "function" &&
		typeof (value as Component).invalidate === "function"
	);
}

/**
 * Pi's fullscreen root is `VStack[transcript, dock]` (chat-viewport.ts). Its
 * entries are internal, so they are validated before reuse.
 */
function readRootEntries(root: Component, transcript: Transcript | undefined): [StackEntry, StackEntry] | undefined {
	if (!(root instanceof VStack) || !transcript) return undefined;
	const entries = (root as unknown as { entries?: unknown }).entries;
	if (!Array.isArray(entries) || entries.length !== 2) return undefined;
	const [top, bottom] = entries as StackEntry[];
	if (top?.component !== transcript.scrollView || !isComponent(bottom?.component)) return undefined;
	return [top, bottom];
}

/**
 * Rebuilds Pi's fullscreen layout as `VStack[HStack[transcript, rail], dock]`:
 * the transcript and the rail share the upper area while the editor dock keeps
 * the full width. Pi exposes `setLayoutRoot()` but not the current root, so
 * this reads the internal `layoutRoot` field; when the shape is unexpected it
 * falls back to placing the rail beside the whole layout, and when the field is
 * missing it does nothing.
 */
export function installOutline(tui: TUI, deps: OutlineDeps): OutlineController {
	if (!isViewportTUI(tui)) return NOOP_CONTROLLER;
	const previousRoot = (tui as TUI & { layoutRoot?: unknown }).layoutRoot;
	if (!isComponent(previousRoot)) return NOOP_CONTROLLER;

	let railEnabled = true;
	const railVisible = () => railEnabled && tui.terminal.columns >= MIN_RAIL_COLUMNS;
	const transcript = findTranscript(previousRoot);
	const navigator = new TurnNavigator(tui, deps, transcript, () =>
		tui.terminal.columns - (railVisible() ? RAIL_WIDTH : 0),
	);

	const rail = new TurnRail(deps, navigator);
	// Spacers above and below centre the rail vertically in its column.
	const railColumn = new VStack([
		{ component: EMPTY, basis: 0, grow: 1, shrink: 1, minSize: 0 },
		{ component: rail, basis: "auto", grow: 0, shrink: 0 },
		{ component: EMPTY, basis: 0, grow: 1, shrink: 1, minSize: 0 },
	]);
	const railEntry: StackEntry = { component: railColumn, basis: RAIL_WIDTH, grow: 0, shrink: 0, visible: railVisible };

	const rootEntries = readRootEntries(previousRoot, transcript);
	const root = rootEntries
		? new VStack([
				{ ...rootEntries[0], component: new HStack([{ component: rootEntries[0].component, basis: 0, grow: 1, shrink: 1, minSize: 1 }, railEntry]) },
				rootEntries[1],
			])
		: new HStack([{ component: previousRoot, basis: 0, grow: 1, shrink: 1, minSize: 1 }, railEntry]);

	let cardHandle: OverlayHandle | undefined;
	const closeCard = () => {
		const handle = cardHandle;
		cardHandle = undefined;
		handle?.hide();
		tui.requestRender();
	};
	const cardWidth = () => {
		const columns = tui.terminal.columns;
		const preferred = Math.min(CARD_MAX_WIDTH, Math.max(CARD_MIN_WIDTH, Math.round(columns * CARD_WIDTH_RATIO)));
		return Math.max(20, Math.min(preferred, columns - RAIL_WIDTH - 2));
	};
	const cardMaxHeight = () => Math.max(CARD_CHROME_ROWS + 3, navigator.viewportHeight() - 2);
	const openCard = () => {
		const card = new OutlineCard(tui, deps, navigator, cardMaxHeight, closeCard);
		// Getters: Pi re-reads overlay options on every render, so the card follows resizes.
		const options: OverlayOptions = {
			get width() {
				return cardWidth();
			},
			get maxHeight() {
				return cardMaxHeight();
			},
			get margin() {
				const transcriptHeight = navigator.viewportHeight();
				return {
					top: 1,
					right: railVisible() ? RAIL_WIDTH : 1,
					bottom: Math.max(1, tui.terminal.rows - transcriptHeight + 1),
				};
			},
			anchor: "right-center",
		};
		cardHandle = tui.showOverlay(card, options);
		tui.requestRender();
	};

	try {
		tui.setLayoutRoot(root);
	} catch {
		return NOOP_CONTROLLER;
	}
	tui.requestRender();

	let disposed = false;
	return {
		mounted: true,
		toggleVisible(): boolean {
			railEnabled = !railEnabled;
			tui.requestRender();
			return railEnabled;
		},
		togglePanel(): void {
			if (disposed) return;
			// An open card always holds focus; a stale handle (overlay removed by Pi) reopens.
			if (cardHandle?.isFocused()) {
				closeCard();
				return;
			}
			closeCard();
			openCard();
		},
		refresh(): void {
			if (!disposed) tui.requestRender();
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			closeCard();
			const host = tui as TUI & { layoutRoot?: unknown };
			if (host.layoutRoot === root) tui.setLayoutRoot(previousRoot);
			tui.requestRender();
		},
	};
}

/** Maps turns to transcript rows and scrolls the transcript. */
class TurnNavigator {
	private located?: { key: string; at: number; rows: Map<SessionTurn, TurnRows> };

	constructor(
		private readonly tui: TUI,
		private readonly deps: OutlineDeps,
		private readonly transcript: Transcript | undefined,
		private readonly getMainWidth: () => number,
	) {}

	viewportHeight(): number {
		const height = this.transcript?.scrollView.viewportHeight ?? 0;
		return height > 0 ? height : Math.floor(this.tui.terminal.rows * 0.7);
	}

	/** Index of the turn whose prompt is at or above the top of the transcript viewport. */
	viewIndex(turns: readonly SessionTurn[]): number {
		const last = turns.length - 1;
		const transcript = this.transcript;
		if (!transcript || last < 0 || transcript.scrollView.isFollowingEnd) return last;

		const rows = this.locate(transcript, turns, false);
		// Probing at the top keeps a turn that was just jumped to (scrolled to the top) current.
		const probe = transcript.scrollView.scrollTop + 1;
		let index = -1;
		turns.forEach((turn, turnIndex) => {
			const row = rows.get(turn)?.prompt;
			if (row !== undefined && row <= probe) index = turnIndex;
		});
		return index === -1 ? 0 : index;
	}

	/** Scrolls to the turn's prompt, or to its reply text; returns false when that spot is not on screen. */
	jumpTo(turn: SessionTurn, reportFailure: boolean, target: JumpTarget = "prompt"): boolean {
		const transcript = this.transcript;
		const rows = transcript ? this.locate(transcript, this.deps.getOutline().turns, true).get(turn) : undefined;
		if (!transcript || !rows) {
			if (reportFailure) this.deps.notify(`Turn ${turn.number} is not in the visible transcript`, "warning");
			return false;
		}
		if (target === "answer" && rows.answer === undefined) {
			if (reportFailure) this.deps.notify(`Turn ${turn.number} has no reply yet`, "warning");
			return false;
		}
		// One line of context above a reply keeps it from starting flush at the top edge.
		const row = target === "answer" ? Math.max(rows.prompt, rows.answer! - 1) : rows.prompt;
		transcript.scrollView.scrollTo(row, { disableFollow: true });
		this.tui.requestRender();
		return true;
	}

	private locate(transcript: Transcript, turns: readonly SessionTurn[], force: boolean): Map<SessionTurn, TurnRows> {
		const contentWidth = transcript.scrollView.getContentWidth(this.getMainWidth());
		const childCount = transcript.document.children.reduce(
			(count, child) => count + ("children" in child && Array.isArray(child.children) ? child.children.length : 0),
			0,
		);
		const key = `${contentWidth}:${childCount}:${turns.length}:${turns.at(-1)?.entryId ?? ""}`;
		const now = Date.now();
		if (!force && this.located && this.located.key === key && now - this.located.at < LOCATE_REFRESH_MS) {
			return this.located.rows;
		}
		let rows: Map<SessionTurn, TurnRows>;
		try {
			rows = locateTurns(transcript, contentWidth, turns);
		} catch {
			rows = new Map();
		}
		this.located = { key, at: now, rows };
		return rows;
	}
}

/**
 * Collapsed outline: a compact stack of short heavy dashes, one per turn. The
 * current turn's dash is the longest and brightest; neighbours step down in
 * length and tone, so the stack reads as a soft arc pointing at "you are here".
 */
class TurnRail implements Component {
	private rowTurns: number[] = [];

	constructor(
		private readonly deps: OutlineDeps,
		private readonly navigator: TurnNavigator,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const turns = this.deps.getOutline().turns;
		this.rowTurns = [];
		if (turns.length === 0) return [];

		const theme = this.deps.getTheme();
		const current = this.navigator.viewIndex(turns);
		const rows = Math.max(1, Math.min(RAIL_MAX_ROWS, turns.length, this.navigator.viewportHeight() - 2));
		const start = Math.min(Math.max(0, current - Math.floor(rows / 2)), turns.length - rows);
		const maxDash = Math.max(1, width - 2);

		const lines: string[] = [];
		for (let index = start; index < start + rows; index++) {
			const distance = Math.abs(index - current);
			const length = Math.min(maxDash, RAIL_DASH_LENGTHS[distance] ?? RAIL_DASH_MIN);
			const dash = theme.fg(dashColor(turns[index]!, distance), "━".repeat(length));
			lines.push(`${" ".repeat(width - 1 - length)}${dash} `);
			this.rowTurns.push(index);
		}
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const turns = this.deps.getOutline().turns;
		if (event.type === "wheel") {
			// Scrolling over the rail steps through turns one at a time.
			const direction = Math.sign(event.wheelDelta ?? 0);
			const target = turns[this.navigator.viewIndex(turns) + direction];
			if (target && direction !== 0) this.navigator.jumpTo(target, false);
			return { handled: true };
		}
		if (event.button !== "left") return undefined;
		// Claiming the press is what makes the renderer deliver the click to us.
		if (event.type === "press") return { handled: true, render: false };
		if (event.type !== "click") return undefined;

		const index = this.rowTurns[event.y];
		const turn = index === undefined ? undefined : turns[index];
		if (turn) this.navigator.jumpTo(turn, true);
		return { handled: true };
	}
}

function dashColor(turn: SessionTurn, distance: number): Parameters<Theme["fg"]>[0] {
	if (turn.hasError) return "error";
	if (distance === 0) return "accent";
	if (distance === 1) return "muted";
	if (distance === 2) return "dim";
	return "borderMuted";
}

interface CardRow {
	text: string;
	turnIndex?: number;
	selected?: boolean;
}

/**
 * Outline card: a rounded, floating list. Unselected turns are one quiet line;
 * the selected turn is a filled block with a two-line prompt and a meta line,
 * aligned on a hanging indent after the turn number.
 */
class OutlineCard implements Component {
	private selected: number;
	/** Which part of the selected turn the transcript shows; Tab toggles it. */
	private target: JumpTarget = "prompt";
	private scrollTop = 0;
	private lastRevealKey = "";
	private rowTurns: Array<number | undefined> = [];

	constructor(
		private readonly tui: TUI,
		private readonly deps: OutlineDeps,
		private readonly navigator: TurnNavigator,
		private readonly getMaxHeight: () => number,
		private readonly close: () => void,
	) {
		this.selected = Math.max(0, navigator.viewIndex(deps.getOutline().turns));
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const turns = this.deps.getOutline().turns;
		const move = (index: number) => {
			if (turns.length === 0) return;
			this.selected = Math.min(turns.length - 1, Math.max(0, index));
			this.target = "prompt";
			// Moving the selection previews the turn in the transcript.
			this.navigator.jumpTo(turns[this.selected]!, false);
		};

		if (matchesKey(data, "k") || matchesKey(data, "up")) move(this.selected - 1);
		else if (matchesKey(data, "j") || matchesKey(data, "down")) move(this.selected + 1);
		else if (matchesKey(data, "g") || matchesKey(data, "home")) move(0);
		else if (data === "G" || matchesKey(data, "end")) move(turns.length - 1);
		else if (matchesKey(data, "tab")) {
			const turn = turns[this.selected];
			const next: JumpTarget = this.target === "prompt" ? "answer" : "prompt";
			if (turn && this.navigator.jumpTo(turn, true, next)) this.target = next;
		} else if (matchesKey(data, "enter") || matchesKey(data, "l")) {
			const turn = turns[this.selected];
			if (turn) this.navigator.jumpTo(turn, true, this.target);
			this.close();
			return;
		} else if (matchesKey(data, "o")) {
			const turn = turns[this.selected];
			if (turn) this.deps.openTurn(turn);
		} else if (
			matchesKey(data, "escape") ||
			matchesKey(data, "q") ||
			matchesKey(data, "h") ||
			matchesKey(data, "alt+s")
		) {
			this.close();
			return;
		}
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			this.scrollTop = Math.max(0, this.scrollTop + (event.wheelDelta ?? 0));
			return { handled: true };
		}
		if (event.button !== "left" || event.type !== "click") return { handled: true, render: false };

		const index = this.rowTurns[event.y];
		const turn = index === undefined ? undefined : this.deps.getOutline().turns[index];
		if (turn) {
			this.selected = index!;
			this.target = "prompt";
			if (event.clickCount === 2) this.deps.openTurn(turn);
			else this.navigator.jumpTo(turn, true);
		}
		return { handled: true };
	}

	render(width: number): string[] {
		const theme = this.deps.getTheme();
		const inner = Math.max(10, width - 4);
		const outline = this.deps.getOutline();
		const turns = outline.turns;
		if (turns.length > 0) this.selected = Math.min(turns.length - 1, Math.max(0, this.selected));

		const numberWidth = String(turns.at(-1)?.number ?? 0).length;
		const body: CardRow[] = [];
		if (outline.compactedTurns > 0) {
			body.push({ text: theme.fg("dim", theme.italic(`${" ".repeat(numberWidth + 3)}${outline.compactedTurns} earlier turns compacted`)) });
		}
		let revealStart = 0;
		let revealEnd = 0;
		turns.forEach((turn, index) => {
			const running = index === turns.length - 1 && this.deps.isRunning();
			if (index === this.selected) {
				revealStart = body.length;
				for (const text of selectedRows(theme, turn, numberWidth, inner, running, this.target)) {
					body.push({ text, turnIndex: index, selected: true });
				}
				revealEnd = body.length;
			} else {
				body.push({ text: turnRow(theme, turn, numberWidth, inner, running), turnIndex: index });
			}
		});
		if (body.length === 0) body.push({ text: theme.fg("dim", "  No turns yet") });

		const listHeight = Math.max(1, Math.min(body.length, this.getMaxHeight() - CARD_CHROME_ROWS));
		// Scroll only when the selection changes, so wheel scrolling sticks.
		const revealKey = `${this.selected}:${turns.length}`;
		if (revealKey !== this.lastRevealKey) {
			this.lastRevealKey = revealKey;
			if (revealStart - 1 < this.scrollTop) this.scrollTop = revealStart - 1;
			else if (revealEnd + 1 > this.scrollTop + listHeight) this.scrollTop = revealEnd + 1 - listHeight;
		}
		this.scrollTop = Math.min(Math.max(0, body.length - listHeight), Math.max(0, this.scrollTop));
		const visible = body.slice(this.scrollTop, this.scrollTop + listHeight);

		const border = (text: string) => theme.fg("borderMuted", text);
		const row = (line: CardRow | undefined) => {
			const cell = truncateToWidth(line?.text ?? "", inner, "…", true);
			return `${border("│")} ${line?.selected ? theme.bg("selectedBg", cell) : cell} ${border("│")}`;
		};

		const count = turns.at(-1)?.number ?? 0;
		const title = ` ${theme.fg("accent", theme.bold("Session"))} `;
		const total = ` ${theme.fg("dim", `${count} ${count === 1 ? "turn" : "turns"}`)} `;
		const separator = theme.fg("dim", " · ");
		const hint = ` ${[
			keyHint(theme, "j/k", ""),
			keyHint(theme, "tab", this.target === "prompt" ? "reply" : "prompt"),
			keyHint(theme, "⏎", "jump"),
			keyHint(theme, "o", "nvim"),
			keyHint(theme, "esc", ""),
		].join(separator)} `;
		const more = this.scrollTop + listHeight < body.length;

		this.rowTurns = [undefined, undefined, ...visible.map((line) => line.turnIndex), undefined, undefined];
		return [
			borderLine("╭", "╮", title, total, width, border),
			row(this.scrollTop > 0 ? { text: theme.fg("dim", centered("▴", inner)) } : undefined),
			...visible.map(row),
			row(more ? { text: theme.fg("dim", centered("▾", inner)) } : undefined),
			borderLine("╰", "╯", hint, "", width, border),
		];
	}
}

function keyHint(theme: Theme, key: string, label: string): string {
	return `${theme.fg("muted", key)}${label ? theme.fg("dim", ` ${label}`) : ""}`;
}

function centered(text: string, width: number): string {
	return `${" ".repeat(Math.max(0, Math.floor((width - visibleWidth(text)) / 2)))}${text}`;
}

/** `╭─ left ───── right ─╮`, shrinking the right label first when space is short. */
function borderLine(
	leftCorner: string,
	rightCorner: string,
	left: string,
	right: string,
	width: number,
	border: (text: string) => string,
): string {
	const available = Math.max(0, width - 4);
	let rightText = right;
	let leftText = left;
	if (visibleWidth(leftText) + visibleWidth(rightText) > available) rightText = "";
	if (visibleWidth(leftText) > available) leftText = truncateToWidth(leftText, available, "…");
	const fill = Math.max(0, available - visibleWidth(leftText) - visibleWidth(rightText));
	return `${border(`${leftCorner}─`)}${leftText}${border("─".repeat(fill))}${rightText}${border(`─${rightCorner}`)}`;
}

function promptText(turn: SessionTurn): string {
	if (turn.prompt) return turn.prompt.replace(/\s+/g, " ").trim();
	return turn.entryId ? "(no text)" : "(prompt compacted)";
}

/** Unselected turn: number and prompt on one quiet line, with a status mark when relevant. */
function turnRow(theme: Theme, turn: SessionTurn, numberWidth: number, width: number, running: boolean): string {
	const status = running ? theme.fg("accent", "⋯") : turn.hasError ? theme.fg("error", "×") : "";
	const promptWidth = Math.max(4, width - numberWidth - 3 - (status ? 2 : 0));
	const prompt = truncateToWidth(promptText(turn), promptWidth, "…", Boolean(status));
	return `  ${theme.fg("dim", String(turn.number).padStart(numberWidth))} ${theme.fg("muted", prompt)}${status ? ` ${status}` : ""}`;
}

/** Selected turn: accent marker and number, a bold two-line prompt, then one meta line on the same indent. */
function selectedRows(
	theme: Theme,
	turn: SessionTurn,
	numberWidth: number,
	width: number,
	running: boolean,
	target: JumpTarget,
): string[] {
	const indent = " ".repeat(numberWidth + 3);
	const textWidth = Math.max(4, width - numberWidth - 3);

	const wrapped = wrapTextWithAnsi(promptText(turn), textWidth);
	const prompt = wrapped.slice(0, CARD_PROMPT_LINES);
	if (wrapped.length > CARD_PROMPT_LINES) {
		prompt[CARD_PROMPT_LINES - 1] = truncateToWidth(`${prompt[CARD_PROMPT_LINES - 1]}…`, textWidth, "…");
	}
	const rows = prompt.map((text, index) =>
		index === 0
			? `${theme.fg("accent", "▎")} ${theme.fg("accent", theme.bold(String(turn.number).padStart(numberWidth)))} ${theme.fg("text", theme.bold(text))}`
			: `${theme.fg("accent", "▎")}${indent.slice(1)}${theme.fg("text", theme.bold(text))}`,
	);

	const toolCalls = [...turn.toolCounts.values()].reduce((sum, count) => sum + count, 0);
	const failedTools = turn.steps.filter((step) => step.kind === "toolError").length;
	const meta = [
		turn.startedAt !== undefined ? formatClock(turn.startedAt) : undefined,
		turn.startedAt !== undefined && turn.endedAt !== undefined && turn.endedAt > turn.startedAt
			? formatDuration(turn.endedAt - turn.startedAt)
			: undefined,
		toolCalls > 0 ? `${toolCalls} ${toolCalls === 1 ? "tool" : "tools"}` : undefined,
		turn.outputTokens > 0 ? `${formatTokens(turn.outputTokens)} out` : undefined,
		turn.imageCount > 0 ? `${turn.imageCount} img` : undefined,
	].filter((part): part is string => Boolean(part));
	const flags = [
		running ? theme.fg("accent", "running") : undefined,
		failedTools > 0 ? theme.fg("warning", `${failedTools} failed`) : undefined,
		turn.hasError ? theme.fg("error", "error") : undefined,
	].filter((part): part is string => Boolean(part));
	// Shows that the transcript is parked on the reply rather than the prompt.
	const place = target === "answer" ? theme.fg("accent", "↳ reply") : undefined;
	const metaText = [place, meta.length > 0 ? theme.fg("dim", meta.join(" · ")) : undefined, ...flags]
		.filter((part): part is string => Boolean(part))
		.join(theme.fg("dim", " · "));
	rows.push(`${theme.fg("accent", "▎")}${indent.slice(1)}${metaText || theme.fg("dim", "—")}`);
	return rows;
}

function formatClock(timestamp: number): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function formatTokens(tokens: number): string {
	return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens);
}
