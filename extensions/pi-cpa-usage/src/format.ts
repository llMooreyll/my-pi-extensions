import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AccountUsage, QuotaWindow, UsageSnapshot } from "./types.js";

export type UsageColor = "success" | "warning" | "error" | "dim";

export function getUsageColor(usedPercent: number): UsageColor {
	if (!Number.isFinite(usedPercent)) return "dim";
	if (usedPercent >= 90) return "error";
	if (usedPercent >= 70) return "warning";
	return "success";
}

export function formatPercent(pct: number, decimalsWhenHigh = false): string {
	if (!Number.isFinite(pct)) return "?%";
	const clamped = Math.max(0, Math.min(100, pct));
	if (decimalsWhenHigh && clamped > 90 && clamped < 100 && Math.abs(clamped - Math.round(clamped)) >= 0.05) {
		return `${clamped.toFixed(1)}%`;
	}
	return `${Math.round(clamped)}%`;
}

export function formatCountdown(resetAtMs: number | undefined, nowMs = Date.now()): string {
	if (resetAtMs === undefined || !Number.isFinite(resetAtMs)) return "unknown";
	const diffMs = resetAtMs - nowMs;
	if (diffMs <= 0) return "now";

	const totalMin = Math.floor(diffMs / 60_000);
	if (totalMin < 1) return "<1m";
	if (totalMin < 60) return `${totalMin}m`;

	const totalHours = Math.floor(totalMin / 60);
	const mins = totalMin % 60;
	if (totalHours < 24) {
		return mins > 0 ? `${totalHours}h${mins}m` : `${totalHours}h`;
	}

	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	return hours > 0 ? `${days}d${hours}h` : `${days}d`;
}

export function formatResetClock(resetAtMs: number | undefined, nowMs = Date.now()): string {
	if (resetAtMs === undefined || !Number.isFinite(resetAtMs)) return "";
	const reset = new Date(resetAtMs);
	const now = new Date(nowMs);
	const hh = String(reset.getHours()).padStart(2, "0");
	const mm = String(reset.getMinutes()).padStart(2, "0");
	const sameDay =
		reset.getFullYear() === now.getFullYear() &&
		reset.getMonth() === now.getMonth() &&
		reset.getDate() === now.getDate();
	if (sameDay) return `${hh}:${mm}`;
	const month = String(reset.getMonth() + 1).padStart(2, "0");
	const day = String(reset.getDate()).padStart(2, "0");
	return `${month}-${day} ${hh}:${mm}`;
}

export function formatTimeAgo(tsMs: number, nowMs = Date.now()): string {
	const diffSec = Math.max(0, Math.floor((nowMs - tsMs) / 1000));
	if (diffSec < 5) return "just now";
	if (diffSec < 60) return `${diffSec}s ago`;
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) return `${diffMin}m ago`;
	const diffHour = Math.floor(diffMin / 60);
	return `${diffHour}h ago`;
}

export function renderProgressBar(usedPercent: number, width: number, theme: Theme): string {
	const cells = Math.max(4, width);
	const clamped = Math.max(0, Math.min(100, usedPercent));
	const filled = Math.min(cells, Math.round((clamped / 100) * cells));
	const color = getUsageColor(clamped);
	return theme.fg(color, "▰".repeat(filled)) + theme.fg("dim", "▱".repeat(cells - filled));
}

export function formatProviderTitle(provider: string): string {
	switch (provider.toLowerCase()) {
		case "claude":
			return "Claude";
		case "antigravity":
			return "Antigravity";
		case "codex":
			return "Codex";
		case "kimi":
			return "Kimi";
		case "xai":
			return "xAI";
		default:
			return provider.charAt(0).toUpperCase() + provider.slice(1);
	}
}

export function shortenProviderTag(provider: string): string {
	switch (provider.toLowerCase()) {
		case "claude":
			return "Claude";
		case "antigravity":
			return "AG";
		case "codex":
			return "Codex";
		case "kimi":
			return "Kimi";
		case "xai":
			return "xAI";
		default:
			return provider;
	}
}

export function shortenGroupName(group: string): string {
	const trimmed = group.trim();
	const lower = trimmed.toLowerCase();
	if (lower.includes("gemini")) return "Gemini";
	if (lower.includes("claude") || lower.includes("gpt") || lower.includes("3p")) return "3p";
	return trimmed.replace(/\s+models$/i, "");
}

function shortAccountSuffix(account: string): string {
	const at = account.indexOf("@");
	const base = at > 0 ? account.slice(0, at) : account;
	return base.length > 10 ? `${base.slice(0, 9)}…` : base;
}

export function groupWindowsByGroup(windows: QuotaWindow[]): Array<{ group?: string; windows: QuotaWindow[] }> {
	const groups = new Map<string, QuotaWindow[]>();
	for (const w of windows) {
		const key = w.group ?? "";
		const list = groups.get(key) ?? [];
		list.push(w);
		groups.set(key, list);
	}
	return Array.from(groups.entries()).map(([key, list]) => ({
		...(key ? { group: key } : {}),
		windows: sortWindows(list),
	}));
}

function sortWindows(windows: QuotaWindow[]): QuotaWindow[] {
	const rank = (kind: QuotaWindow["kind"]): number => (kind === "five_hour" ? 0 : kind === "weekly" ? 1 : 2);
	return [...windows].sort((a, b) => rank(a.kind) - rank(b.kind) || a.label.localeCompare(b.label));
}

