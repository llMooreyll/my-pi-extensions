import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TriggerRuntime } from "./runtime.js";
import { describeTimer, normalizeClock, parseAt, parseDuration, nextDaily } from "./schedule.js";
import type { Timer, TimerSchedule } from "./state.js";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MIN_ONCE_DELAY_MS = 60_000;
const DAY_MS = 86_400_000;

const parameters = Type.Object({
	action: StringEnum(["create", "list", "cancel", "update"] as const, {
		description: "create a timer, list this session's timers, cancel one, or update one",
	}),
	id: Type.Optional(
		Type.String({ description: "Timer id: lowercase letters, digits and dashes. Optional for create; required for cancel and update" }),
	),
	prompt: Type.Optional(
		Type.String({ description: "Instruction to yourself, delivered when the timer fires. Required for create" }),
	),
	in: Type.Optional(Type.String({ description: "Fire once after a delay, e.g. 20m, 1h30m" })),
	at: Type.Optional(Type.String({ description: "Fire once at a local time: ISO date-time (2026-11-24T09:00) or HH:MM" })),
	every: Type.Optional(Type.String({ description: "Fire repeatedly at this interval, e.g. 30m, 2h" })),
	daily: Type.Optional(Type.String({ description: "Fire every day at this local time, HH:MM" })),
	maxRuns: Type.Optional(Type.Integer({ minimum: 1, description: "Stop after this many runs" })),
	expiresIn: Type.Optional(Type.String({ description: "Delete the timer after this long, e.g. 3d. Repeating timers default to the configured expiry" })),
	whenBusy: Type.Optional(
		StringEnum(["queue", "skip"] as const, { description: "A run that comes due while you are working: queue it (default) or skip it" }),
	),
	catchUp: Type.Optional(
		StringEnum(["once", "skip"] as const, {
			description: "Runs missed while the session was closed: fire one catch-up run (default) or skip them",
		}),
	),
	wake: Type.Optional(
		Type.Boolean({ description: "Reopen this session through pi-hostd when the timer comes due while it is closed. Default false" }),
	),
});

type Params = {
	action: "create" | "list" | "cancel" | "update";
	id?: string;
	prompt?: string;
	in?: string;
	at?: string;
	every?: string;
	daily?: string;
	maxRuns?: number;
	expiresIn?: string;
	whenBusy?: "queue" | "skip";
	catchUp?: "once" | "skip";
	wake?: boolean;
};

export function registerScheduleTool(pi: ExtensionAPI, runtime: TriggerRuntime): void {
	pi.registerTool({
		name: "schedule",
		label: "Schedule",
		description:
			"Schedule wake-ups for yourself in this session. When a timer fires, its prompt arrives as a trigger message " +
			"and you handle it like a request. Use exactly one of in, at, every or daily for create.",
		promptSnippet: "Schedule your own wake-ups in this session (one-shot or repeating timers)",
		promptGuidelines: [
			"Use schedule when the user asks you to check, remind or repeat something later; write the prompt so that it is self-contained, because it may fire after compaction.",
			"Cancel timers made with schedule as soon as they are no longer needed.",
		],
		parameters,
		executionMode: "sequential",
		async execute(_toolCallId, rawParams) {
			const params = rawParams as Params;
			const now = Date.now();
			switch (params.action) {
				case "list":
					return text(listText(runtime, now));
				case "cancel": {
					const id = requireId(params.id);
					const removed = runtime.removeTimer(id);
					if (!removed) throw new Error(`no timer "${id}"; ${listText(runtime, now)}`);
					return text(`Cancelled timer ${id} after ${removed.runs} run(s).`);
				}
				case "create": {
					const state = runtime.requireState();
					if (!params.prompt?.trim()) throw new Error("prompt is required for create");
					if (state.timers.length >= runtime.config.maxTimers) {
						throw new Error(`this session already has ${state.timers.length} timers (limit ${runtime.config.maxTimers}); cancel one first`);
					}
					const id = params.id ? requireId(params.id) : freeId(state.timers);
					if (state.timers.some((t) => t.id === id)) throw new Error(`timer "${id}" exists; use update or another id`);
					const { schedule, nextFireAt } = scheduleFrom(params, runtime, now, true)!;
					const timer: Timer = {
						id,
						prompt: params.prompt.trim(),
						schedule,
						nextFireAt,
						runs: 0,
						whenBusy: params.whenBusy ?? "queue",
						catchUp: params.catchUp ?? "once",
						wake: params.wake ?? false,
						createdAt: now,
					};
					if (params.maxRuns !== undefined) timer.maxRuns = params.maxRuns;
					const expiresAt = expiryFrom(params.expiresIn, schedule, runtime, now);
					if (expiresAt !== undefined) timer.expiresAt = expiresAt;
					runtime.addTimer(timer);
					return text(`Created timer:\n${describeTimer(timer, now)}`);
				}
				case "update": {
					const state = runtime.requireState();
					const id = requireId(params.id);
					const timer = state.timers.find((t) => t.id === id);
					if (!timer) throw new Error(`no timer "${id}"; ${listText(runtime, now)}`);
					const next = scheduleFrom(params, runtime, now, false);
					if (params.prompt !== undefined) {
						if (!params.prompt.trim()) throw new Error("prompt must not be empty");
						timer.prompt = params.prompt.trim();
					}
					if (next) {
						timer.schedule = next.schedule;
						timer.nextFireAt = next.nextFireAt;
					}
					if (params.maxRuns !== undefined) timer.maxRuns = params.maxRuns;
					if (params.expiresIn !== undefined) timer.expiresAt = expiryFrom(params.expiresIn, timer.schedule, runtime, now);
					if (params.whenBusy !== undefined) timer.whenBusy = params.whenBusy;
					if (params.catchUp !== undefined) timer.catchUp = params.catchUp;
					if (params.wake !== undefined) timer.wake = params.wake;
					runtime.save();
					return text(`Updated timer:\n${describeTimer(timer, now)}`);
				}
				default:
					throw new Error(`unknown action ${String(params.action)}`);
			}
		},
	});
}

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: undefined };
}

