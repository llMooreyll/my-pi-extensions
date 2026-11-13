import { longestRuns, subagentTree, topCounts, userStats } from "../../../index/aggregate.ts";
import type { Surface } from "../../../term/canvas.ts";
import { oneLine } from "../../../term/width.ts";
import type { App } from "../../app.ts";
import { type ChartCtx, cut, donut, fgOf, hbars, tagCloud, tree, vbars } from "../../charts/index.ts";
import type { TreeNode } from "../../charts/tree.ts";
import { fmtDuration, fmtInt } from "../../format.ts";
import { openSession } from "../../nav.ts";
import { type AnalyticsData, allRecords, cached, GridPage, type Row } from "./layout.ts";

const BUCKETS: { label: string; max: number }[] = [
	{ label: "0", max: 1 },
	{ label: "1", max: 2 },
	{ label: "2", max: 3 },
	{ label: "3-4", max: 5 },
	{ label: "5-9", max: 10 },
	{ label: "10-19", max: 20 },
	{ label: "20+", max: Number.POSITIVE_INFINITY },
];

export class BehaviourPage extends GridPage {
	private treeScroll = 0;
	private treeRows = 0;
	override hints = "J/K scroll subagent tree  j/k scroll panels";

	protected override pageKey(data: string): boolean {
		if (data === "J") return (this.treeScroll = Math.min(Math.max(0, this.treeRows - 1), this.treeScroll + 1)), true;
		if (data === "K") return (this.treeScroll = Math.max(0, this.treeScroll - 1)), true;
		return false;
	}

	protected rows(app: App, data: AnalyticsData): Row[] {
		const pal = app.pal;
		const user = cached(app, data, "userStats", () => userStats(data.records, data.range));
		const words = cached(app, data, "words", () => topCounts(data.records, "words"));
		const runs = cached(app, data, "longestRuns", () => longestRuns(data.records, 10));
		const family = cached(app, data, "subagentTree", () => subagentTree(allRecords(app)));
		const byId = new Map(allRecords(app).map((r) => [r.id, r]));
		const per100 = (n: number): number => (user.messages > 0 ? (n / user.messages) * 100 : 0);
		const politeRate = per100(user.polite);
		const badge = politeRate >= 20 ? "POLITE" : politeRate <= 2 ? "BLUNT" : undefined;
		const turns = BUCKETS.map(() => 0);
		for (const n of user.toolsPerTurn) turns[BUCKETS.findIndex((b) => n < b.max)]!++;

		const gauge = (count: number, label: string, rate: number) => (s: Surface, ctx: ChartCtx): void => {
			donut(s, user.messages > 0 ? [{ value: count, color: ctx.pal.series(0), label }, { value: Math.max(0, user.messages - count), color: ctx.pal.p25, label: "other" }] : [], ctx);
			s.text(0, Math.max(0, s.h - 1), `${fmtInt(count)} msg  ${rate.toFixed(1)}/100`, ctx.pal.dim);
		};

		const first: Row = {
			min: 10,
			pref: 12,
			panels: [
				{
					title: "TALK RATIO",
					right: "avg characters",
					draw: (s, ctx) =>
						hbars(
							s,
							[
								{ label: "you", value: user.avgUserLen, color: pal.series(0), valueLabel: fmtInt(user.avgUserLen) },
								{ label: "assistant", value: user.avgAssistantLen, color: pal.series(1), valueLabel: fmtInt(user.avgAssistantLen) },
							],
							ctx,
							{ labelWidth: 10 },
						),
				},
				{
					title: "HAN / LATIN",
					right: "your messages",
					draw: (s, ctx) => {
						const w = Math.max(2, s.w - 1);
						const han = Math.round(w * user.hanRatio * (ctx.progress ?? 1));
						const uni = pal.caps.unicode;
						s.text(0, 0, (uni ? "█" : "#").repeat(han), fgOf(pal.series(0)));
						s.text(han, 0, (uni ? "▒" : ".").repeat(w - han), fgOf(pal.series(1)));
						s.text(0, 2, `Han   ${(user.hanRatio * 100).toFixed(0)}%`, fgOf(pal.series(0)));
						s.text(0, 3, `Latin ${((1 - user.hanRatio) * 100).toFixed(0)}%`, fgOf(pal.series(1)));
					},
				},
				{ title: "POLITENESS", right: badge, draw: gauge(user.polite, "polite", politeRate) },
				{ title: "RUSH", draw: gauge(user.rush, "rush", per100(user.rush)) },
			],
		};

		const second: Row = {
			min: 8,
			pref: 11,
			panels: [
				{
					title: "YOUR WORDS",
					weight: 1.5,
					draw: (s, ctx) => tagCloud(s, words.slice(0, 60).map((w) => ({ text: w.key, weight: w.count })), ctx),
				},
				{
					title: "TOOLS PER TURN",
					right: "tool results after a message",
					draw: (s, ctx) => vbars(s, turns.map((n) => [n]), [pal.p100], ctx, { xLabels: BUCKETS.map((b) => b.label), yAxis: true }),
				},
			],
		};

		const root: TreeNode = { label: "SUBAGENT FAMILIES", detail: `${family.length}`, children: family };
		const third: Row = {
			min: 9,
			pref: 13,
			panels: [
				{
					title: "LONGEST RUNS",
					weight: 1.6,
					draw: (s, ctx) => {
						runs.forEach((r, y) => {
							if (y >= s.h) return;
							const dur = fmtDuration(r.ms).padEnd(9);
							s.text(0, y, dur, ctx.pal.strong);
							s.text(10, y, cut(ctx, oneLine(r.prompt || r.title), Math.max(1, s.w - 10)), ctx.pal.text);
							const rec = byId.get(r.id);
							if (rec) s.hit(0, y, s.w, 1, { onClick: () => openSession(app, rec) });
						});
						if (runs.length === 0) s.text(0, 0, "NO DATA", ctx.pal.dim);
					},
				},
				{
					title: "REFERENCES",
					draw: (s, ctx) =>
						hbars(
							s,
							[
								{ label: "browser", value: user.browserCtx },
								{ label: "skills", value: user.skillRefs },
								{ label: "images", value: user.images },
							].map((it, i) => ({ ...it, color: pal.series(i), valueLabel: fmtInt(it.value) })),
							ctx,
							{ labelWidth: 8 },
						),
				},
				{
					title: "SUBAGENT FAMILY",
					right: "J/K",
					weight: 1.4,
					draw: (s, ctx) => {
						this.treeRows = tree(s, root, ctx, { scroll: this.treeScroll });
						s.hit(0, 0, s.w, s.h, { onWheel: (dir) => (this.treeScroll = Math.max(0, Math.min(Math.max(0, this.treeRows - 1), this.treeScroll + dir))) });
					},
				},
			],
		};
		return [first, second, third];
	}
}
