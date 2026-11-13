import { matchesKey } from "@earendil-works/pi-tui";
import { type DayStats, hourOfDay, hourWeekday, streaks } from "../../../index/aggregate.ts";
import { dayKey } from "../../../index/query.ts";
import type { Surface } from "../../../term/canvas.ts";
import { strWidth } from "../../../term/width.ts";
import type { App } from "../../app.ts";
import { bigNumber, calendarHeat, type ChartCtx, heatGrid, polar24, vbars } from "../../charts/index.ts";
import { fmtCost, fmtMinutes, fmtTokens } from "../../format.ts";
import { type AnalyticsData, allDaily, cached, drillDay, GridPage, type Row, shiftDay } from "./layout.ts";

type Metric = "SESSIONS" | "TOKENS" | "COST" | "MINUTES";
const METRICS: Metric[] = ["SESSIONS", "TOKENS", "COST", "MINUTES"];

const metricValue = (m: Metric, d: DayStats): number =>
	m === "SESSIONS" ? d.sessions.size : m === "TOKENS" ? d.input + d.output + d.cacheRead + d.cacheWrite : m === "COST" ? d.cost + d.warmCost : d.activeMinutes;

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const BUCKETS: { label: string; max: number }[] = [
	{ label: "0-5m", max: 5 },
	{ label: "5-15m", max: 15 },
	{ label: "15-30", max: 30 },
	{ label: "30-60", max: 60 },
	{ label: "1-2h", max: 120 },
	{ label: "2-4h", max: 240 },
	{ label: "4h+", max: Number.POSITIVE_INFINITY },
];

interface Badge {
	name: string;
	pct: number;
}

/** Day-type badge from the hour/weekday call distribution; first match in the listed order. */
function dayBadge(grid: number[][]): Badge {
	let total = 0;
	let night = 0;
	let early = 0;
	let weekend = 0;
	let office = 0;
	grid.forEach((row, wd) => {
		row.forEach((n, h) => {
			total += n;
			if (h < 5) night += n;
			else if (h < 9) early += n;
			if (wd >= 5) weekend += n;
			if (wd < 5 && h >= 9 && h < 18) office += n;
		});
	});
	if (total === 0) return { name: "BALANCED", pct: 0 };
	const r = (n: number): number => Math.round((n / total) * 100);
	if (night / total >= 0.25) return { name: "NIGHT OWL", pct: r(night) };
	if (early / total >= 0.25) return { name: "EARLY BIRD", pct: r(early) };
	if (weekend / total >= 0.35) return { name: "WEEKEND WARRIOR", pct: r(weekend) };
	if (office / total >= 0.6) return { name: "OFFICE HOURS", pct: r(office) };
	return { name: "BALANCED", pct: 0 };
}

export class TimePage extends GridPage {
	private metric = 0;
	private cursor = dayKey(Date.now());
	protected override ownsArrows = true;

	protected override pageKey(data: string, app: App): boolean {
		const today = dayKey(Date.now());
		const move = (delta: number): boolean => {
			const next = shiftDay(this.cursor, delta);
			if (next <= today) this.cursor = next;
			return true;
		};
		if (data === "m") {
			this.metric = (this.metric + 1) % METRICS.length;
			return true;
		}
		if (matchesKey(data, "left")) return move(-7);
		if (matchesKey(data, "right")) return move(7);
		if (matchesKey(data, "up")) return move(-1);
		if (matchesKey(data, "down")) return move(1);
		if (matchesKey(data, "enter")) {
			drillDay(app, this.cursor);
			return true;
		}
		return false;
	}

	override hints = "arrows move day  enter drill down  m metric  PgUp/PgDn scroll";