function listText(runtime: TriggerRuntime, now: number): string {
	const timers = [...runtime.requireState().timers].sort((a, b) => a.nextFireAt - b.nextFireAt);
	if (timers.length === 0) return "This session has no timers.";
	return `Timers in this session:\n${timers.map((t) => describeTimer(t, now)).join("\n")}`;
}

function requireId(id: string | undefined): string {
	if (!id) throw new Error("id is required");
	if (!ID_PATTERN.test(id)) throw new Error(`invalid id "${id}": use lowercase letters, digits and dashes (max 40)`);
	return id;
}

function freeId(timers: Timer[]): string {
	for (let n = 1; ; n++) {
		const id = `timer-${n}`;
		if (!timers.some((t) => t.id === id)) return id;
	}
}

/** The schedule given by in/at/every/daily; undefined when none is given and `required` is false. */
function scheduleFrom(
	params: Params,
	runtime: TriggerRuntime,
	now: number,
	required: boolean,
): { schedule: TimerSchedule; nextFireAt: number } | undefined {
	const given = (["in", "at", "every", "daily"] as const).filter((key) => params[key] !== undefined);
	if (given.length === 0) {
		if (required) throw new Error("give exactly one of in, at, every or daily");
		return undefined;
	}
	if (given.length > 1) throw new Error(`give only one of in, at, every or daily (got ${given.join(", ")})`);

	if (params.in !== undefined) {
		const delay = parseDuration(params.in);
		if (delay < MIN_ONCE_DELAY_MS) throw new Error("in must be at least 1m");
		return { schedule: { kind: "once", at: now + delay }, nextFireAt: now + delay };
	}
	if (params.at !== undefined) {
		const at = parseAt(params.at, now);
		return { schedule: { kind: "once", at }, nextFireAt: at };
	}
	if (params.every !== undefined) {
		const everyMs = parseDuration(params.every);
		const minMs = runtime.config.minIntervalMinutes * 60_000;
		if (everyMs < minMs) throw new Error(`every must be at least ${runtime.config.minIntervalMinutes}m`);
		return { schedule: { kind: "every", everyMs }, nextFireAt: now + everyMs };
	}
	const time = normalizeClock(params.daily!);
	return { schedule: { kind: "daily", time }, nextFireAt: nextDaily(time, now) };
}

function expiryFrom(expiresIn: string | undefined, schedule: TimerSchedule, runtime: TriggerRuntime, now: number): number | undefined {
	const maxMs = runtime.config.maxExpiryDays * DAY_MS;
	if (expiresIn !== undefined) {
		const ms = parseDuration(expiresIn);
		if (ms > maxMs) throw new Error(`expiresIn must be at most ${runtime.config.maxExpiryDays}d`);
		return now + ms;
	}
	if (schedule.kind === "once") return undefined;
	return now + Math.min(runtime.config.defaultExpiryDays * DAY_MS, maxMs);
}
