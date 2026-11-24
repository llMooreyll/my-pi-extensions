import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cacheTimer, SEND_SOURCE } from "./cache-timer.js";
import { defaultConfig, loadConfig, type TriggerConfig } from "./config.js";
import { formatClockTime, formatDuration, LATE_GRACE_MS, nextAfter, oneLine } from "./schedule.js";
import {
	DELIVERED_LIMIT,
	loadState,
	localDay,
	otherStates,
	PENDING_LIMIT,
	type PendingItem,
	type SessionState,
	saveState,
	type Timer,
} from "./state.js";

export const MESSAGE_TYPE = "trigger";
export const INTERNAL_COMMAND = "pi-trigger-internal";
const WIDGET_KEY = "trigger";
const TICK_MS = 15_000;
const MAX_BATCH = 20;
const RETRY_AFTER_ERROR_MS = 60_000;
const COMMAND_START_TIMEOUT_MS = 30_000;
/** Pi keeps an idle cache warm for at most this long. */
const WARMING_WINDOW_MS = 30 * 60_000;

export interface TriggerMessageItem {
	key: string;
	kind: "timer" | "event";
	label: string;
	title: string;
	route?: string;
	run?: number;
	maxRuns?: number;
	at: number;
}

export interface TriggerMessageDetails {
	items: TriggerMessageItem[];
	allowedTools?: string[];
}

/** An event the trigger hub in pi-hostd delivers through the pi-remote bridge. */
export interface ExternalItem {
	key: string;
	source: string;
	kind: string;
	route: string;
	title: string;
	body: string;
	receivedAt: number;
	allowedTools?: string[];
}

