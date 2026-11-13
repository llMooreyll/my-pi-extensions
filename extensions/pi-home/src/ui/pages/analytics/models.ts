import { matchesKey } from "@earendil-works/pi-tui";
import { type ModelStats, modelLabels, modelStats, modelSwitches, modelWeekly, thinkingStats } from "../../../index/aggregate.ts";
import type { SessionRecord } from "../../../index/types.ts";
import type { RGB } from "../../../term/color.ts";
import type { App } from "../../app.ts";
import { type ChartCtx, flow, hbars, legend, radar, scatter, vbars, violin, waffle } from "../../charts/index.ts";
import { fmtCost, fmtInt, fmtPct, shortModel } from "../../format.ts";
import { type AnalyticsData, cached, drill, GridPage, type Row } from "./layout.ts";

const median = (a: number[]): number => {
	if (a.length === 0) return 0;
	const s = [...a].sort((x, y) => x - y);
	return s[Math.floor(s.length / 2)]!;
};
const failures = (m: ModelStats): number => m.errors + m.aborted + m.truncated;

/** (latency ms, output tokens) per call, thinned to at most `cap` points, with the model index. */
function latencyPoints(records: SessionRecord[], from: number, to: number, models: string[], cap: number): { x: number; y: number; m: number }[] {
	const index = new Map(models.map((m, i) => [m, i]));
	const pts: { x: number; y: number; m: number }[] = [];
	for (const r of records) {
		const e = r.ev;
		for (let i = 0; i < e.cT.length; i++) {
			if (e.cT[i]! < from || e.cT[i]! >= to || e.cDur[i]! <= 0 || e.cOut[i]! <= 0) continue;
			const m = index.get(e.dict[e.cModel[i]!] ?? "?");
			if (m !== undefined) pts.push({ x: e.cDur[i]!, y: e.cOut[i]!, m });
		}
	}
	const stride = Math.max(1, Math.ceil(pts.length / cap));
	return pts.filter((_, i) => i % stride === 0);
}

export class ModelsPage extends GridPage {
	private byCost = false;
	private selected = 0;
	private top: string[] = [];
	private labels = new Map<string, string>();
	private label(m: string): string {
		return this.labels.get(m) ?? shortModel(m);
	}
	protected override ownsArrows = true;
	override hints = "c calls/cost  up/down select model  enter drill down  PgUp/PgDn scroll";

	protected override pageKey(data: string, app: App): boolean {
		if (data === "c") {
			this.byCost = !this.byCost;
			return true;
		}
		const n = Math.min(6, this.top.length);
		if (matchesKey(data, "up")) return (this.selected = Math.max(0, this.selected - 1)), true;
		if (matchesKey(data, "down")) return (this.selected = Math.min(Math.max(0, n - 1), this.selected + 1)), true;
		if (matchesKey(data, "enter") && this.top[this.selected]) {
			const model = this.top[this.selected]!;
			if (this.lastData) drill(app, this.lastData, { model }, `model ${this.label(model)}`);
			return true;
		}
		return false;
	}

	private lastData: AnalyticsData | null = null;

