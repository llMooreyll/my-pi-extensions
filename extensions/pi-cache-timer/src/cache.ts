import { type Api, calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CacheTimerConfig } from "./config.js";

/** The prompt cache entry the next request on this branch would try to reuse. */
export interface CacheAnchor {
	/**
	 * Start of the latest request or cache refresh that touched the entry. Providers count the
	 * lifetime from request start, and an assistant message's timestamp is taken when its request starts.
	 */
	touchedAt: number;
	/** Prompt tokens of the latest real request: the prefix that is re-billed on a miss. */
	tokens: number;
	provider: string;
	model: string;
	/** The provider reported this model's latest cache write as 1-hour retention (Anthropic `cacheWrite1h`). */
	longRetention: boolean;
}

export type CacheLifetime = { kind: "timed"; ms: number } | { kind: "durable" };

/** Treat the entry as expired this long before its nominal lifetime ends: requests take time to reach the provider. */
export const EXPIRY_MARGIN_MS = 15_000;

/** Pi's default `compaction.keepRecentTokens`: the recent tail a compaction keeps verbatim. */
const KEEP_RECENT_TOKENS = 20_000;

/** Entries scanned back from the leaf for the model's cache retention and reporting. */
const SCAN_LIMIT = 500;

/**
 * Finds the cache entry left by the latest request on the branch. Returns undefined when nothing
 * reusable exists: no request yet, a compaction or branch summary replaced the prefix since, or the
 * model never reported cache activity (a countdown would mean nothing).
 */
export function findCacheAnchor(branch: readonly SessionEntry[]): CacheAnchor | undefined {
	const warms: Array<{ provider: string; model: string; at: number }> = [];
	let anchor: CacheAnchor | undefined;
	let reportedCache = false;
	let retentionKnown = false;

	for (let index = branch.length - 1, scanned = 0; index >= 0 && scanned < SCAN_LIMIT; index--, scanned++) {
		const entry = branch[index]!;
		if (entry.type === "compaction" || entry.type === "branch_summary") break;

		if (entry.type === "usage") {
			if (entry.kind !== "cache_warm") continue;
			if (!anchor) {
				const at = Date.parse(entry.timestamp);
				if (Number.isFinite(at)) warms.push({ provider: entry.provider, model: entry.model, at });
			}
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;

		const message = entry.message;
		const usage = message.usage;
		const tokens = usage.input + usage.cacheRead + usage.cacheWrite;
		if (tokens <= 0) continue;

		if (!anchor) {
			let touchedAt = message.timestamp;
			for (const warm of warms) {
				// Warm usage is recorded under the response model, which may carry a dated suffix.
				if (warm.provider === message.provider && warm.model.startsWith(message.model)) {
					touchedAt = Math.max(touchedAt, warm.at);
				}
			}
			anchor = { touchedAt, tokens, provider: message.provider, model: message.model, longRetention: false };
		}
		if (message.provider !== anchor.provider || message.model !== anchor.model) continue;

		if (usage.cacheRead + usage.cacheWrite > 0) reportedCache = true;
		if (!retentionKnown && usage.cacheWrite > 0) {
			anchor.longRetention = (usage.cacheWrite1h ?? 0) > 0;
			retentionKnown = true;
		}
		if (reportedCache && retentionKnown) break;
	}

	return anchor && reportedCache ? anchor : undefined;
}

/**
 * Cache lifetime of the anchor's entry: configured override, then the observed 1-hour retention,
 * then the model's declared `promptCache` tier, then defaults per model family.
 */
export function resolveLifetime(
	anchor: CacheAnchor,
	model: Model<Api> | undefined,
	config: CacheTimerConfig,
): CacheLifetime {
	const override = config.ttlSeconds[`${anchor.provider}/${anchor.model}`] ?? config.ttlSeconds[anchor.provider];
	if (override !== undefined) return override > 0 ? timed(override) : { kind: "durable" };
	if (anchor.longRetention) return timed(3600);

	// Same tier selection as Pi's getPromptCacheTtlMs for session requests.
	const tier = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
	const declared = model?.promptCache?.[tier];
	if (declared !== undefined && declared > 0) return timed(declared);

	// DeepSeek keeps its disk cache for hours to days without a fixed lifetime.
	if (/deepseek/i.test(anchor.model)) return { kind: "durable" };
	// GPT-5.6 and later default to a 30-minute minimum lifetime.
	if (/gpt-(5\.([6-9]|\d{2,})|[6-9])/i.test(anchor.model)) return timed(1800);
	return timed(300);
}

/** When the entry is considered gone, or undefined for durable caches. */
export function expiresAt(anchor: CacheAnchor, lifetime: CacheLifetime): number | undefined {
	return lifetime.kind === "timed" ? anchor.touchedAt + lifetime.ms - EXPIRY_MARGIN_MS : undefined;
}

/** Whether the next request goes to a different model than the one holding the cache. */
export function isModelSwitched(anchor: CacheAnchor, model: Model<Api> | undefined): boolean {
	return model !== undefined && (model.provider !== anchor.provider || model.id !== anchor.model);
}

/**
 * Extra dollars for sending `tokens` uncached instead of reading them from the cache, at `model`'s
 * rates. Undefined when the model has no prices.
 */
export function estimateMissCost(model: Model<Api>, tokens: number, longRetention: boolean): number | undefined {
	const rates = model.cost;
	if (!rates || (rates.input <= 0 && rates.cacheWrite <= 0)) return undefined;
	const missed = longRetention
		? price(model, { cacheWrite: tokens, cacheWrite1h: tokens })
		: rates.cacheWrite > 0
			? price(model, { cacheWrite: tokens })
			: price(model, { input: tokens });
	return Math.max(0, missed - price(model, { cacheRead: tokens }));
}

/**
 * Input cost of the summarization request: compaction sends the older part of the conversation as
 * new text, so it never reads the conversation cache. Undefined when the model has no prices.
 */
export function estimateCompactionCost(model: Model<Api>, tokens: number): number | undefined {
	if (!model.cost || model.cost.input <= 0) return undefined;
	return price(model, { input: Math.max(0, tokens - KEEP_RECENT_TOKENS) });
}

function timed(seconds: number): CacheLifetime {
	return { kind: "timed", ms: seconds * 1000 };
}

function price(model: Model<Api>, tokens: Partial<Omit<Usage, "cost">>): number {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...tokens,
	};
	return calculateCost(model, usage).total;
}
