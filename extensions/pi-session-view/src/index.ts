import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isViewportTUI, type TUI, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { openTurnInNvim } from "./open-in-nvim.js";
import { installOutline, type OutlineController, type OutlineDeps } from "./outline.js";
import { buildOutline, type SessionOutline, type SessionTurn } from "./turns.js";

const HOST_WIDGET_KEY = "pi-session-view:outline-host";
const PANEL_SHORTCUT = "alt+s";
const OPEN_SHORTCUT = "alt+o";
const FULLSCREEN_REQUIRED = "The session outline needs fullscreen mode (tuiMode: fullscreen)";
const NO_TUI_HANDLE = "The session outline has no TUI handle: Pi did not hand its renderer to the extension on session_start";
const NO_TURNS = "This session has no turns yet";
const PREVIEW_WIDTH = 60;

export default function sessionViewExtension(pi: ExtensionAPI) {
	let activeCtx: ExtensionContext | undefined;
	/** Pi's renderer reference; it follows renderer swaps made by /settings → TUI mode. */
	let hostTui: TUI | undefined;
	let controller: OutlineController | undefined;
	/** Last failed mount, keyed by the layout root it was attempted on, so it is not retried every frame. */
	let mountFailure: { root: unknown; reason: string } | undefined;
	let syncQueued = false;
	let outlineCache: SessionOutline | undefined;
	let running = false;

	const getOutline = (): SessionOutline => {
		if (!outlineCache && activeCtx) outlineCache = buildOutline(activeCtx.sessionManager);
		return outlineCache ?? { turns: [], compactedTurns: 0 };
	};

	const invalidateOutline = (): void => {
		outlineCache = undefined;
		controller?.refresh();
	};

	const disposeOutline = (): void => {
		controller?.dispose();
		controller = undefined;
	};

	const outlineDeps: OutlineDeps = {
		getOutline,
		isRunning: () => running,
		getTheme: () => activeCtx!.ui.theme,
		openTurn: (turn) => {
			if (activeCtx) void openTurnInNvim(activeCtx, turn);
		},
		notify: (message, type) => activeCtx?.ui.notify(message, type),
	};

	/**
	 * Brings the outline in line with the current renderer: mounts it in
	 * fullscreen (also after a switch from regular mode, which replaces Pi's
	 * layout root without any extension event) and drops it otherwise. Returns
	 * why the outline is unavailable, or undefined when it is mounted.
	 */
	const syncOutline = (): string | undefined => {
		const tui = hostTui;
		if (!activeCtx || !tui) return NO_TUI_HANDLE;
		if (controller?.mounted) return undefined;
		// A controller that is no longer mounted belongs to a replaced renderer or layout.
		disposeOutline();
		if (!isViewportTUI(tui)) return FULLSCREEN_REQUIRED;

		const root = (tui as TUI & { layoutRoot?: unknown }).layoutRoot;
		if (mountFailure && mountFailure.root === root) return mountFailure.reason;
		let reason: string;
		try {
			const result = installOutline(tui, outlineDeps);
			if ("controller" in result) {
				controller = result.controller;
				mountFailure = undefined;
				return undefined;
			}
			reason = result.error;
		} catch (error) {
			reason = error instanceof Error ? error.message : String(error);
		}
		mountFailure = { root, reason: `The session outline could not attach to Pi's fullscreen layout: ${reason}` };
		return mountFailure.reason;
	};

	const outlineOutOfSync = (): boolean => {
		const tui = hostTui;
		if (!activeCtx || !tui) return false;
		if (!isViewportTUI(tui)) return controller !== undefined;
		if (controller?.mounted) return false;
		return !mountFailure || mountFailure.root !== (tui as TUI & { layoutRoot?: unknown }).layoutRoot;
	};

	// Layout changes must not happen while the renderer is mid-frame.
	const scheduleSync = (): void => {
		if (syncQueued) return;
		syncQueued = true;
		queueMicrotask(() => {
			syncQueued = false;
			syncOutline();
		});
	};

	const requireOutline = (ctx: ExtensionContext): OutlineController | undefined => {
		const problem = syncOutline();
		if (problem === undefined && controller) return controller;
		ctx.ui.notify(problem ?? NO_TUI_HANDLE, "warning");
		return undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		// A reload can start a session without a preceding shutdown.
		disposeOutline();
		activeCtx = ctx;
		hostTui = undefined;
		mountFailure = undefined;
		outlineCache = undefined;
		running = false;
		if (ctx.mode !== "tui") return;

		// A widget factory is the extension API's only way to obtain the TUI. The
		// widget renders nothing and does not own the outline: other extensions may
		// call the factory again with a stand-in TUI and dispose the result, and Pi
		// disposes widgets on session replacement. Its render is used to notice a
		// TUI mode switch, since that emits no extension event.
		ctx.ui.setWidget(
			HOST_WIDGET_KEY,
			(tui) => {
				if (tui instanceof TuiAltScreen || tui instanceof TuiMainScreen) hostTui = tui;
				return {
					render: () => {
						if (outlineOutOfSync()) scheduleSync();
						return [];
					},
					invalidate: () => {},
				};
			},
			{ placement: "belowEditor" },
		);
		syncOutline();
	});

	pi.on("session_shutdown", () => {
		disposeOutline();
		activeCtx = undefined;
		hostTui = undefined;
		mountFailure = undefined;
		outlineCache = undefined;
	});

	pi.on("agent_start", () => {
		running = true;
		invalidateOutline();
	});
	pi.on("agent_settled", () => {
		running = false;
		invalidateOutline();
	});
	pi.on("message_start", (event) => {
		if (event.message.role === "user" || event.message.role === "custom") invalidateOutline();
	});
	pi.on("message_end", () => invalidateOutline());
	pi.on("session_compact", () => invalidateOutline());
	pi.on("session_tree", () => invalidateOutline());

	pi.registerCommand("outline", {
		description: "Toggle the session turn rail (`/outline panel` opens the outline panel)",
		getArgumentCompletions: (prefix) =>
			"panel".startsWith(prefix) ? [{ value: "panel", label: "panel", description: "Open the outline panel" }] : null,
		handler: async (args, ctx) => {
			const outline = requireOutline(ctx);
			if (!outline) return;
			if (args.trim() === "panel") {
				outline.togglePanel();
				return;
			}
			ctx.ui.notify(outline.toggleVisible() ? "Turn rail shown" : "Turn rail hidden", "info");
		},
	});

	pi.registerShortcut(PANEL_SHORTCUT, {
		description: "Open the session outline panel",
		handler: async (ctx) => {
			requireOutline(ctx)?.togglePanel();
		},
	});

	pi.registerCommand("open-msg", {
		description: "Open a turn as Markdown in nvim (`/open-msg [number|last]`)",
		handler: async (args, ctx) => {
			const turns = buildOutline(ctx.sessionManager).turns;
			if (turns.length === 0) {
				ctx.ui.notify(NO_TURNS, "warning");
				return;
			}

			const requested = args.trim();
			let turn: SessionTurn | undefined;
			if (requested === "" && ctx.hasUI) {
				const newestFirst = [...turns].reverse();
				const labels = newestFirst.map((item) => `#${item.number}  ${previewOf(item)}`);
				const choice = await ctx.ui.select("Open which turn in nvim?", labels);
				if (choice === undefined) return;
				turn = newestFirst[labels.indexOf(choice)];
			} else if (requested === "" || requested === "last") {
				turn = turns.at(-1);
			} else {
				const number = Number(requested.replace(/^#/, ""));
				turn = turns.find((item) => item.number === number);
				if (!turn) {
					ctx.ui.notify(`No turn ${requested} (visible: #${turns[0]!.number}–#${turns.at(-1)!.number})`, "warning");
					return;
				}
			}
			if (turn) await openTurnInNvim(ctx, turn);
		},
	});

	pi.registerShortcut(OPEN_SHORTCUT, {
		description: "Open the latest turn as Markdown in nvim",
		handler: async (ctx) => {
			const turn = buildOutline(ctx.sessionManager).turns.at(-1);
			if (!turn) {
				ctx.ui.notify(NO_TURNS, "warning");
				return;
			}
			await openTurnInNvim(ctx, turn);
		},
	});
}

function previewOf(turn: SessionTurn): string {
	const text = turn.prompt.replace(/\s+/g, " ").trim() || (turn.entryId ? "(no text)" : "(prompt compacted)");
	return text.length > PREVIEW_WIDTH ? `${text.slice(0, PREVIEW_WIDTH)}…` : text;
}
