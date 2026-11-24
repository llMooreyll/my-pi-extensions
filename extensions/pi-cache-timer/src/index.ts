import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import {
	type CacheAnchor,
	estimateCompactionCost,
	estimateMissCost,
	expiresAt,
	findCacheAnchor,
	isModelSwitched,
	resolveLifetime,
} from "./cache.js";
import { type CacheTimerConfig, defaultConfig, loadConfig } from "./config.js";
import { type CacheTimerService, registerCacheTimerService } from "./service.js";

/** statusline-pi draws this status on the editor's bottom border; without it Pi's footer shows it. */
const STATUS_KEY = "cache-timer";
const TICK_MS = 1000;
/** Show seconds only in the last minutes, so the status (also mirrored to pi-remote) changes once a minute before that. */
const SECONDS_BELOW_MS = 10 * 60_000;
const WARNING_BELOW_MS = 60_000;

const CHOICE_COMPACT = "compact";
const CHOICE_SEND = "send";

/** A request that would re-bill a large expired or unusable cached prefix. */
interface ColdSend {
	cached: CacheAnchor;
	switched: boolean;
	/** Dollars more than a cache hit; undefined when the model has no prices. */
	extraCost: number | undefined;
}

export default function piCacheTimer(pi: ExtensionAPI): void {
	// Read from disk on session_start; extension factories should not do work for sessions that never start.
	let config: CacheTimerConfig = defaultConfig();
	let timer: ReturnType<typeof setInterval> | undefined;
	// The anchor is recomputed only when the branch tip moves: new messages, cache warms,
	// compactions and tree navigation all append or switch entries.
	let anchorLeafId: string | null | undefined;
	let anchor: CacheAnchor | undefined;
	let shownStatus: string | undefined;

	function currentAnchor(ctx: ExtensionContext): CacheAnchor | undefined {
		const leafId = ctx.sessionManager.getLeafId();
		if (leafId !== anchorLeafId) {
			anchorLeafId = leafId;
			anchor = findCacheAnchor(ctx.sessionManager.getBranch());
		}
		return anchor;
	}

	function anchorModel(ctx: ExtensionContext, cached: CacheAnchor) {
		return ctx.modelRegistry.find(cached.provider, cached.model);
	}

	/** The expiry prompt's condition: cache expired or model changed, and the prefix is over a threshold. */
	function coldSend(ctx: ExtensionContext, model: Model<Api> | undefined, now: number): ColdSend | undefined {
		const cached = currentAnchor(ctx);
		if (!model || !cached) return undefined;

		const switched = isModelSwitched(cached, model);
		if (!switched) {
			const expiry = expiresAt(cached, resolveLifetime(cached, anchorModel(ctx, cached), config));
			if (expiry === undefined || now < expiry) return undefined;
		}

		// A new model never had this prefix cached, so it pays its own write rate; the observed
		// 1-hour retention only carries over within the same provider.
		const longRetention = cached.longRetention && model.provider === cached.provider;
		const extraCost = estimateMissCost(model, cached.tokens, longRetention);
		if (cached.tokens < config.minTokens && (extraCost ?? 0) < config.minExtraCost) return undefined;
		return { cached, switched, extraCost };
	}

	const service: CacheTimerService = {
		version: 1,
		async prepareSend(ctx, options) {
			const policy = options.override ?? config.extensionSends[options.source] ?? "pass";
			if (policy === "pass") return { policy, compacted: false, reason: "policy is pass" };
			if (!ctx.isIdle()) return { policy, compacted: false, reason: "Pi is busy, so the cache is in use" };
			const cold = coldSend(ctx, ctx.model, Date.now());
			if (!cold) return { policy, compacted: false, reason: "cache is warm or the context is below the thresholds" };

			const size = formatTokens(cold.cached.tokens);
			const why = cold.switched ? `model changed (${size} tokens)` : `cache expired (${size} tokens)`;
			if (ctx.hasUI) ctx.ui.notify(`${why}: compacting before the ${options.source} message`, "info");
			const failure = await new Promise<string | undefined>((resolve) => {
				try {
					ctx.compact({ onComplete: () => resolve(undefined), onError: (error) => resolve(error.message) });
				} catch (error) {
					resolve(error instanceof Error ? error.message : String(error));
				}
			});
			if (failure !== undefined) {
				return { policy, compacted: false, reason: `${why}; compaction failed: ${failure}`, error: failure };
			}
			return { policy, compacted: true, reason: `${why}; compacted` };
		},
		lifetimeMs(ctx) {
			const cached = currentAnchor(ctx);
			if (!cached) return undefined;
			const lifetime = resolveLifetime(cached, anchorModel(ctx, cached), config);
			return lifetime.kind === "timed" ? lifetime.ms : undefined;
		},
	};
	let unregisterService: (() => void) | undefined;

	function statusText(ctx: ExtensionContext, now: number): string | undefined {
		const cached = currentAnchor(ctx);
		if (!cached) return undefined;
		const theme = ctx.ui.theme;
		if (!ctx.isIdle()) return theme.fg("muted", "cache active");

		const size = formatTokens(cached.tokens);
		if (isModelSwitched(cached, ctx.model)) return theme.fg("error", `cache lost: model changed · ${size}`);

		const lifetime = resolveLifetime(cached, anchorModel(ctx, cached), config);
		const expiry = expiresAt(cached, lifetime);
		if (expiry === undefined) return theme.fg("dim", `cache durable · ${size}`);

		const remaining = expiry - now;
		if (remaining <= 0) return theme.fg("error", `cache expired ${formatMinutes(-remaining)} ago · ${size}`);
		return theme.fg(remaining <= WARNING_BELOW_MS ? "warning" : "success", `cache ${formatRemaining(remaining)}`);
	}

	function render(ctx: ExtensionContext): void {
		const text = statusText(ctx, Date.now());
		if (text === shownStatus) return;
		shownStatus = text;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function stopTimer(): void {
		if (timer) clearInterval(timer);
		timer = undefined;
	}

	pi.on("session_start", async (_event, ctx) => {
		stopTimer();
		anchorLeafId = undefined;
		anchor = undefined;
		shownStatus = undefined;
		unregisterService?.();
		unregisterService = registerCacheTimerService(service);
		if (!ctx.hasUI) return;

		const loaded = loadConfig();
		config = loaded.config;
		if (loaded.error) ctx.ui.notify(`pi-cache-timer: invalid config, using defaults: ${loaded.error}`, "warning");

		render(ctx);
		timer = setInterval(() => render(ctx), TICK_MS);
		timer.unref?.();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimer();
		unregisterService?.();
		unregisterService = undefined;
		anchorLeafId = undefined;
		anchor = undefined;
		shownStatus = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	// Immediate feedback for changes the next tick would otherwise show up to a second late.
	pi.on("model_select", async (_event, ctx) => {
		if (ctx.hasUI) render(ctx);
	});
	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.hasUI) render(ctx);
	});
	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.hasUI) render(ctx);
	});

	pi.on("input", async (event, ctx) => {
		// Only prompts typed while idle start a request whose cache state is decided now;
		// queued messages join a running agent that keeps the cache warm.
		if (event.source === "extension" || event.streamingBehavior || !ctx.hasUI) return;
		if (event.text.trimStart().startsWith("!")) return;

		const model = ctx.model;
		const now = Date.now();
		const cold = coldSend(ctx, model, now);
		if (!model || !cold) return;
		const { cached, switched, extraCost } = cold;

		const compactionCost = estimateCompactionCost(model, cached.tokens);
		const size = formatTokens(cached.tokens);
		const title = switched
			? `Model changed, the previous prompt cache is unusable: ${size} tokens will be billed again`
			: `Prompt cache expired (${formatMinutes(now - cached.touchedAt)} since the last request): ${size} tokens will be billed again`;
		const options = new Map<string, string>([
			[`Compact, then send${compactionCost === undefined ? "" : ` (compaction request ≈ ${formatDollars(compactionCost)})`}`, CHOICE_COMPACT],
			[`Send now${extraCost === undefined ? "" : ` (≈ ${formatDollars(extraCost)} more than a cache hit)`}`, CHOICE_SEND],
			["Cancel and put the message back in the editor", "cancel"],
		]);

		const picked = await ctx.ui.select(title, [...options.keys()]);
		const choice = picked === undefined ? undefined : options.get(picked);
		if (choice === CHOICE_SEND) return { action: "continue" };
		if (choice === CHOICE_COMPACT) {
			compactThenSend(pi, ctx, event);
			return { action: "handled" };
		}
		restoreInput(ctx, event, "Send cancelled", "info");
		return { action: "handled" };
	});
}