function formatWindowPairCompact(windows: QuotaWindow[], theme?: Theme): string {
	const sorted = sortWindows(windows);
	const parts: string[] = [];
	for (const w of sorted) {
		const label = w.kind === "five_hour" ? "5h" : w.kind === "weekly" ? "7d" : w.label;
		const pct = formatPercent(w.usedPercent);
		if (theme) {
			const color = getUsageColor(w.usedPercent);
			parts.push(`${theme.fg("muted", label)} ${theme.fg(color, pct)}`);
		} else {
			parts.push(`${label} ${pct}`);
		}
	}
	return parts.join(theme ? theme.fg("dim", " · ") : " · ");
}

/**
 * Formats a compact, all-groups statusline string for `ctx.ui.setStatus()`.
 * Antigravity renders ALL groups in compact form (e.g. `AG[Gemini 5h 22% · 7d 21% | 3p 5h 0% · 7d 95%]`).
 */
export function formatStatuslineCompact(snapshot: UsageSnapshot, theme?: Theme): string {
	if (snapshot.error && snapshot.accounts.length === 0) {
		return theme ? theme.fg("warning", `CPA ${snapshot.error}`) : `CPA ${snapshot.error}`;
	}

	const providerCounts = new Map<string, number>();
	for (const acc of snapshot.accounts) {
		if (acc.disabled) continue;
		providerCounts.set(acc.provider, (providerCounts.get(acc.provider) ?? 0) + 1);
	}

	const accountParts: string[] = [];
	for (const acc of snapshot.accounts) {
		if (acc.disabled) continue;
		const tag = shortenProviderTag(acc.provider);
		const multi = (providerCounts.get(acc.provider) ?? 0) > 1;
		const prefix = multi ? `${tag}(${shortAccountSuffix(acc.account)})` : tag;
		const coloredPrefix = theme ? theme.fg("accent", prefix) : prefix;

		if (acc.windows.length === 0) {
			const msg = acc.error ? "err" : "--";
			accountParts.push(`${coloredPrefix} ${theme ? theme.fg("dim", msg) : msg}`);
			continue;
		}

		const grouped = groupWindowsByGroup(acc.windows);
		if (grouped.length === 1 && !grouped[0]?.group) {
			// Single ungrouped account (e.g. Claude / Codex): show primary 5h + Weekly
			const primary = grouped[0]!.windows.filter((w) => w.id === "five-hour" || w.id === "seven-day" || !w.id.startsWith("seven-day-"));
			const target = primary.length > 0 ? primary : grouped[0]!.windows;
			accountParts.push(`${coloredPrefix} ${formatWindowPairCompact(target, theme)}`);
		} else {
			// Grouped provider (e.g. Antigravity): show ALL groups compactly
			const groupStrings = grouped.map((g) => {
				const gLabel = g.group ? shortenGroupName(g.group) : "Quota";
				const gLabelStyled = theme ? theme.fg("text", gLabel) : gLabel;
				return `${gLabelStyled} ${formatWindowPairCompact(g.windows, theme)}`;
			});
			const inner = groupStrings.join(theme ? theme.fg("dim", " | ") : " | ");
			const open = theme ? theme.fg("dim", "[") : "[";
			const close = theme ? theme.fg("dim", "]") : "]";
			accountParts.push(`${coloredPrefix}${open}${inner}${close}`);
		}
	}

	if (accountParts.length === 0) {
		return theme ? theme.fg("dim", "CPA: no active OAuth") : "CPA: no active OAuth";
	}
	return accountParts.join(theme ? theme.fg("borderMuted", " │ ") : " │ ");
}

export function formatPlainReport(snapshot: UsageSnapshot, nowMs = Date.now()): string {
	const header = `[CPA Usage] ${snapshot.serverName} (${snapshot.serverUrl}) · ${formatTimeAgo(snapshot.fetchedAtMs, nowMs)}`;
	if (snapshot.error && snapshot.accounts.length === 0) {
		return `${header}\nError: ${snapshot.error}`;
	}
	if (snapshot.accounts.length === 0) {
		return `${header}\nNo OAuth credentials found.`;
	}

	const lines: string[] = [header];
	for (const acc of snapshot.accounts) {
		const status = acc.disabled ? "disabled" : acc.source;
		lines.push(`\n• ${formatProviderTitle(acc.provider)} · ${acc.account} [${status}]`);
		if (acc.windows.length === 0) {
			lines.push(`  ${acc.error ? `Error: ${acc.error}` : "No quota windows reported"}`);
			continue;
		}
		for (const g of groupWindowsByGroup(acc.windows)) {
			if (g.group) lines.push(`  ${g.group}:`);
			const indent = g.group ? "    " : "  ";
			for (const w of g.windows) {
				const reset = w.resetAtMs
					? `resets in ${formatCountdown(w.resetAtMs, nowMs)} (${formatResetClock(w.resetAtMs, nowMs)})`
					: "reset unknown";
				lines.push(
					`${indent}${w.label.padEnd(16)} ${formatPercent(w.usedPercent, true).padStart(6)} used  (${formatPercent(w.remainingPercent, true)} left)  · ${reset}`,
				);
			}
		}
	}
	return lines.join("\n");
}

export function summarizeAccountForStatus(acc: AccountUsage, nowMs = Date.now()): string {
	const windows = sortWindows(acc.windows)
		.map((w) => {
			const reset = w.resetAtMs ? ` (${formatCountdown(w.resetAtMs, nowMs)})` : "";
			return `${w.group ? `${shortenGroupName(w.group)} ` : ""}${w.label} ${formatPercent(w.usedPercent)}${reset}`;
		})
		.join(", ");
	return `${formatProviderTitle(acc.provider)} ${acc.account}: ${windows || acc.error || "no data"}`;
}
