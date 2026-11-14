export type QuotaWindowKind = "five_hour" | "weekly" | "other";

export interface QuotaWindow {
	id: string;
	label: string;
	group?: string;
	kind: QuotaWindowKind;
	usedPercent: number;
	remainingPercent: number;
	resetAtMs?: number;
	status?: string;
}

export interface AccountUsage {
	id: string;
	provider: string;
	account: string;
	authIndex?: string;
	projectId?: string;
	disabled: boolean;
	status?: string;
	windows: QuotaWindow[];
	error?: string;
	source: "live" | "signal" | "unavailable";
	fetchedAtMs: number;
}

export interface UsageSnapshot {
	serverName: string;
	serverUrl: string;
	fetchedAtMs: number;
	accounts: AccountUsage[];
	error?: string;
}

export interface CpaServerProfile {
	baseUrl: string;
	managementKey: string;
	label?: string;
}

export interface CpaUsageConfig {
	enabled: boolean;
	statusline: {
		enabled: boolean;
		refreshIntervalSec: number;
		showDisabled: boolean;
	};
	activeServer: string;
	servers: Record<string, CpaServerProfile>;
	cacheTtlSec: number;
	requestTimeoutMs: number;
}