/** Error with a pi-remote error code, so the bridge reports it to the hub as is. */
export class CodedError extends Error {
	code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export class TriggerRuntime {
	config: TriggerConfig = defaultConfig();
	state: SessionState | undefined;
	private readonly pi: ExtensionAPI;
	private ctx: ExtensionContext | undefined;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private pumping = false;
	private pumpAgain = false;
	private blockedUntil = 0;
	private uiPromptOpen = false;
	/** Set from sending a trigger message until the run it started settles. */
	private activeRun: { allowedTools?: string[] } | undefined;
	private budgetNotifiedDay: string | undefined;
	private shownWidget: string | undefined;
	private lastDelivery: { at: number; title: string } | undefined;
	private readonly commandOps = new Map<string, (ctx: ExtensionCommandContext) => Promise<void>>();

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	get active(): boolean {
		return this.ctx !== undefined && this.state !== undefined;
	}

	// ---- lifecycle ----

	start(ctx: ExtensionContext): void {
		this.stop();
		// Timers need a long-lived interactive process; print and JSON runs exit after one prompt.
		if (!ctx.hasUI) return;
		const loaded = loadConfig();
		this.config = loaded.config;
		if (loaded.error) ctx.ui.notify(`pi-trigger: invalid config, using defaults: ${loaded.error}`, "warning");

		const sm = ctx.sessionManager;
		this.ctx = ctx;
		this.state = loadState(sm.getSessionId(), sm.getSessionFile(), ctx.cwd);
		this.checkAliasClaim();
		this.ticker = setInterval(() => this.tick(), TICK_MS);
		this.ticker.unref?.();
		// Fires timers that came due while the session was closed, then delivers what is pending.
		this.tick();
	}

	stop(): void {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
		try {
			this.ctx?.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// The context may already be stale during session replacement.
		}
		this.ctx = undefined;
		this.state = undefined;
		this.activeRun = undefined;
		this.uiPromptOpen = false;
		this.shownWidget = undefined;
		this.lastDelivery = undefined;
		this.blockedUntil = 0;
		this.commandOps.clear();
	}

	save(): void {
		if (!this.state) return;
		this.updateNextWake();
		try {
			saveState(this.state);
		} catch (error) {
			this.notify(`pi-trigger: could not save the trigger state: ${errorText(error)}`, "error");
		}
		this.renderWidget();
	}

	// ---- event hooks ----

	/** A run that pi-trigger did not start ends the restrictions and cost tracking of a trigger run. */
	onRunStart(startedByTrigger: boolean): void {
		if (!startedByTrigger) this.activeRun = undefined;
	}

	onSettled(): void {
		this.activeRun = undefined;
		this.renderWidget();
		this.schedulePump();
	}

	onUiPrompt(open: boolean): void {
		this.uiPromptOpen = open;
		if (!open) this.schedulePump();
	}

	/** Spending of runs started by triggers, for the daily budget. */
	onAssistantCost(usd: number): void {
		const s = this.state;
		if (!s || !this.activeRun || !(usd > 0)) return;
		this.rollDay();
		s.spent.usd += usd;
		this.save();
	}

	/** Block reason when a trigger run calls a tool its route does not allow. */
	blockedToolReason(toolName: string): string | undefined {
		const allowed = this.activeRun?.allowedTools;
		if (!allowed || allowed.includes(toolName)) return undefined;
		return `pi-trigger: the tool "${toolName}" is not allowed in this trigger run (allowed: ${allowed.join(", ") || "none"})`;
	}

	/**
	 * Keeps the cache warm until a timer that fires within Pi's warming window, when the refreshes
	 * cost less than the miss they avoid. Never stops warming: the user may come back sooner.
	 */
	warmingAction(warmCost: number, missCost: number): "warm" | undefined {
		const s = this.state;
		const ctx = this.ctx;
		if (!s || !ctx || s.paused || s.timers.length === 0) return undefined;
		const now = Date.now();
		const next = Math.min(...s.timers.map((t) => t.nextFireAt));
		const until = next - now;
		if (until <= 0 || until > WARMING_WINDOW_MS) return undefined;
		const ttl = cacheTimer()?.lifetimeMs(ctx);
		if (!ttl) return undefined;
		const refreshes = Math.max(1, Math.ceil(until / ttl));
		return refreshes * warmCost < missCost ? "warm" : undefined;
	}

	// ---- timers ----

	addTimer(timer: Timer): void {
		const s = this.requireState();
		s.timers.push(timer);
		this.save();
	}

	removeTimer(id: string): Timer | undefined {
		const s = this.requireState();
		const index = s.timers.findIndex((t) => t.id === id);
		if (index < 0) return undefined;
		const [removed] = s.timers.splice(index, 1);
		this.save();
		return removed;
	}

	/** Queues one run of a timer now without changing its schedule. */
	runTimerNow(id: string): boolean {
		const s = this.requireState();
		const timer = s.timers.find((t) => t.id === id);
		if (!timer) return false;
		timer.runs += 1;
		timer.lastFiredAt = Date.now();
		this.enqueue(timerItem(timer, Date.now()));
		if (timer.maxRuns !== undefined && timer.runs >= timer.maxRuns) s.timers = s.timers.filter((t) => t !== timer);
		this.save();
		this.schedulePump();
		return true;
	}

	private tick(): void {
		const s = this.state;
		if (!s || !this.ctx) return;
		const now = Date.now();
		let changed = false;
		this.rollDay();

		if (!s.paused) {
			for (const timer of [...s.timers]) {
				if (timer.expiresAt !== undefined && timer.expiresAt <= now) {
					s.timers = s.timers.filter((t) => t !== timer);
					changed = true;
					continue;
				}
				if (timer.nextFireAt > now) continue;

				const tooLate = timer.catchUp === "skip" && now - timer.nextFireAt > LATE_GRACE_MS;
				const busySkip = timer.whenBusy === "skip" && !this.isFree();
				if (!tooLate && !busySkip) {
					timer.runs += 1;
					timer.lastFiredAt = now;
					this.enqueue(timerItem(timer, now));
				}
				// Runs missed while the session was closed collapse into the one above.
				const next = nextAfter(timer.schedule, timer.nextFireAt, now);
				const finished =
					next === undefined ||
					(timer.maxRuns !== undefined && timer.runs >= timer.maxRuns) ||
					(timer.expiresAt !== undefined && next >= timer.expiresAt);
				if (finished) s.timers = s.timers.filter((t) => t !== timer);
				else timer.nextFireAt = next;
				changed = true;
			}
		}

		if (changed) this.save();
		else this.renderWidget();
		this.schedulePump();
	}

	private enqueue(item: PendingItem): void {
		const s = this.requireState();
		if (s.pending.some((p) => p.key === item.key)) return;
		if (s.pending.length >= PENDING_LIMIT) {
			this.notify(`pi-trigger: ${PENDING_LIMIT} triggers are already waiting; dropped "${item.title}"`, "warning");
			return;
		}
		s.pending.push(item);
	}

	private updateNextWake(): void {
		const s = this.state;
		if (!s) return;
		const wakes = s.timers.filter((t) => t.wake).map((t) => t.nextFireAt);
		if (wakes.length && !s.paused) s.nextWakeAt = Math.min(...wakes);
		else delete s.nextWakeAt;
	}

	// ---- external events (pi.trigger.v1 service) ----

	accept(sessionFile: string, items: ExternalItem[]): { accepted: string[] } {
		const s = this.state;
		if (!s || !this.ctx) throw new CodedError("replacing", "pi-trigger has no active session in this process");
		if (!s.sessionFile || !sameFile(s.sessionFile, sessionFile)) {
			throw new CodedError("not_found", "this process has a different session open now");
		}
		const accepted: string[] = [];
		for (const item of items) {
			if (!isExternalItem(item)) continue;
			if (s.delivered.includes(item.key) || s.pending.some((p) => p.key === item.key)) {
				accepted.push(item.key);
				continue;
			}
			// Leave the rest with the hub, which retries later.
			if (s.pending.length >= PENDING_LIMIT) break;
			s.pending.push({
				key: item.key,
				kind: "event",
				label: `${item.source}/${item.kind}`,
				title: item.title,
				body: item.body,
				at: item.receivedAt,
				route: item.route,
				...(item.allowedTools ? { allowedTools: item.allowedTools } : {}),
			});
			accepted.push(item.key);
		}
		this.save();
		this.schedulePump();
		return { accepted };
	}

	clearPending(): number {
		const s = this.requireState();
		const count = s.pending.length;
		s.delivered.push(...s.pending.map((p) => p.key));
		trimDelivered(s);
		s.pending = [];
		this.save();
		return count;
	}

	deliverNow(): void {
		this.blockedUntil = 0;
		this.budgetNotifiedDay = undefined;
		this.schedulePump();
	}

	// ---- delivery ----

	private isFree(): boolean {
		const ctx = this.ctx;
		return !!ctx && ctx.isIdle() && !ctx.hasPendingMessages() && !this.uiPromptOpen;
	}

	/** Never pump inside an event handler: commands and runs requested there wait for the handler. */
	schedulePump(): void {
		setTimeout(() => void this.pump(), 0);
	}

	private async pump(): Promise<void> {
		if (this.pumping) {
			this.pumpAgain = true;
			return;
		}
		const ctx = this.ctx;
		const s = this.state;
		if (!ctx || !s || s.paused || s.pending.length === 0) return;
		if (Date.now() < this.blockedUntil || !this.isFree() || !ctx.model) return;
		if (this.overBudget()) {
			const day = s.spent.day;
			if (this.budgetNotifiedDay !== day) {
				this.budgetNotifiedDay = day;
				this.notify(
					`pi-trigger: today's trigger budget ($${this.budget().toFixed(2)}) is used up; ${s.pending.length} trigger(s) wait until tomorrow or /trigger budget`,
					"warning",
				);
			}
			this.renderWidget();
			return;
		}

		this.pumping = true;
		this.renderWidget();
		try {
			const batch = takeBatch(s.pending);
			if (s.contextPolicy === "rebase") await this.rebaseToBase(ctx, s);
			if (this.ctx !== ctx) return;
			const prepared = await cacheTimer()?.prepareSend(ctx, { source: SEND_SOURCE, ...(s.sends ? { override: s.sends } : {}) });
			if (this.ctx !== ctx) return;
			if (prepared?.error !== undefined) this.notify(`pi-trigger: ${prepared.reason}; sending anyway`, "warning");
			// Otherwise the next rebase would return to the uncompacted base and compact it again.
			if (prepared?.compacted && s.contextPolicy === "rebase") {
				const leafId = ctx.sessionManager.getLeafId();
				if (leafId) s.baseEntryId = leafId;
			}
			// Something else started meanwhile (the user typed, another extension sent); retry after it settles.
			if (!this.isFree()) return;
			this.send(batch);
		} catch (error) {
			this.blockedUntil = Date.now() + RETRY_AFTER_ERROR_MS;
			this.notify(`pi-trigger: delivery failed, retrying in a minute: ${errorText(error)}`, "error");
		} finally {
			this.pumping = false;
			this.renderWidget();
			if (this.pumpAgain) {
				this.pumpAgain = false;
				this.schedulePump();
			}
		}
	}

	private send(batch: PendingItem[]): void {
		const s = this.requireState();
		const allowedTools = batch[0]?.allowedTools;
		const details: TriggerMessageDetails = {
			items: batch.map((item) => ({
				key: item.key,
				kind: item.kind,
				label: item.label,
				title: item.title,
				at: item.at,
				...(item.route ? { route: item.route } : {}),
				...(item.run !== undefined ? { run: item.run } : {}),
				...(item.maxRuns !== undefined ? { maxRuns: item.maxRuns } : {}),
			})),
			...(allowedTools ? { allowedTools } : {}),
		};
		this.activeRun = allowedTools ? { allowedTools } : {};
		this.pi.sendMessage<TriggerMessageDetails>(
			{ customType: MESSAGE_TYPE, content: composeMessage(batch, allowedTools), display: true, details },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		const keys = new Set(batch.map((item) => item.key));
		s.pending = s.pending.filter((item) => !keys.has(item.key));
		s.delivered.push(...keys);
		trimDelivered(s);
		const last = batch[batch.length - 1]!;
		this.lastDelivery = { at: Date.now(), title: last.title };
		this.save();
	}

	private async rebaseToBase(ctx: ExtensionContext, s: SessionState): Promise<void> {
		const base = s.baseEntryId;
		if (!base || !ctx.sessionManager.getEntry(base)) {
			this.notify("pi-trigger: the rebase base entry is missing; delivering on the current branch. Run /trigger policy rebase again.", "warning");
			return;
		}
		if (ctx.sessionManager.getLeafId() === base) return;
		await this.withCommandContext(async (cmd) => {
			const result = await cmd.navigateTree(base, { summarize: false });
			if (result.cancelled) throw new Error("another extension cancelled the tree navigation");
		});
	}

	/**
	 * navigateTree exists only on the command context; sending "/<internal command> <id>" runs our
	 * command handler with it (same approach as pi-remote's bridge).
	 */
	private withCommandContext(fn: (ctx: ExtensionCommandContext) => Promise<void>): Promise<void> {
		const id = randomUUID();
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.commandOps.delete(id)) reject(new Error("pi did not run the internal command"));
			}, COMMAND_START_TIMEOUT_MS);
			this.commandOps.set(id, async (cmd) => {
				clearTimeout(timer);
				try {
					await fn(cmd);
					resolve();
				} catch (error) {
					reject(error);
				}
			});
			try {
				this.pi.sendUserMessage(`/${INTERNAL_COMMAND} ${id}`, { expandPromptTemplates: true });
			} catch (error) {
				clearTimeout(timer);
				this.commandOps.delete(id);
				reject(error);
			}
		});
	}

	async runInternalCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const id = args.trim();
		const op = this.commandOps.get(id);
		if (!op) {
			ctx.ui.notify("pi-trigger: unknown or expired internal operation", "warning");
			return;
		}
		this.commandOps.delete(id);
		await op(ctx);
	}

	// ---- budget ----

	budget(): number {
		return this.state?.dailyBudgetUsd ?? this.config.dailyBudgetUsd;
	}

	private rollDay(): void {
		const s = this.state;
		if (!s) return;
		const today = localDay(Date.now());
		if (s.spent.day !== today) s.spent = { day: today, usd: 0 };
	}

	overBudget(): boolean {
		const s = this.state;
		if (!s) return false;
		this.rollDay();
		const budget = this.budget();
		return budget > 0 && s.spent.usd >= budget;
	}

	// ---- alias ----

	/** Drops this session's alias when another session claimed it later. */
	private checkAliasClaim(): void {
		const s = this.state;
		if (!s?.alias) return;
		const newer = otherStates(s.sessionId).find(
			(o) => o.alias === s.alias && (o.aliasSetAt ?? 0) > (s.aliasSetAt ?? 0) && !!o.sessionFile && existsSync(o.sessionFile),
		);
		if (!newer) return;
		this.notify(`pi-trigger: @${s.alias} now belongs to another session (${newer.sessionFile ?? newer.sessionId}); this session no longer receives its triggers`, "warning");
		delete s.alias;
		delete s.aliasSetAt;
		this.save();
	}

	// ---- widget ----

	renderWidget(): void {
		const ctx = this.ctx;
		const s = this.state;
		if (!ctx || !s) return;
		const theme = ctx.ui.theme;
		const now = Date.now();
		const lines: string[] = [];

		const head: string[] = [];
		if (s.alias) head.push(theme.fg("accent", `@${s.alias}`));
		if (s.contextPolicy === "rebase") head.push("rebase");
		if (s.sends) head.push(s.sends === "compact" ? "compact when cold" : "never compact");
		if (s.paused) head.push(theme.fg("warning", "paused"));
		const timers = [...s.timers].sort((a, b) => a.nextFireAt - b.nextFireAt);
		const next = timers[0];
		if (next) {
			const runs = next.maxRuns ? ` (${next.runs}/${next.maxRuns})` : "";
			head.push(`next ${next.id} in ${formatDuration(Math.max(0, next.nextFireAt - now))}${runs}`);
			if (timers.length > 1) head.push(`+${timers.length - 1} more`);
		}
		if (head.length) lines.push(`${theme.fg("dim", "trigger")} ${head.join(theme.fg("dim", " · "))}`);

		const inbox: string[] = [];
		if (s.pending.length) {
			const why = s.paused
				? "paused"
				: this.overBudget()
					? "budget used up"
					: this.pumping
						? "delivering"
						: "waiting for the current run";
			inbox.push(theme.fg("warning", `${s.pending.length} pending`) + theme.fg("dim", ` (${why})`));
		}
		if (this.lastDelivery) {
			inbox.push(theme.fg("dim", `last ${formatClockTime(this.lastDelivery.at)} ${oneLine(this.lastDelivery.title, 48)}`) + theme.fg("success", " ✓"));
		}
		if (inbox.length && (lines.length || s.pending.length)) lines.push(`${theme.fg("dim", "inbox")} ${inbox.join(theme.fg("dim", " · "))}`);

		const key = lines.join("\n");
		if (key === this.shownWidget) return;
		this.shownWidget = key;
		ctx.ui.setWidget(WIDGET_KEY, lines.length ? lines : undefined);
	}

	// ---- helpers ----

	requireState(): SessionState {
		if (!this.state) throw new Error("pi-trigger is inactive here: it needs an interactive pi session");
		return this.state;
	}

	notify(message: string, level: "info" | "warning" | "error"): void {
		try {
			this.ctx?.ui.notify(message, level);
		} catch {
			// Stale context.
		}
	}
}

