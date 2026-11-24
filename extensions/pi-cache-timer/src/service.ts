import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SendPolicy } from "./config.js";

/** Other extensions find the service on globalThis[Symbol.for("pi.cache-timer.v1")]. */
export const CACHE_TIMER_SYMBOL = Symbol.for("pi.cache-timer.v1");

export interface PrepareSendOptions {
	/** Name of the sending extension; looked up in the `extensionSends` config. */
	source: string;
	/** Per-session choice of the caller; replaces the configured policy when set. */
	override?: SendPolicy;
}

export interface PrepareSendResult {
	policy: SendPolicy;
	compacted: boolean;
	/** Short English explanation, suitable for logs and notifications. */
	reason: string;
	/** Set when compaction was attempted and failed; the caller decides whether to send anyway. */
	error?: string;
}

export interface CacheTimerService {
	readonly version: 1;
	/**
	 * Call while Pi is idle, right before sending a message that starts a run. With the "compact"
	 * policy and a cold cache over the configured thresholds, compacts first and resolves when the
	 * compaction has finished or failed. Never asks the user and never rejects.
	 */
	prepareSend(ctx: ExtensionContext, options: PrepareSendOptions): Promise<PrepareSendResult>;
	/** Lifetime of the current cache entry in milliseconds; undefined when unknown or durable. */
	lifetimeMs(ctx: ExtensionContext): number | undefined;
}

export function registerCacheTimerService(service: CacheTimerService): () => void {
	const registry = globalThis as unknown as Record<symbol, CacheTimerService | undefined>;
	registry[CACHE_TIMER_SYMBOL] = service;
	return () => {
		if (registry[CACHE_TIMER_SYMBOL] === service) delete registry[CACHE_TIMER_SYMBOL];
	};
}
