import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CpaServerProfile, CpaUsageConfig } from "./types.js";

export const DEFAULT_CONFIG_FILENAME = "cpa-usage.json";
export const DEFAULT_CACHE_TTL_SEC = 30;
export const DEFAULT_REFRESH_INTERVAL_SEC = 180;
export const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;

export function getAgentDir(): string {
	const custom = process.env.PI_CODING_AGENT_DIR?.trim();
	if (custom) return custom;
	return join(homedir(), ".pi", "agent");
}

export function getConfigPath(): string {
	const override = process.env.CPA_USAGE_CONFIG?.trim();
	if (override) return override;
	return join(getAgentDir(), DEFAULT_CONFIG_FILENAME);
}

export function createDefaultConfig(): CpaUsageConfig {
	return {
		enabled: true,
		statusline: {
			enabled: false,
			refreshIntervalSec: DEFAULT_REFRESH_INTERVAL_SEC,
			showDisabled: false,
		},
		activeServer: "",
		servers: {},
		cacheTtlSec: DEFAULT_CACHE_TTL_SEC,
		requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
	};
}

export function normalizeBaseUrl(url: string): string {
	return url.trim().replace(/\/+$/, "");
}

export function normalizeConfig(raw: unknown): CpaUsageConfig {
	const base = createDefaultConfig();
	if (!raw || typeof raw !== "object") return base;
	const obj = raw as Record<string, unknown>;

	const enabled = typeof obj.enabled === "boolean" ? obj.enabled : base.enabled;
	const cacheTtlSec =
		typeof obj.cacheTtlSec === "number" && Number.isFinite(obj.cacheTtlSec) && obj.cacheTtlSec >= 0
			? obj.cacheTtlSec
			: base.cacheTtlSec;
	const requestTimeoutMs =
		typeof obj.requestTimeoutMs === "number" && Number.isFinite(obj.requestTimeoutMs) && obj.requestTimeoutMs >= 1000
			? obj.requestTimeoutMs
			: base.requestTimeoutMs;

	const rawSl = obj.statusline && typeof obj.statusline === "object" ? (obj.statusline as Record<string, unknown>) : {};
	const statusline = {
		enabled: typeof rawSl.enabled === "boolean" ? rawSl.enabled : base.statusline.enabled,
		refreshIntervalSec:
			typeof rawSl.refreshIntervalSec === "number" &&
			Number.isFinite(rawSl.refreshIntervalSec) &&
			rawSl.refreshIntervalSec >= 15
				? rawSl.refreshIntervalSec
				: base.statusline.refreshIntervalSec,
		showDisabled: typeof rawSl.showDisabled === "boolean" ? rawSl.showDisabled : base.statusline.showDisabled,
	};

	const servers: Record<string, CpaServerProfile> = {};
	if (obj.servers && typeof obj.servers === "object") {
		for (const [name, entry] of Object.entries(obj.servers as Record<string, unknown>)) {
			const cleanName = name.trim();
			if (!cleanName || !entry || typeof entry !== "object") continue;
			const item = entry as Record<string, unknown>;
			const baseUrl = typeof item.baseUrl === "string" ? normalizeBaseUrl(item.baseUrl) : "";
			const managementKey = typeof item.managementKey === "string" ? item.managementKey.trim() : "";
			const label = typeof item.label === "string" && item.label.trim() ? item.label.trim() : undefined;
			if (!baseUrl) continue;
			servers[cleanName] = { baseUrl, managementKey, ...(label ? { label } : {}) };
		}
	}

	let activeServer = typeof obj.activeServer === "string" ? obj.activeServer.trim() : "";
	if (!activeServer || !servers[activeServer]) {
		activeServer = Object.keys(servers)[0] ?? "";
	}

	return {
		enabled,
		statusline,
		activeServer,
		servers,
		cacheTtlSec,
		requestTimeoutMs,
	};
}

export function loadConfig(configPath = getConfigPath()): CpaUsageConfig {
	if (!existsSync(configPath)) return createDefaultConfig();
	try {
		const raw = readFileSync(configPath, "utf8");
		return normalizeConfig(JSON.parse(raw));
	} catch {
		return createDefaultConfig();
	}
}

export function saveConfig(config: CpaUsageConfig, configPath = getConfigPath()): void {
	const normalized = normalizeConfig(config);
	const dir = dirname(configPath);
	mkdirSync(dir, { recursive: true });
	const tmpPath = `${configPath}.tmp.${process.pid}`;
	writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	chmodSync(tmpPath, 0o600);
	renameSync(tmpPath, configPath);
}

export function resolveSecret(rawValue: string): string {
	const trimmed = rawValue.trim();
	if (trimmed.startsWith("env:")) {
		const envName = trimmed.slice(4).trim();
		return envName ? (process.env[envName]?.trim() ?? "") : "";
	}
	return trimmed;
}

export function maskSecret(rawValue: string): string {
	const trimmed = rawValue.trim();
	if (!trimmed) return "(not set)";
	if (trimmed.startsWith("env:")) return trimmed;
	if (trimmed.length <= 8) return "****";
	return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

export interface ResolvedServer {
	name: string;
	baseUrl: string;
	managementKey: string;
	label?: string;
}

export function resolveActiveServer(config: CpaUsageConfig): ResolvedServer | undefined {
	const envUrl = process.env.CPA_USAGE_SERVER_URL?.trim();
	const envKey = process.env.CPA_USAGE_MANAGEMENT_KEY?.trim();
	if (envUrl) {
		return {
			name: "env",
			baseUrl: normalizeBaseUrl(envUrl),
			managementKey: envKey ?? "",
			label: "Environment Override",
		};
	}

	const key = config.activeServer || Object.keys(config.servers)[0];
	if (!key) return undefined;
	const profile = config.servers[key];
	if (!profile) return undefined;
	return {
		name: key,
		baseUrl: normalizeBaseUrl(profile.baseUrl),
		managementKey: resolveSecret(profile.managementKey),
		label: profile.label,
	};
}
