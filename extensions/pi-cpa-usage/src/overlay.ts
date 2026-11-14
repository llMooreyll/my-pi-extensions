import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import {
	formatCountdown,
	formatPercent,
	formatProviderTitle,
	formatResetClock,
	formatTimeAgo,
	getUsageColor,
	groupWindowsByGroup,
	renderProgressBar,
} from "./format.js";
import type { UsageSnapshot } from "./types.js";

export type UsageOverlayAction =
	| { type: "close" }
	| { type: "switch-server" }
	| { type: "open-config" };

export interface UsageOverlayCallbacks {
	initialSnapshot?: UsageSnapshot;
	serverName: string;
	serverUrl: string;
	statuslineEnabled: boolean;
	showDisabled: boolean;
	refresh: () => Promise<UsageSnapshot>;
	onToggleStatusline: () => boolean;
	onToggleShowDisabled: () => boolean;
}

export class UsageOverlayComponent implements Component {
	private snapshot: UsageSnapshot | undefined;
	private loading = true;
	private loadError: string | undefined;
	private statuslineEnabled: boolean;
	private showDisabled: boolean;
	private scrollOffset = 0;
	private totalBodyLines = 0;
	private lastMaxBodyLines = 16;
	private disposed = false;
	private refreshGeneration = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly callbacks: UsageOverlayCallbacks,
		private readonly done: (action: UsageOverlayAction) => void,
	) {
		this.snapshot = callbacks.initialSnapshot;
		this.statuslineEnabled = callbacks.statuslineEnabled;
		this.showDisabled = callbacks.showDisabled;
		void this.triggerRefresh();
	}

	private async triggerRefresh(): Promise<void> {
		const gen = ++this.refreshGeneration;
		this.loading = true;
		this.loadError = undefined;
		this.tui.requestRender();

		try {
			const next = await this.callbacks.refresh();
			if (this.disposed || gen !== this.refreshGeneration) return;
			this.snapshot = next;
			this.loadError = next.error;
		} catch (err) {
			if (this.disposed || gen !== this.refreshGeneration) return;
			this.loadError = err instanceof Error ? err.message : String(err);
		} finally {
			if (!this.disposed && gen === this.refreshGeneration) {
				this.loading = false;
				this.tui.requestRender();
			}
		}
	}

	invalidate(): void {
		// Re-rendered dynamically from state
	}

	dispose(): void {
		this.disposed = true;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
			this.done({ type: "close" });
			return;
		}
		if (matchesKey(data, "r")) {
			void this.triggerRefresh();
			return;
		}
		if (matchesKey(data, "s")) {
			this.done({ type: "switch-server" });
			return;
		}
		if (matchesKey(data, "c")) {
			this.done({ type: "open-config" });
			return;
		}
		if (matchesKey(data, "p")) {
			this.statuslineEnabled = this.callbacks.onToggleStatusline();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "d")) {
			this.showDisabled = this.callbacks.onToggleShowDisabled();
			void this.triggerRefresh();
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			const maxOffset = Math.max(0, this.totalBodyLines - this.lastMaxBodyLines);
			this.scrollOffset = Math.min(maxOffset, this.scrollOffset + 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(1, this.lastMaxBodyLines - 2));
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			const maxOffset = Math.max(0, this.totalBodyLines - this.lastMaxBodyLines);
			this.scrollOffset = Math.min(maxOffset, this.scrollOffset + Math.max(1, this.lastMaxBodyLines - 2));
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "home")) {
			this.scrollOffset = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "end")) {
			this.scrollOffset = Math.max(0, this.totalBodyLines - this.lastMaxBodyLines);
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const theme = this.theme;
		const safeWidth = Math.max(36, width);
		const innerWidth = Math.max(20, safeWidth - 4);
		const nowMs = Date.now();

		const borderColor = (s: string) => theme.fg("border", s);
		const boxLine = (content: string): string => {
			const truncated = truncateToWidth(content, innerWidth, "…");
			const pad = Math.max(0, innerWidth - visibleWidth(truncated));
			return `${borderColor("│")} ${truncated}${" ".repeat(pad)} ${borderColor("│")}`;
		};
		const dividerLine = (): string => borderColor(`├${"─".repeat(safeWidth - 2)}┤`);

		const titleLeft = theme.bold(theme.fg("accent", "CPA OAuth Usage"));
		const serverTag = this.callbacks.serverName
			? `${theme.fg("text", this.callbacks.serverName)} ${theme.fg("dim", `(${this.callbacks.serverUrl})`)}`
			: theme.fg("warning", "not configured");
		const refreshTag = this.loading
			? theme.fg("warning", "↻ refreshing…")
			: this.snapshot
				? theme.fg("muted", `updated ${formatTimeAgo(this.snapshot.fetchedAtMs, nowMs)}`)
				: "";

		const headerLine1 = `${titleLeft}  ${serverTag}`;
		const headerLine2 = [
			refreshTag,
			this.statuslineEnabled
				? theme.fg("success", "statusline: ON")
				: theme.fg("dim", "statusline: OFF"),
			this.showDisabled ? theme.fg("muted", "disabled: shown") : "",
		]
			.filter(Boolean)
			.join(theme.fg("dim", "  ·  "));

		const bodyLines = this.buildBodyLines(innerWidth, nowMs);
		this.totalBodyLines = bodyLines.length;

		// Keep overlay height bounded cleanly within terminal rows
		const termRows = (this.tui as TUI & { terminal?: { rows?: number } }).terminal?.rows ?? 36;
		const maxBodyLines = Math.max(6, Math.min(bodyLines.length || 4, Math.floor(termRows * 0.72) - 7));
		this.lastMaxBodyLines = maxBodyLines;
		const maxScroll = Math.max(0, bodyLines.length - maxBodyLines);
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;

		const visibleBody = bodyLines.slice(this.scrollOffset, this.scrollOffset + maxBodyLines);
		const scrollHint =
			bodyLines.length > maxBodyLines
				? theme.fg("dim", ` [${this.scrollOffset + 1}-${this.scrollOffset + visibleBody.length}/${bodyLines.length}]`)
				: "";

		const footerHints = [
			`${theme.fg("accent", "[r]")} ${theme.fg("muted", "Refresh")}`,
			`${theme.fg("accent", "[p]")} ${theme.fg("muted", `Statusline ${this.statuslineEnabled ? "OFF" : "ON"}`)}`,
			`${theme.fg("accent", "[s]")} ${theme.fg("muted", "Server")}`,
			`${theme.fg("accent", "[c]")} ${theme.fg("muted", "Config")}`,
			`${theme.fg("accent", "[d]")} ${theme.fg("muted", "Disabled")}`,
			`${theme.fg("accent", "[q/Esc]")} ${theme.fg("muted", "Close")}`,
		].join("  ") + scrollHint;

		const lines: string[] = [];
		lines.push(borderColor(`╭${"─".repeat(safeWidth - 2)}╮`));
		lines.push(boxLine(headerLine1));
		lines.push(boxLine(headerLine2));
		lines.push(dividerLine());
		for (const line of visibleBody) {
			lines.push(boxLine(line));
		}
		lines.push(dividerLine());
		lines.push(boxLine(footerHints));
		lines.push(borderColor(`╰${"─".repeat(safeWidth - 2)}╯`));
		return lines;
	}

	private buildBodyLines(innerWidth: number, nowMs: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];

		if (!this.callbacks.serverUrl) {
			lines.push(theme.fg("warning", "No CPA server configured."));
			lines.push(theme.fg("muted", "Press [c] to configure a server URL and management key."));
			return lines;
		}

		if (this.loadError && (!this.snapshot || this.snapshot.accounts.length === 0)) {
			lines.push(theme.fg("error", `Failed to fetch usage: ${this.loadError}`));
			lines.push(theme.fg("muted", "Press [r] to retry or [s]/[c] to change server settings."));
			return lines;
		}

		if (!this.snapshot) {
			lines.push(theme.fg("muted", "Loading live OAuth quota from CPA server…"));
			return lines;
		}

		if (this.loadError) {
			lines.push(theme.fg("warning", `Refresh warning: ${this.loadError}`));
			lines.push("");
		}

		const accounts = this.showDisabled
			? this.snapshot.accounts
			: this.snapshot.accounts.filter((a) => !a.disabled);

		if (accounts.length === 0) {
			lines.push(theme.fg("muted", "No active OAuth credentials found on this CPA server."));
			return lines;
		}

		const barWidth = innerWidth >= 72 ? 14 : innerWidth >= 54 ? 10 : 6;

		accounts.forEach((acc, idx) => {
			if (idx > 0) lines.push("");

			const providerBadge = theme.bold(theme.fg("accent", formatProviderTitle(acc.provider)));
			const accountText = theme.fg("text", acc.account);
			const sourceBadge = acc.disabled
				? theme.fg("error", "[disabled]")
				: acc.source === "live"
					? theme.fg("success", "[live]")
					: acc.source === "signal"
						? theme.fg("warning", "[signal]")
						: theme.fg("dim", "[unavailable]");
			lines.push(`${providerBadge}  ${accountText}  ${sourceBadge}`);

			if (acc.windows.length === 0) {
				lines.push(`  ${theme.fg(acc.error ? "error" : "dim", acc.error ?? "No quota data")}`);
				return;
			}

			const grouped = groupWindowsByGroup(acc.windows);
			for (const g of grouped) {
				if (g.group) {
					lines.push(`  ${theme.fg("mdHeading", g.group)}`);
				}
				const indent = g.group ? "    " : "  ";
				for (const w of g.windows) {
					const color = getUsageColor(w.usedPercent);
					const labelCol = theme.fg("muted", w.label.padEnd(15));
					const bar = renderProgressBar(w.usedPercent, barWidth, theme);
					const usedStr = theme.fg(color, formatPercent(w.usedPercent, true).padStart(5));
					const leftStr = theme.fg("dim", `(${formatPercent(w.remainingPercent, true)} left)`);
					const resetStr = w.resetAtMs
						? theme.fg("muted", `resets ${formatCountdown(w.resetAtMs, nowMs)}`) +
							theme.fg("dim", ` · ${formatResetClock(w.resetAtMs, nowMs)}`)
						: theme.fg("dim", "reset unknown");
					lines.push(`${indent}${labelCol} ${bar} ${usedStr} ${leftStr}  ${resetStr}`);
				}
			}
		});

		return lines;
	}
}
