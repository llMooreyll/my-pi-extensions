/**
 * Response speed measured as decode throughput.
 *
 * The clock starts at the first streamed delta, not at `message_start`: Pi emits
 * `message_start` once the provider returns response headers, so timing from it
 * folds prefill and queueing (time to first token) into the rate and makes long
 * contexts look slow. Time to first token is reported separately instead.
 */

export interface SpeedSnapshot {
	tokensPerSecond?: number;
	/** Time from the provider request (or response start) to the first streamed delta. */
	ttftMs?: number;
	/** True while the value is a live estimate for the response being streamed. */
	live: boolean;
}

export interface CompletedUsage {
	output?: number;
	reasoning?: number;
}

interface SpeedSample {
	tokens: number;
	durationMs: number;
}

/** Completed responses kept per model; older samples age out. */
const SAMPLE_WINDOW = 8;
/** Shorter decode windows are dominated by chunk timing rather than generation speed. */
const MIN_DECODE_MS = 300;
/** Tool-call-only replies with a handful of tokens carry no useful rate. */
const MIN_SAMPLE_TOKENS = 16;
/** A live estimate needs some streaming history before it is shown. */
const MIN_LIVE_MS = 500;

export class ResponseSpeedTracker {
	private readonly samples = new Map<string, SpeedSample[]>();
	private modelKey = "";
	private requestAt?: number;
	private startAt?: number;
	private firstDeltaAt?: number;
	private lastDeltaAt?: number;
	private liveTokens = 0;
	private sawThinkingDelta = false;
	private inProgress = false;
	private lastTtftMs?: number;

	setModel(key: string): void {
		if (key === this.modelKey) return;
		this.modelKey = key;
		this.lastTtftMs = undefined;
		this.clearResponse();
	}

	markRequest(now: number): void {
		this.requestAt = now;
	}

	start(now: number): void {
		// before_provider_request fires before message_start; keep its timestamp.
		const requestAt = this.requestAt;
		this.clearResponse();
		this.requestAt = requestAt;
		this.inProgress = true;
		this.startAt = now;
	}

	delta(kind: "text" | "thinking" | "toolcall", text: string, now: number): void {
		if (!this.inProgress) return;
		if (this.firstDeltaAt === undefined) {
			this.firstDeltaAt = now;
			const origin = this.requestAt ?? this.startAt;
			if (origin !== undefined) this.lastTtftMs = Math.max(0, now - origin);
		}
		this.lastDeltaAt = now;
		this.liveTokens += estimateTokens(text);
		if (kind === "thinking") this.sawThinkingDelta = true;
	}

	finish(usage: CompletedUsage | undefined): void {
		if (!this.inProgress) return;
		const decodeMs =
			this.firstDeltaAt !== undefined && this.lastDeltaAt !== undefined ? this.lastDeltaAt - this.firstDeltaAt : 0;
		let tokens = usage?.output && usage.output > 0 ? usage.output : Math.round(this.liveTokens);
		// Reasoning that was generated but never streamed happened before the first
		// visible delta, outside the decode window; counting it would inflate the rate.
		if (!this.sawThinkingDelta && usage?.reasoning && usage.reasoning > 0) {
			tokens = Math.max(0, tokens - usage.reasoning);
		}
		if (tokens >= MIN_SAMPLE_TOKENS && decodeMs >= MIN_DECODE_MS) {
			const list = this.samples.get(this.modelKey) ?? [];
			list.push({ tokens, durationMs: decodeMs });
			if (list.length > SAMPLE_WINDOW) list.splice(0, list.length - SAMPLE_WINDOW);
			this.samples.set(this.modelKey, list);
		}
		this.clearResponse();
	}

	/** Drops an unfinished response, e.g. after an abort or error. */
	cancel(): void {
		this.clearResponse();
	}

	reset(): void {
		this.samples.clear();
		this.lastTtftMs = undefined;
		this.clearResponse();
	}

	snapshot(): SpeedSnapshot {
		if (
			this.inProgress &&
			this.firstDeltaAt !== undefined &&
			this.lastDeltaAt !== undefined &&
			this.lastDeltaAt - this.firstDeltaAt >= MIN_LIVE_MS &&
			this.liveTokens > 0
		) {
			return {
				tokensPerSecond: this.liveTokens / ((this.lastDeltaAt - this.firstDeltaAt) / 1000),
				ttftMs: this.lastTtftMs,
				live: true,
			};
		}

		const list = this.samples.get(this.modelKey) ?? [];
		let tokens = 0;
		let durationMs = 0;
		for (const sample of list) {
			tokens += sample.tokens;
			durationMs += sample.durationMs;
		}
		return {
			tokensPerSecond: durationMs > 0 ? tokens / (durationMs / 1000) : undefined,
			ttftMs: this.lastTtftMs,
			live: false,
		};
	}

	private clearResponse(): void {
		this.requestAt = undefined;
		this.startAt = undefined;
		this.firstDeltaAt = undefined;
		this.lastDeltaAt = undefined;
		this.liveTokens = 0;
		this.sawThinkingDelta = false;
		this.inProgress = false;
	}
}

/**
 * Rough token estimate for live display only. CJK text is close to one token per
 * character for current tokenizers; the old `length / 4` rule undercounted it
 * several times over.
 */
export function estimateTokens(text: string): number {
	let cjk = 0;
	let other = 0;
	for (const character of text) {
		if (isCjk(character.codePointAt(0) ?? 0)) cjk++;
		else other++;
	}
	return cjk * 0.75 + other / 4;
}

function isCjk(codePoint: number): boolean {
	return (
		(codePoint >= 0x3000 && codePoint <= 0x9fff) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7af) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xff00 && codePoint <= 0xffef) ||
		(codePoint >= 0x20000 && codePoint <= 0x2fa1f)
	);
}
