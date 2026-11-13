import { basename } from "node:path";
import { budget, costStats, dailySeries, modelStats } from "../../../index/aggregate.ts";
import type { SessionRecord } from "../../../index/types.ts";
import type { Surface } from "../../../term/canvas.ts";
import { strWidth } from "../../../term/width.ts";
import type { App } from "../../app.ts";
import { axisLabel, boxplot, type ChartCtx, hbars, lineChart, markerGlyph, niceMax, treemap, vbars } from "../../charts/index.ts";
import { fmtCost, fmtInt, fmtTokens, shortModel } from "../../format.ts";
import { keyValues, progressBar } from "../../widgets.ts";
import { type AnalyticsData, allRecords, cached, drill, drillDay, GridPage, type Row, rangeDayKeys } from "./layout.ts";

/** Number of cache warm-up events in the range (the index only stores totals per session). */
function warmCount(records: SessionRecord[], from: number, to: number): number {
	let n = 0;
	for (const r of records) {
		const e = r.ev;
		for (let i = 0; i < e.eT.length; i++) if (e.eT[i]! >= from && e.eT[i]! < to && e.dict[e.eKind[i]!] === "cache_warm") n++;
	}
	return n;
}

function drawBudget(s: Surface, ctx: ChartCtx, b: { spent: number; projected: number; ratio: number }, limit: number): void {
	const pal = ctx.pal;
	const inner = Math.max(1, s.w - 2);
	const proj = Math.min(1, b.projected / limit);
	s.text(1 + Math.round(proj * (inner - 1)), 0, markerGlyph(ctx), pal.strong);
	progressBar(s, 0, 1, Math.max(8, s.w - 6), Math.min(1, b.ratio * (ctx.progress ?? 1)), pal, true);
	s.text(0, 2, `spent ${fmtCost(b.spent)} of ${fmtCost(limit)}`, pal.text);
	s.text(0, 3, `${markerGlyph(ctx)} projected ${fmtCost(b.projected)} by month end`, b.projected > limit ? { fg: pal.err } : pal.dim);
}