	protected rows(app: App, data: AnalyticsData): Row[] {
		this.lastData = data;
		const pal = app.pal;
		const stats = cached(app, data, "modelStats", () => modelStats(data.records, data.range));
		const weekly = cached(app, data, "modelWeekly", () => modelWeekly(data.records, data.range));
		const switches = cached(app, data, "modelSwitches", () => modelSwitches(data.records, data.range));
		const thinking = cached(app, data, "thinkingStats", () => thinkingStats(data.records, data.range));
		this.labels = modelLabels([...stats.map((m) => m.model), ...switches.flatMap((w) => [w.from, w.to])]);
		const L = (m: string): string => this.label(m);
		this.top = stats.slice(0, 6).map((m) => m.model);
		this.selected = Math.min(this.selected, Math.max(0, this.top.length - 1));
		const colorOf = (model: string): RGB => pal.series(Math.max(0, this.top.indexOf(model)) + (this.top.includes(model) ? 0 : 6));

		// Share by calls or cost: top 5 plus "other".
		const metric = (m: ModelStats): number => (this.byCost ? m.cost : m.calls);
		const sorted = [...stats].sort((a, b) => metric(b) - metric(a));
		const parts = sorted.slice(0, 5).map((m, i) => ({ value: metric(m), color: pal.series(i), label: L(m.model) }));
		const rest = sorted.slice(5).reduce((a, m) => a + metric(m), 0);
		if (rest > 0) parts.push({ value: rest, color: pal.series(5), label: "other" });

		// 100% stacked weekly share of the same top models.
		const shareModels = weekly.models.slice(0, 5);
		const shareCols = weekly.calls.map((row) => {
			const total = row.reduce((a, b) => a + b, 0) || 1;
			const cols = shareModels.map((_, i) => row[i]! / total);
			cols.push(row.slice(5).reduce((a, b) => a + b, 0) / total);
			return cols;
		});
		const shareNames = [...shareModels.map(L), "other"];

		const share: Row = {
			min: 12,
			pref: 12,
			panels: [
				{
					title: "SHARE",
					right: this.byCost ? "cost (c)" : "calls (c)",
					w: 62,
					draw: (s, ctx) => waffle(s, 0, 0, parts, ctx, { cols: 10, rows: Math.min(10, s.h) }),
				},
				{
					title: "WEEKLY SHARE",
					right: "100% stacked",
					draw: (s, ctx) => {
						legend(s, 0, s.h - 1, shareNames.map((label, i) => ({ label, color: pal.series(i) })), ctx);
						vbars(s.sub(0, 0, s.w, s.h - 1), shareCols, shareNames.map((_, i) => pal.series(i)), ctx, { max: 1, yAxis: true, xLabels: weekly.weeks.map((w) => w.slice(5)) });
					},
				},
			],
		};

		const speed: Row = {
			min: 9,
			pref: 12,
			panels: [
				{
					title: "TOKENS PER SECOND",
					right: "top models",
					draw: (s, ctx) => violin(s, stats.slice(0, 6).map((m) => ({ label: L(m.model), values: m.tps, color: colorOf(m.model) })), ctx, { log: true }),
				},
				{
					title: "LATENCY VS OUTPUT",
					right: "log / log",
					draw: (s, ctx) => {
						const pts = cached(app, data, "latency", () => latencyPoints(data.records, data.range.from, data.range.to, this.top, 900));
						scatter(s, pts.map((p) => ({ x: p.x, y: p.y, color: pal.series(p.m) })), ctx, { xLabel: "latency ms", yLabel: "output tokens", logX: true, logY: true });
					},
				},
			],
		};

		const detail: Row = {
			min: 8,
			pref: 12,
			panels: [
				{
					title: "THINKING LEVEL",
					draw: (s, ctx) =>
						hbars(s, thinking.map((t, i) => ({ label: t.level, value: t.calls, color: pal.series(i), valueLabel: `${fmtInt(t.calls)}` })), ctx, { labelWidth: 8 }),
				},
				{
					title: "MODEL SWITCHES",
					weight: 1.5,
					draw: (s, ctx) => flow(s, switches.map((w) => ({ from: L(w.from), to: L(w.to), value: w.value })), ctx),
				},
				{
					title: "FAILURE RATE",
					right: "error + aborted + length",
					draw: (s, ctx) => {
						const items = stats.filter((m) => m.calls > 0).slice(0, 8);
						hbars(
							s,
							items.map((m) => ({ label: L(m.model), value: failures(m) / m.calls, valueLabel: fmtPct(failures(m) / m.calls, 1) })),
							ctx,
							{ labelWidth: 14, max: Math.max(0.05, ...items.map((m) => failures(m) / m.calls)), onClick: (i) => drill(app, data, { model: items[i]!.model, onlyErrors: true }, `failures ${L(items[i]!.model)}`) },
						);
					},
				},
			],
		};

		const maxTps = Math.max(1, ...stats.slice(0, 6).map((m) => median(m.tps)));
		const maxCpc = Math.max(1e-9, ...stats.slice(0, 6).map((m) => m.cost / Math.max(1, m.calls)));
		const maxCalls = Math.max(1, ...stats.slice(0, 6).map((m) => m.calls));
		const sel = stats.find((m) => m.model === this.top[this.selected]);
		const radarRow: Row = {
			min: 11,
			pref: 13,
			panels: [
				{
					title: "MODELS",
					right: "up/down",
					w: 40,
					draw: (s, ctx) => {
						stats.slice(0, 6).forEach((m, i) => {
							const line = `${i === this.selected ? ">" : " "} ${L(m.model).padEnd(22).slice(0, 22)} ${fmtInt(m.calls).padStart(7)}  ${fmtCost(m.cost)}`;
							s.text(0, i, line, i === this.selected ? ctx.pal.sel : ctx.pal.text);
							s.hit(0, i, s.w, 1, { onClick: () => (this.selected = i) });
						});
					},
				},
				{
					title: "PROFILE",
					right: sel ? L(sel.model) : undefined,
					draw: (s, ctx: ChartCtx) => {
						if (!sel) return radar(s, [], ctx);
						const failure = failures(sel) / Math.max(1, sel.calls);
						const hit = sel.cacheRead / Math.max(1, sel.input + sel.cacheRead);
						radar(
							s,
							[
								{ label: "SPEED", value: median(sel.tps) / maxTps },
								{ label: "PRICE", value: 1 - sel.cost / Math.max(1, sel.calls) / maxCpc },
								{ label: "VOLUME", value: sel.calls / maxCalls },
								{ label: "RELIABILITY", value: 1 - failure },
								{ label: "CACHE", value: hit },
							],
							ctx,
						);
					},
				},
			],
		};
		return [share, speed, detail, radarRow];
	}
}
