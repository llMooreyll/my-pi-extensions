import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openTurnInNvim } from "./open-in-nvim.js";
import { installOutline, type OutlineController } from "./outline.js";
import { buildOutline, type SessionOutline, type SessionTurn } from "./turns.js";

const HOST_WIDGET_KEY = "pi-session-view:outline-host";
const PANEL_SHORTCUT = "alt+s";
const OPEN_SHORTCUT = "alt+o";
const FULLSCREEN_REQUIRED = "The session outline needs fullscreen mode (tuiMode: fullscreen)";
const NO_TURNS = "This session has no turns yet";
const PREVIEW_WIDTH = 60;

export default function sessionViewExtension(pi: ExtensionAPI) {
	let activeCtx: ExtensionContext | undefined;
	let controller: OutlineController | undefined;
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

	pi.on("session_start", (_event, ctx) => {
		// A reload can start a session without a preceding shutdown.
		disposeOutline();
		activeCtx = ctx;
		outlineCache = undefined;
		running = false;
		if (ctx.mode !== "tui") return;

		// The widget factory is the extension API's way to obtain the TUI instance;
		// the widget itself renders nothing and only owns the sidebar's lifetime.
		ctx.ui.setWidget(
			HOST_WIDGET_KEY,
			(tui) => {
				const mounted = installOutline(tui, {
					getOutline,
					isRunning: () => running,
					getTheme: () => ctx.ui.theme,
					openTurn: (turn) => void openTurnInNvim(ctx, turn),
					notify: (message, type) => ctx.ui.notify(message, type),
				});
				controller = mounted;
				return {
					render: () => [],
					invalidate: () => {},
					dispose: () => {
						mounted.dispose();
						if (controller === mounted) controller = undefined;
					},
				};
			},
			{ placement: "belowEditor" },
		);
	});

	pi.on("session_shutdown", () => {
		disposeOutline();
		activeCtx = undefined;
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
			if (!controller?.mounted) {
				ctx.ui.notify(FULLSCREEN_REQUIRED, "warning");
				return;
			}
			if (args.trim() === "panel") {
				controller.togglePanel();
				return;
			}
			ctx.ui.notify(controller.toggleVisible() ? "Turn rail shown" : "Turn rail hidden", "info");
		},
	});

	pi.registerShortcut(PANEL_SHORTCUT, {
		description: "Open the session outline panel",
		handler: async (ctx) => {
			if (!controller?.mounted) {
				ctx.ui.notify(FULLSCREEN_REQUIRED, "warning");
				return;
			}
			controller.togglePanel();
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
