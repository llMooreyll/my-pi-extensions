/** Number and time formatting shared by all pages. Output is ASCII so widths are predictable. */

export function fmtTokens(n: number): string {
	if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
	return String(Math.round(n));
}

export function fmtCost(usd: number): string {
	if (usd >= 1000) return `$${Math.round(usd).toLocaleString("en-US")}`;
	if (usd >= 100) return `$${usd.toFixed(0)}`;
	if (usd >= 10) return `$${usd.toFixed(1)}`;
	return `$${usd.toFixed(2)}`;
}

export function fmtInt(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

export function fmtPct(ratio: number, digits = 0): string {
	return `${(ratio * 100).toFixed(digits)}%`;
}

/** 950ms, 12s, 3m 05s, 2h 10m, 3d 4h. */
export function fmtDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
	return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function fmtMinutes(min: number): string {
	if (min < 60) return `${Math.round(min)}m`;
	return `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, "0")}m`;
}

/** Compact relative time, always one of "now", "5m ago", "3h ago", "12d ago". */
export function fmtAgo(t: number, now = Date.now()): string {
	const d = Math.max(0, now - t);
	if (d < 60_000) return "now";
	if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
	if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
	return `${Math.floor(d / 86_400_000)}d ago`;
}

export function fmtDate(t: number): string {
	const d = new Date(t);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function fmtDateTime(t: number): string {
	const d = new Date(t);
	return `${fmtDate(t)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "claude-vps/claude-opus-5-5" → "claude-opus-5-5". */
export function shortModel(m: string): string {
	const i = m.indexOf("/");
	return i >= 0 ? m.slice(i + 1) : m;
}
