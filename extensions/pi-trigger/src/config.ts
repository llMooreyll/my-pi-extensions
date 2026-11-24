import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Limits for timers the agent creates and for unattended runs; `~/.pi/agent/pi-trigger.json`. */
export interface TriggerConfig {
	/** Shortest interval of an `every` timer. */
	minIntervalMinutes: number;
	/** Active timers per session. */
	maxTimers: number;
	/** Repeating timers without an explicit expiry stop after this many days. */
	defaultExpiryDays: number;
	/** Longest expiry the agent may set. */
	maxExpiryDays: number;
	/** Spending limit per session and day for runs started by triggers; 0 means no limit. */
	dailyBudgetUsd: number;
}

export const CONFIG_FILENAME = "pi-trigger.json";

export function defaultConfig(): TriggerConfig {
	return { minIntervalMinutes: 5, maxTimers: 10, defaultExpiryDays: 7, maxExpiryDays: 30, dailyBudgetUsd: 5 };
}

export interface LoadedConfig {
	config: TriggerConfig;
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
		const raw: unknown = JSON.parse(text);
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("expected a JSON object");
		const config = defaultConfig();
		for (const key of Object.keys(config) as (keyof TriggerConfig)[]) {
			const value = (raw as Record<string, unknown>)[key];
			if (value === undefined) continue;
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
				throw new Error(`${key} must be a non-negative number`);
			}
			config[key] = value;
		}
		if (config.maxTimers < 1) throw new Error("maxTimers must be at least 1");
		return { config };
	} catch (error) {
		return { config: defaultConfig(), error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
}
