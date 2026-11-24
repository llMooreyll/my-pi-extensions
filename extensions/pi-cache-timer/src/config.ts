import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface CacheTimerConfig {
	/** Ask before sending when the lost cached prefix has at least this many tokens. */
	minTokens: number;
	/** Or when re-billing that prefix is estimated to cost at least this many dollars more than a cache hit. */
	minExtraCost: number;
	/**
	 * Cache lifetime overrides in seconds, keyed by "provider/model" or "provider".
	 * 0 marks a durable cache (no countdown, no expiry prompt).
	 */
	ttlSeconds: Record<string, number>;
	/**
	 * What prepareSend does for messages other extensions send, keyed by the source name they pass
	 * (e.g. "pi-trigger"). Sources not listed are passed through unchanged.
	 */
	extensionSends: Record<string, SendPolicy>;
}

/** "pass": send as is; "compact": compact first when the expiry prompt would have been shown. */
export type SendPolicy = "pass" | "compact";
export const SEND_POLICIES: readonly SendPolicy[] = ["pass", "compact"];

export const CONFIG_FILENAME = "pi-cache-timer.json";

const DEFAULT_CONFIG: CacheTimerConfig = { minTokens: 50_000, minExtraCost: 0.2, ttlSeconds: {}, extensionSends: {} };

export interface LoadedConfig {
	config: CacheTimerConfig;
	/** Set when the file exists but could not be used; defaults apply. */
	error?: string;
}

export function loadConfig(): LoadedConfig {
	const path = join(getAgentDir(), CONFIG_FILENAME);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { config: defaultConfig() };
	}
	try {
		return { config: parseConfig(JSON.parse(text)) };
	} catch (error) {
		return { config: defaultConfig(), error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export function defaultConfig(): CacheTimerConfig {
	return { ...DEFAULT_CONFIG, ttlSeconds: {}, extensionSends: {} };
}

function parseConfig(raw: unknown): CacheTimerConfig {
	if (!isRecord(raw)) throw new Error("expected a JSON object");
	const config = defaultConfig();
	if (raw.minTokens !== undefined) config.minTokens = nonNegative(raw.minTokens, "minTokens");
	if (raw.minExtraCost !== undefined) config.minExtraCost = nonNegative(raw.minExtraCost, "minExtraCost");
	if (raw.ttlSeconds !== undefined) {
		if (!isRecord(raw.ttlSeconds)) throw new Error("ttlSeconds must be an object");
		for (const [key, value] of Object.entries(raw.ttlSeconds)) {
			config.ttlSeconds[key] = nonNegative(value, `ttlSeconds["${key}"]`);
		}
	}
	if (raw.extensionSends !== undefined) {
		if (!isRecord(raw.extensionSends)) throw new Error("extensionSends must be an object");
		for (const [key, value] of Object.entries(raw.extensionSends)) {
			if (!SEND_POLICIES.includes(value as SendPolicy)) {
				throw new Error(`extensionSends["${key}"] must be one of ${SEND_POLICIES.join(", ")}`);
			}
			config.extensionSends[key] = value as SendPolicy;
		}
	}
	return config;
}

function nonNegative(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${name} must be a non-negative number`);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