function compactThenSend(pi: ExtensionAPI, ctx: ExtensionContext, event: InputEvent): void {
	const content: string | (TextContent | ImageContent)[] = event.images?.length
		? [{ type: "text", text: event.text }, ...event.images]
		: event.text;
	ctx.ui.notify("Compacting the context; the message is sent when compaction finishes", "info");
	ctx.compact({
		onComplete: () => {
			// The input event saw the text before template and skill expansion; expand it the same way now.
			try {
				pi.sendUserMessage(content, { expandPromptTemplates: true });
			} catch (error) {
				restoreInput(ctx, event, `Send failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
		onError: (error) => restoreInput(ctx, event, `Compaction failed: ${error.message}`, "error"),
	});
}

/** Puts the prompt back into the editor unless the user already typed something new there. */
function restoreInput(ctx: ExtensionContext, event: InputEvent, reason: string, level: "info" | "error"): void {
	const editorText = ctx.ui.getEditorText();
	const restored = editorText.trim() === "";
	if (restored) ctx.ui.setEditorText(event.text);
	const where = restored
		? "the message is back in the editor"
		: "the editor is not empty, so the message was not put back";
	const images = event.images?.length ? "; attach the images again" : "";
	ctx.ui.notify(`${reason}; ${where}${images}`, level);
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}

/** `42m` while far from expiry, `9:59` in the last minutes. */
function formatRemaining(ms: number): string {
	const seconds = Math.ceil(ms / 1000);
	if (ms >= SECONDS_BELOW_MS) return `${Math.floor(seconds / 60)}m`;
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatMinutes(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function formatDollars(value: number): string {
	return `$${value.toFixed(value < 0.1 ? 3 : 2)}`;
}
