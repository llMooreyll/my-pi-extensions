// Widget above the editor (DESIGN §9): a bordered board summary in the style of the subagent and team widgets
// (pi-interactive-subagents/subagents/banner.ts). The subagent and team widgets already list the background
// processes and handle clicks on them, so this widget only shows the board.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { readBoardDir } from "./project.ts";
import { parseBoard } from "./shared/parse.ts";

const WIDGET_KEY = "pi-board";
const REFRESH_MS = 2000;

// ---- Contract with pi-interactive-subagents (globalThis[Symbol.for("pi.subagents.background.v1")]), used by Alt+J ----

export interface BackgroundAgent {
	id: string;
	kind: "sub" | "team";
	name: string;
	state: string;
	paneId?: string;
	windowId?: string;
}

export interface BackgroundAgentsService {
	list(): BackgroundAgent[];
	subscribe(cb: () => void): () => void;
	focus(id: string): Promise<boolean>;
}

const BACKGROUND_SYMBOL = Symbol.for("pi.subagents.background.v1");

export function backgroundService(): BackgroundAgentsService | undefined {
	const service = (globalThis as Record<symbol, unknown>)[BACKGROUND_SYMBOL] as Partial<BackgroundAgentsService> | undefined;
	return service && typeof service.list === "function" && typeof service.focus === "function"
		? (service as BackgroundAgentsService)
		: undefined;
}

export function agentLabel(a: BackgroundAgent): string {
	return `${a.kind}:${a.name} ${a.state}`;
}

// ---- Board statistics ----

export interface BoardStats {
	/** Ids of tasks with status doing. */
	doing: string[];
	/** Open conflicts. */
	conflicts: number;
	/** Open tasks owned by the user. */
	waiting: number;
	/** Changes of the current lead turn, members included. */
	changes: number;
}

export function boardStats(boardRoot: string, thisTurnChanges: number): BoardStats {
	const board = parseBoard([...readBoardDir(boardRoot)].map(([path, content]) => ({ path, content })));
	return {
		doing: board.entries.filter((e) => e.prefix === "T" && e.status === "doing").map((e) => e.id),
		conflicts: board.entries.filter((e) => e.prefix === "C" && !e.closed).length,
		waiting: board.entries.filter((e) => e.prefix === "T" && !e.closed && e.fields.owner === "user").length,
		changes: thisTurnChanges,
	};
}

function doingText(doing: string[]): string {
	if (doing.length === 0) return "-";
	return doing.length <= 3 ? doing.join(", ") : `${doing.slice(0, 3).join(", ")} +${doing.length - 3}`;
}

function changesText(changes: number): string {
	return `this turn ${changes} ${changes === 1 ? "change" : "changes"}`;
}

/** One-line text form, for RPC mode where components are not available. */
export function summaryLine(s: BoardStats): string {
	return `doing ${doingText(s.doing)} · conflicts ${s.conflicts} · waiting on you ${s.waiting} · ${changesText(s.changes)}`;
}

// ---- Bordered banner primitives (same glyphs and width rules as pi-interactive-subagents/subagents/banner.ts) ----

type Paint = (text: string) => string;

function borderTop(title: string, info: string, width: number, paint: Paint): string {
	if (width <= 0) return "";
	if (width === 1) return paint("╭");
	const inner = Math.max(0, width - 2);
	const titlePart = `─ ${title} `;
	const infoPart = ` ${info} ─`;
	const fill = "─".repeat(Math.max(0, inner - titlePart.length - infoPart.length));
	return paint(`╭${`${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─")}╮`);
}

/** │left          right│ : the right part is kept, the left part is truncated. */
function borderLine(left: string, right: string, width: number, paint: Paint): string {
	if (width <= 0) return "";
	if (width === 1) return paint("│");
	const contentWidth = Math.max(0, width - 2);
	const rightWidth = visibleWidth(right);
	const bar = paint("│");
	if (rightWidth >= contentWidth) {
		const clipped = truncateToWidth(right, contentWidth);
		return `${bar}${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}${bar}`;
	}
	const clippedLeft = truncateToWidth(left, Math.max(0, contentWidth - rightWidth));
	const pad = Math.max(0, contentWidth - visibleWidth(clippedLeft) - rightWidth);
	return `${bar}${clippedLeft}${" ".repeat(pad)}${right}${bar}`;
}

function borderBottom(width: number, paint: Paint): string {
	if (width <= 0) return "";
	if (width === 1) return paint("╰");
	return paint(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

/** The part of Pi's Theme the widget uses. */
interface UiTheme {
	fg(color: any, text: string): string;
	bold(text: string): string;
}

/** Zero values are dimmed instead of omitted so the layout stays stable. */
function renderBanner(s: BoardStats, width: number, theme: UiTheme): string[] {
	const paint: Paint = (text) => theme.fg("accent", text);
	const dot = theme.fg(s.doing.length > 0 ? "accent" : "dim", "●");
	const doing = s.doing.length > 0 ? theme.bold(doingText(s.doing)) : theme.fg("dim", "-");
	const left = ` ${dot} ${theme.fg("dim", "doing")} ${doing} `;

	const counter = (label: string, n: number, color: string) =>
		n > 0 ? `${theme.fg("dim", label)} ${theme.fg(color, String(n))}` : theme.fg("dim", `${label} 0`);
	const right = ` ${counter("conflicts", s.conflicts, "warning")}${theme.fg("dim", " · ")}${counter("waiting on you", s.waiting, "accent")} `;

	return [
		borderTop("Board", changesText(s.changes), width, paint),
		borderLine(left, right, width, paint),
		borderBottom(width, paint),
	];
}

// ---- Widget ----

export interface WidgetController {
	refresh(): void;
	dispose(): void;
}

export function installWidget(ctx: ExtensionContext, computeStats: () => BoardStats): WidgetController {
	let stats: BoardStats = { doing: [], conflicts: 0, waiting: 0, changes: 0 };
	let signature = "";
	let tui: TUI | undefined;
	let disposed = false;

	const component = (theme: UiTheme): Component => ({
		render: (width: number) => renderBanner(stats, width, theme),
		invalidate() {},
	});

	/** Never throws: it runs from a timer and from handlers, and ctx or tui may belong to a replaced session. */
	function refresh(): void {
		if (disposed) return;
		try {
			const next = computeStats();
			const nextSignature = JSON.stringify(next);
			if (nextSignature === signature) return;
			signature = nextSignature;
			stats = next;
			if (ctx.mode === "rpc") ctx.ui.setWidget(WIDGET_KEY, [summaryLine(stats)]);
			else tui?.requestRender();
		} catch {
			// keep the last rendered state
		}
	}

	try {
		stats = computeStats();
	} catch {
		// shown as zeros until the next refresh
	}
	signature = JSON.stringify(stats);
	if (ctx.mode === "rpc") {
		ctx.ui.setWidget(WIDGET_KEY, [summaryLine(stats)]);
	} else {
		ctx.ui.setWidget(
			WIDGET_KEY,
			(t, theme) => {
				tui = t;
				return component(theme);
			},
			{ placement: "aboveEditor" },
		);
	}

	const timer = setInterval(refresh, REFRESH_MS);
	timer.unref();

	return {
		refresh,
		dispose() {
			disposed = true;
			clearInterval(timer);
			try {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
			} catch {
				// context already torn down
			}
		},
	};
}
