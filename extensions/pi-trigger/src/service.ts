// pi.trigger.v1: how the pi-remote bridge hands events from the hub in pi-hostd to this extension
// (bridge op "trigger_deliver"; see extensions/pi-remote/packages/bridge/src/ops.ts).
import type { ExternalItem, TriggerRuntime } from "./runtime.js";

export const TRIGGER_SYMBOL = Symbol.for("pi.trigger.v1");

export interface TriggerService {
	readonly version: 1;
	/**
	 * Queues events for the session open in this process. Returns the keys now held by pi-trigger
	 * (new, already pending or already delivered); the hub keeps and retries the others. Throws an
	 * error with `code` "not_found" or "replacing" when `sessionFile` is not the open session.
	 */
	accept(sessionFile: string, items: ExternalItem[]): { accepted: string[] };
}

export function registerTriggerService(runtime: TriggerRuntime): () => void {
	const service: TriggerService = { version: 1, accept: (sessionFile, items) => runtime.accept(sessionFile, items) };
	const registry = globalThis as unknown as Record<symbol, TriggerService | undefined>;
	registry[TRIGGER_SYMBOL] = service;
	return () => {
		if (registry[TRIGGER_SYMBOL] === service) delete registry[TRIGGER_SYMBOL];
	};
}
