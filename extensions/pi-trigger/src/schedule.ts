import type { Timer, TimerSchedule } from "./state.js";

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const DAY_MS = 86_400_000;
/** A run missed by less than this still fires when catchUp is "skip" (tick delay, short sleep). */
export const LATE_GRACE_MS = 2 * 60_000;

/** "30m", "1h30m", "2d", "45s" → milliseconds. */
export function parseDuration(text: string): number {
	const compact = text.trim().toLowerCase().replace(/\s+/g, "");
	if (!/^(\d+(\.\d+)?[smhd])+$/.test(compact)) {
		throw new Error(`invalid duration "${text}"; use forms like 45s, 30m, 1h30m, 2d`);
	}
	let total = 0;
	for (const match of compact.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)) total += Number(match[1]) * UNIT_MS[match[2]!]!;
	if (total <= 0) throw new Error(`duration "${text}" must be positive`);
	return Math.round(total);
}

function parseClock(text: string): { hours: number; minutes: number } {
	const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
	const hours = match ? Number(match[1]) : Number.NaN;
	const minutes = match ? Number(match[2]) : Number.NaN;
	if (!(hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59)) throw new Error(`invalid time "${text}"; use HH:MM`);
	return { hours, minutes };
}

/** Next local occurrence of "HH:MM" strictly after `after`. */
export function nextDaily(time: string, after: number): number {
	const { hours, minutes } = parseClock(time);
	const at = new Date(after);
	at.setHours(hours, minutes, 0, 0);
	while (at.getTime() <= after) at.setDate(at.getDate() + 1);
	return at.getTime();
}

/** ISO date-time, or "HH:MM" for its next local occurrence. */
export function parseAt(text: string, now: number): number {
	if (/^\d{1,2}:\d{2}$/.test(text.trim())) return nextDaily(text.trim(), now);
	const at = Date.parse(text);
	if (!Number.isFinite(at)) throw new Error(`invalid time "${text}"; use an ISO date-time like 2026-11-24T09:00 or HH:MM`);
	if (at <= now) throw new Error(`time "${text}" is in the past`);
	return at;
}

export function normalizeClock(text: string): string {
	const { hours, minutes } = parseClock(text);
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Nominal spacing of runs; undefined for one-shot timers. */
export function periodMs(schedule: TimerSchedule): number | undefined {
	if (schedule.kind === "every") return schedule.everyMs;
	if (schedule.kind === "daily") return DAY_MS;
	return undefined;
}

/** First fire time after `now` for a repeating schedule, continuing from `from`. */
export function nextAfter(schedule: TimerSchedule, from: number, now: number): number | undefined {
	if (schedule.kind === "once") return undefined;
	if (schedule.kind === "daily") return nextDaily(schedule.time, Math.max(from, now));
	const missed = Math.floor((now - from) / schedule.everyMs) + 1;
	return from + Math.max(1, missed) * schedule.everyMs;
}

export function describeSchedule(schedule: TimerSchedule): string {
	if (schedule.kind === "once") return `once at ${formatClockTime(schedule.at)}`;
	if (schedule.kind === "every") return `every ${formatDuration(schedule.everyMs)}`;
	return `daily at ${schedule.time}`;
}

export function describeTimer(timer: Timer, now: number): string {
	const runs = timer.maxRuns ? `${timer.runs}/${timer.maxRuns} runs` : `${timer.runs} runs`;
	const expiry = timer.expiresAt ? `, expires ${formatClockTime(timer.expiresAt)}` : "";
	const flags = [timer.wake ? "wake" : "", timer.whenBusy === "skip" ? "skip when busy" : "", timer.catchUp === "skip" ? "no catch-up" : ""]
		.filter(Boolean)
		.join(", ");
	return `${timer.id}: ${describeSchedule(timer.schedule)}, next ${formatClockTime(timer.nextFireAt)} (in ${formatDuration(timer.nextFireAt - now)}), ${runs}${expiry}${flags ? `, ${flags}` : ""}\n  ${oneLine(timer.prompt, 160)}`;
}

/** "12m", "1h05m", "3d4h", "<1m". */
export function formatDuration(ms: number): string {
	if (ms < 60_000) return ms < 1000 ? "<1s" : `${Math.round(ms / 1000)}s`;
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
	return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** Local "HH:MM" today, otherwise "MM-DD HH:MM". */
export function formatClockTime(time: number): string {
	const d = new Date(time);
	const clock = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	const today = new Date();
	if (d.toDateString() === today.toDateString()) return clock;
	return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${clock}`;
}

export function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
