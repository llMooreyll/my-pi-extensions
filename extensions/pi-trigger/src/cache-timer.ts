// Contract with pi-cache-timer (globalThis[Symbol.for("pi.cache-timer.v1")]); see
// extensions/pi-cache-timer/src/service.ts. pi-trigger works without it and then sends as is.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SendPolicy = "pass" | "compact";
export const SEND_POLICIES: readonly SendPolicy[] = ["pass", "compact"];

/** Source name pi-trigger passes; the key in pi-cache-timer's `extensionSends` config. */
export const SEND_SOURCE = "pi-trigger";

const CACHE_TIMER_SYMBOL = Symbol.for("pi.cache-timer.v1");

interface CacheTimerService {
	readonly version: 1;
	prepareSend(
		ctx: ExtensionContext,
		options: { source: string; override?: SendPolicy },
	): Promise<{ policy: SendPolicy; compacted: boolean; reason: string; error?: string }>;
	lifetimeMs(ctx: ExtensionContext): number | undefined;
}

export function cacheTimer(): CacheTimerService | undefined {
	const service = (globalThis as unknown as Record<symbol, CacheTimerService | undefined>)[CACHE_TIMER_SYMBOL];
	return service?.version === 1 ? service : undefined;
}
