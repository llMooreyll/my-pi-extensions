// Starts and stops the board pane in a tmux split next to the main agent (DESIGN §8.1).
// The pane program itself lives in src/pane/ and is not part of this module.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PaneArgs } from "./shared/types.ts";

const PANE_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "pane", "main.ts");

function tmux(args: string[]): string | undefined {
	try {
		return execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
	} catch {
		return undefined;
	}
}

function shellQuote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function inTmux(): boolean {
	return !!process.env.TMUX && !!process.env.TMUX_PANE;
}

export interface PaneController {
	isOpen(): boolean;
	/** Returns false when tmux refused to split. */
	open(args: PaneArgs): boolean;
	close(): void;
}

export function createPaneController(): PaneController {
	let paneId: string | undefined;

	const isOpen = (): boolean => {
		if (!paneId) return false;
		const panes = tmux(["list-panes", "-a", "-F", "#{pane_id}"]);
		return !!panes && panes.split("\n").includes(paneId);
	};

	return {
		isOpen,
		open(args) {
			if (isOpen()) return true;
			const command = [
				"node",
				shellQuote(PANE_ENTRY),
				"--root",
				shellQuote(args.root),
				"--session",
				shellQuote(args.session),
				"--socket",
				shellQuote(args.socket),
			].join(" ");
			// -d keeps keyboard focus in the agent pane.
			const out = tmux(["split-window", "-h", "-l", "40%", "-d", "-t", process.env.TMUX_PANE as string, "-P", "-F", "#{pane_id}", command]);
			paneId = out?.trim() || undefined;
			return paneId !== undefined;
		},
		close() {
			if (paneId && isOpen()) tmux(["kill-pane", "-t", paneId]);
			paneId = undefined;
		},
	};
}