	private calendarPanel(app: App): Row {
		const daily = allDaily(app);
		const metric = METRICS[this.metric]!;
		const days = new Map<string, number>();
		for (const [k, d] of daily) days.set(k, metricValue(metric, d));
		const d = daily.get(this.cursor);
		const detail = d
			? `${this.cursor}  ${d.sessions.size} sessions  ${d.calls} calls  ${fmtTokens(d.input + d.output + d.cacheRead + d.cacheWrite)} tok  ${fmtCost(d.cost + d.warmCost)}  ${fmtMinutes(d.activeMinutes)} active`
			: `${this.cursor}  no activity`;
		return {
			min: 12,
			pref: 12,
			panels: [
				{
					title: "ACTIVITY CALENDAR",
					right: `m: ${metric}`,
					draw: (s, ctx) => {
						calendarHeat(s.sub(0, 0, s.w, 8), days, ctx, { cursor: this.cursor, onClick: (day) => ((this.cursor = day), drillDay(app, day)) });
						s.text(0, 9, detail, ctx.pal.text);
					},
				},
			],
		};
	}

	protected rows(app: App, data: AnalyticsData): Row[] {
		const pal = app.pal;
		const grid = cached(app, data, "hourWeekday", () => hourWeekday(data.records, data.range));
		const hours = cached(app, data, "hourOfDay", () => hourOfDay(data.records, data.range));
		const st = streaks(allDaily(app));
		const badge = dayBadge(grid);
		const gridMax = Math.max(1, ...grid.flat());
		const lengths = BUCKETS.map(() => 0);
		for (const r of data.records) {
			if (r.activeMinutes <= 0) continue;
			lengths[BUCKETS.findIndex((b) => r.activeMinutes < b.max)]!++;
		}

		const punch: Row = {
			min: 11,
			pref: 11,
			panels: [
				{
					title: "PUNCH CARD",
					right: "weekday x hour",
					w: 56,
					draw: (s, ctx) => {
						const cellW = s.w >= 4 + 48 ? 2 : 1;
						[0, 6, 12, 18].forEach((h) => s.text(4 + h * cellW, 0, String(h), ctx.pal.dim));
						WEEKDAYS.forEach((d, r) => s.text(0, 1 + r, d, ctx.pal.dim));
						heatGrid(s, 4, 1, 7, 24, (r, c) => grid[r]![c]! / gridMax, ctx, { cellW });
					},
				},
				{ title: "HOURS OF THE DAY", right: "calls", draw: (s, ctx) => polar24(s, hours, ctx) },
			],
		};

		const bottom: Row = {
			min: 10,
			pref: 10,
			panels: [
				{
					title: "STREAK",
					w: 30,
					draw: (s, ctx) => {
						s.text(0, 0, "CURRENT", ctx.pal.dim);
						bigNumber(s, 0, 1, `${st.current}`, ctx);
						s.text(0, 4, "LONGEST", ctx.pal.dim);
						bigNumber(s, 0, 5, `${st.longest}`, ctx);
						s.text(0, 8, `${st.activeDays} active days`, ctx.pal.text);
					},
				},
				{
					title: "SESSION LENGTH",
					right: "active time",
					draw: (s, ctx) => vbars(s, lengths.map((n) => [n]), [ctx.pal.p100], ctx, { xLabels: BUCKETS.map((b) => b.label), yAxis: true }),
				},
				{ title: "DAY TYPE", w: 26, draw: (s, ctx) => drawBadge(s, ctx, badge) },
			],
		};
		return [this.calendarPanel(app), punch, bottom];
	}
}

function drawBadge(s: Surface, ctx: ChartCtx, badge: Badge): void {
	const pal = ctx.pal;
	const text = badge.name;
	const w = Math.min(s.w, Math.max(strWidth(text) + 6, 14));
	const x = Math.floor((s.w - w) / 2);
	s.box(x, 1, w, 5, pal.strong, pal.caps.unicode ? "double" : "ascii");
	s.textIn(x + 1, 2, w - 2, text, pal.strong, "center");
	s.textIn(x + 1, 4, w - 2, badge.pct > 0 ? `${badge.pct}%` : "n/a", pal.text, "center");
}