function timerItem(timer: Timer, now: number): PendingItem {
	return {
		key: `timer:${timer.id}:${timer.createdAt}:${timer.runs}`,
		kind: "timer",
		label: timer.id,
		title: oneLine(timer.prompt, 80),
		body: timer.prompt,
		at: now,
		run: timer.runs,
		...(timer.maxRuns !== undefined ? { maxRuns: timer.maxRuns } : {}),
		repeating: timer.schedule.kind !== "once" && (timer.maxRuns === undefined || timer.runs < timer.maxRuns),
	};
}

/** Items sharing the first item's tool restriction, so one run never mixes restricted and free triggers. */
function takeBatch(pending: PendingItem[]): PendingItem[] {
	const signature = (item: PendingItem) => (item.allowedTools ? JSON.stringify([...item.allowedTools].sort()) : "*");
	const first = pending[0];
	if (!first) return [];
	const wanted = signature(first);
	return pending.filter((item) => signature(item) === wanted).slice(0, MAX_BATCH);
}

function composeMessage(batch: PendingItem[], allowedTools: string[] | undefined): string {
	const parts: string[] = [];
	if (batch.length > 1) parts.push(`[pi-trigger] ${batch.length} triggers fired. Handle each one in order.`);
	for (const item of batch) {
		const when = formatClockTime(item.at);
		if (item.kind === "timer") {
			const run = item.maxRuns ? `run ${item.run} of ${item.maxRuns}` : `run ${item.run}`;
			const hint = item.repeating
				? `This is a repeating wake-up you scheduled yourself. Cancel it with the schedule tool (action "cancel", id "${item.label}") once it is no longer needed.`
				: "This is the last run of a wake-up you scheduled yourself; the timer is already gone.";
			parts.push(`## Timer "${item.label}" (${run}, ${when})\n${item.body}\n\n${hint}`);
		} else {
			parts.push(`## Event ${item.label}${item.route ? ` via route "${item.route}"` : ""} (${when})\n${item.body}`);
		}
	}
	if (allowedTools) parts.push(`Tools allowed in this run: ${allowedTools.join(", ") || "none"}.`);
	return parts.join("\n\n");
}

function trimDelivered(s: SessionState): void {
	if (s.delivered.length > DELIVERED_LIMIT) s.delivered.splice(0, s.delivered.length - DELIVERED_LIMIT);
}

function sameFile(a: string, b: string): boolean {
	if (a === b) return true;
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

function isExternalItem(value: unknown): value is ExternalItem {
	const v = value as Partial<ExternalItem> | null;
	return (
		!!v &&
		typeof v.key === "string" &&
		typeof v.source === "string" &&
		typeof v.kind === "string" &&
		typeof v.route === "string" &&
		typeof v.title === "string" &&
		typeof v.body === "string" &&
		typeof v.receivedAt === "number" &&
		(v.allowedTools === undefined || (Array.isArray(v.allowedTools) && v.allowedTools.every((t) => typeof t === "string")))
	);
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