export class CostPage extends GridPage {
	protected rows(app: App, data: AnalyticsData): Row[] {
		const pal = app.pal;
		const daily = cached(app, data, "daily", () => dailySeries(data.records, data.range));
		const cost = cached(app, data, "costStats", () => costStats(data.records, data.range));
		const models = cached(app, data, "modelStats", () => modelStats(data.records, data.range));
		const days = rangeDayKeys(data, daily);
		const dayCost = days.map((k) => {
			const d = daily.get(k);
			return d ? d.cost + d.warmCost : 0;
		});
		const moving = dayCost.map((_, i) => {
			const win = dayCost.slice(Math.max(0, i - 6), i + 1);
			return win.reduce((a, b) => a + b, 0) / win.length;
		});
		let tIn = 0;
		let tOut = 0;
		let tCR = 0;
		let tCW = 0;
		let tRs = 0;
		for (const d of daily.values()) {
			tIn += d.input;
			tOut += d.output;
			tCR += d.cacheRead;
			tCW += d.cacheWrite;
			tRs += d.reasoning;
		}
		const tokens = tIn + tOut + tCR + tCW;
		const cfg = app.config.analytics;

		const cumulativeRow: Row = {
			min: 9,
			pref: 14,
			panels: [
				{
					title: "CUMULATIVE COST",
					right: fmtCost(cost.total),
					draw: (s, ctx) => {
						const idx = new Map(cost.cumulative.map((c, i) => [c.day, i]));
						lineChart(s, [{ values: cost.cumulative.map((c) => c.cost), color: pal.series(0) }], ctx, {
							area: true,
							yAxis: true,
							money: true,
							markers: cost.milestones.filter((m) => idx.has(m.day)).map((m) => ({ index: idx.get(m.day)!, label: `$${m.amount}` })),
						});
					},
				},
				{
					title: "DAILY COST",
					right: "7-day average line",
					draw: (s, ctx) => {
						const max = niceMax(Math.max(0, ...dayCost));
						const aw = Math.max(...[max, max / 2, 0].map((v) => strWidth(axisLabel(v, true)))) + 1;
						vbars(s, dayCost.map((c) => [c]), [pal.p70], ctx, {
							yAxis: true,
							money: true,
							max,
							xLabels: days.map((k) => String(Number(k.slice(8)))),
							onClick: (i) => drillDay(app, days[i]!),
						});
						if (s.w > aw + 2 && s.h > 3) lineChart(s.sub(aw, 0, s.w - aw, s.h - 1), [{ values: moving, color: pal.series(1) }], ctx, { min: 0, max });
					},
				},
			],
		};

		const ledger = warmCount(data.records, data.range.from, data.range.to);
		const middle: Row = {
			min: 7,
			pref: 9,
			panels: [
				{
					title: "TOKEN COMPOSITION",
					draw: (s, ctx) =>
						hbars(
							s,
							[
								{ label: "input", value: tIn },
								{ label: "cache read", value: tCR },
								{ label: "cache write", value: tCW },
								{ label: "output", value: tOut },
								{ label: "reasoning", value: tRs },
							].map((it, i) => ({ ...it, color: pal.series(i), valueLabel: fmtTokens(it.value) })),
							ctx,
							{ labelWidth: 11 },
						),
				},
				{
					title: "CACHE HIT RATIO",
					right: "cache read share",
					draw: (s, ctx) => lineChart(s, [{ values: cost.cacheHitByDay.map((c) => c.ratio), color: pal.series(2) }], ctx, { min: 0, max: 1, yAxis: true }),
				},
				{
					title: "CACHE WARM-UPS",
					draw: (s) => {
						keyValues(
							s,
							0,
							0,
							[
								["SPEND", fmtCost(cost.warm)],
								["WARM-UPS", fmtInt(ledger)],
								["SHARE", cost.total > 0 ? `${((cost.warm / cost.total) * 100).toFixed(1)}% of cost` : "n/a"],
							],
							pal,
						);
					},
				},
			],
		};

		const top = models.slice(0, 6);
		const lower: Row = {
			min: 8,
			pref: 13,
			panels: [
				{
					title: "COST BY PROJECT",
					weight: 1.3,
					draw: (s, ctx) =>
						treemap(
							s,
							cost.byProject.slice(0, 20).map((p) => ({ label: basename(p.cwd) || p.cwd, value: p.cost })),
							ctx,
							{ onClick: (i) => drill(app, data, { cwd: cost.byProject[i]!.cwd }, `project ${basename(cost.byProject[i]!.cwd)}`) },
						),
				},
				{
					title: "COST PER CALL",
					right: "p5 / p25 / p50 / p75 / p95",
					draw: (s, ctx) => boxplot(s, top.map((m) => ({ label: shortModel(m.model), values: m.costPerCall.filter((v) => v > 0) })), ctx, { log: true, money: true }),
				},
			],
		};

		const foot: Row = {
			min: 6,
			pref: 6,
			panels: [
				...(cfg.monthlyBudget > 0
					? [
							{
								title: "MONTHLY BUDGET",
								draw: (s: Surface, ctx: ChartCtx) => drawBudget(s, ctx, cached(app, data, "budget", () => budget(allRecords(app), cfg.monthlyBudget, Date.now())), cfg.monthlyBudget),
							},
						]
					: []),
				{
					title: "EQUIVALENCE",
					draw: (s, ctx) => {
						const books = tokens / Math.max(1, cfg.bookTokens);
						const coffees = cost.total / Math.max(0.01, cfg.coffeePrice);
						s.text(0, 0, `${fmtInt(tokens)} tokens ~ ${fmtInt(books)} books`, ctx.pal.text);
						s.text(0, 1, `(${fmtTokens(cfg.bookTokens)} tokens per book)`, ctx.pal.dim);
						s.text(0, 2, `${fmtCost(cost.total)} ~ ${fmtInt(coffees)} coffees`, ctx.pal.text);
						s.text(0, 3, `(${fmtCost(cfg.coffeePrice)} per coffee)`, ctx.pal.dim);
					},
				},
			],
		};
		return [cumulativeRow, middle, lower, foot];
	}
}
