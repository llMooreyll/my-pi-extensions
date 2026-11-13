import { type DayStats, modelLabels, modelStats, projectStats, toolStats } from "../../../index/aggregate.ts";
import { dayKey, RANGES } from "../../../index/query.ts";
import type { Surface } from "../../../term/canvas.ts";
import type { App } from "../../app.ts";
import { axisLabel, bigNumber, bigNumberWidth, calendarHeat, type ChartCtx, donut, fgOf, hbars, legend, sparkline, trendGlyph, vbars } from "../../charts/index.ts";
import { fmtCost, fmtInt, fmtTokens, shortModel } from "../../format.ts";
import { type AnalyticsData, allDaily, cached, drill, drillDay, GridPage, lastDays, type Row, shiftDay } from "./layout.ts";

const tokensOf = (d: DayStats): number => d.input + d.output + d.cacheRead + d.cacheWrite;

interface Totals {
	sessions: number;
	turns: number;
	tokens: number;
	cost: number;
	hours: number;
}

/** Totals over days with fromKey <= key < toKey. Sessions are counted once across days. */
function totals(daily: Map<string, DayStats>, fromKey: string, toKey: string): Totals {
	const ids = new Set<string>();
	const t: Totals = { sessions: 0, turns: 0, tokens: 0, cost: 0, hours: 0 };
	for (const [k, d] of daily) {
		if (k < fromKey || k >= toKey) continue;
		for (const id of d.sessions) ids.add(id);
		t.turns += d.userTurns;
		t.tokens += tokensOf(d);
		t.cost += d.cost + d.warmCost;
		t.hours += d.activeMinutes / 60;
	}
	t.sessions = ids.size;
	return t;
}

interface Card {
	title: string;
	key: keyof Totals;
	day: (d: DayStats | undefined) => number;
	fmt: (v: number) => string;
}

const hoursText = (v: number): string => (v >= 100 ? String(Math.round(v)) : v.toFixed(1));
const CARDS: Card[] = [
	{ title: "SESSIONS", key: "sessions", day: (d) => d?.sessions.size ?? 0, fmt: (v) => fmtInt(v) },
	{ title: "TURNS", key: "turns", day: (d) => d?.userTurns ?? 0, fmt: (v) => fmtInt(v) },
	{ title: "TOKENS", key: "tokens", day: (d) => (d ? tokensOf(d) : 0), fmt: fmtTokens },
	{ title: "COST", key: "cost", day: (d) => (d ? d.cost + d.warmCost : 0), fmt: fmtCost },
	{ title: "ACTIVE HOURS", key: "hours", day: (d) => (d?.activeMinutes ?? 0) / 60, fmt: hoursText },
];

function drawCard(s: Surface, ctx: ChartCtx, card: Card, value: number, prev: number | null, spark: number[]): void {
	const pal = ctx.pal;
	const p = ctx.progress ?? 1;
	s.text(0, 0, card.title, pal.dim);
	let text = card.fmt(value * p);
	if (pal.caps.unicode && bigNumberWidth(text) > s.w) text = axisLabel(value * p, card.key === "cost");
	bigNumber(s, 0, 1, text, ctx);
	sparkline(s, 0, 4, Math.min(s.w, 16), spark, fgOf(pal.p70), ctx);
	if (prev === null) return;
	if (prev <= 0) {
		s.text(0, 5, "no prior data", pal.dim);
		return;
	}
	const pct = Math.round(((value - prev) / prev) * 100);
	const up = pct >= 0;
	s.text(0, 5, `${trendGlyph(ctx, up)} ${Math.abs(pct)}%`, fgOf(up ? pal.ok : pal.err));
}

export class OverviewPage extends GridPage {
	protected rows(app: App, data: AnalyticsData): Row[] {
		const daily = allDaily(app);
		const today = dayKey(Date.now());
		const spanDays = RANGES.find((r) => r.id === data.rangeId)?.days ?? null;
		const fromKey = dayKey(data.range.from);
		const cur = totals(daily, fromKey, "9999");
		const prev = spanDays === null ? null : totals(daily, shiftDay(fromKey, -spanDays), fromKey);
		const last14 = lastDays(14);
		const cards: Row = {
			min: 6,
			pref: 6,
			panels: CARDS.map((c) => ({
				title: c.title,
				bare: true,
				draw: (s, ctx) => drawCard(s, ctx, c, cur[c.key], prev ? prev[c.key] : null, last14.map((k) => c.day(daily.get(k)))),
			})),
		};

		const avg30 = lastDays(30).slice(0, 29).reduce((a, k) => a + (daily.has(k) ? tokensOf(daily.get(k)!) : 0), 0) / 29;
		const todayTokens = daily.has(today) ? tokensOf(daily.get(today)!) : 0;
		const pct = avg30 > 0 ? Math.round((todayTokens / avg30) * 100) : 0;
		const tokenDays = new Map<string, number>();
		for (const [k, d] of daily) tokenDays.set(k, tokensOf(d));
		const gauge: Row = {
			min: 10,
			pref: 10,
			panels: [
				{
					title: "TODAY",
					right: avg30 > 0 ? `${pct}% of avg` : undefined,
					w: 30,
					draw: (s, ctx) =>
						donut(
							s,
							avg30 > 0
								? [
										{ value: Math.min(todayTokens, avg30), color: ctx.pal.p100, label: "today" },
										{ value: Math.max(0, avg30 - todayTokens), color: ctx.pal.p25, label: "rest" },
									]
								: [],
							ctx,
						),
				},
				{
					title: "TOKENS PER DAY",
					draw: (s, ctx) => calendarHeat(s, tokenDays, ctx, { cursor: today, onClick: (day) => drillDay(app, day) }),
				},
			],
		};

		const days30 = lastDays(30);
		const stack: Row = {
			min: 8,
			pref: 12,
			panels: [
				{
					title: "LAST 30 DAYS",
					right: "tokens per day",
					draw: (s, ctx) => {
						const names = ["input", "cache read", "cache write", "output"];
						legend(s, 0, s.h - 1, names.map((label, i) => ({ label, color: ctx.pal.series(i) })), ctx);
						const col = (k: string): number[] => {
							const d = daily.get(k);
							return d ? [d.input, d.cacheRead, d.cacheWrite, d.output] : [0, 0, 0, 0];
						};
						vbars(s.sub(0, 0, s.w, s.h - 1), days30.map(col), names.map((_, i) => ctx.pal.series(i)), ctx, {
							yAxis: true,
							xLabels: days30.map((k) => String(Number(k.slice(8)))),
							onClick: (i) => drillDay(app, days30[i]!),
						});
					},
				},
			],
		};

		const projects = cached(app, data, "projectStats", () => projectStats(data.records, data.range));
		const models = cached(app, data, "modelStats", () => modelStats(data.records, data.range));
		const tools = cached(app, data, "toolStats", () => toolStats(data.records, data.range));
		const labels = modelLabels(models.map((m) => m.model));
		const modelLabel = (m: string): string => labels.get(m) ?? shortModel(m);
		const top5: Row = {
			min: 7,
			pref: 7,
			panels: [
				{
					title: "TOP PROJECTS",
					right: "cost",
					draw: (s, ctx) => {
						const top = projects.slice(0, 5);
						hbars(s, top.map((p) => ({ label: p.name, value: p.cost, valueLabel: fmtCost(p.cost) })), ctx, {
							labelWidth: 18,
							onClick: (i) => drill(app, data, { cwd: top[i]!.cwd }, `project ${top[i]!.name}`),
						});
					},
				},
				{
					title: "TOP MODELS",
					right: "calls",
					draw: (s, ctx) => {
						const top = models.slice(0, 5);
						hbars(s, top.map((m) => ({ label: modelLabel(m.model), value: m.calls, valueLabel: fmtInt(m.calls) })), ctx, {
							labelWidth: 18,
							onClick: (i) => drill(app, data, { model: top[i]!.model }, `model ${modelLabel(top[i]!.model)}`),
						});
					},
				},
				{
					title: "TOP TOOLS",
					right: "calls",
					draw: (s, ctx) => {
						const top = tools.slice(0, 5);
						hbars(s, top.map((t) => ({ label: t.tool, value: t.calls, valueLabel: fmtInt(t.calls) })), ctx, {
							labelWidth: 18,
							onClick: (i) => drill(app, data, { tool: top[i]!.tool }, `tool ${top[i]!.tool}`),
						});
					},
				},
			],
		};
		return [cards, gauge, stack, top5];
	}
}
