import { basename, dirname } from "node:path";
import { dailySeries, fileStats, fileTimeline, topCounts } from "../../../index/aggregate.ts";
import type { App } from "../../app.ts";
import { type ChartCtx, hbars, heatGrid, mirrorBars, treemap, waffle } from "../../charts/index.ts";
import { cut } from "../../charts/common.ts";
import { fmtInt } from "../../format.ts";
import { type AnalyticsData, cached, drill, GridPage, type Row, rangeDayKeys } from "./layout.ts";

const shortPath = (p: string): string => {
	const d = basename(dirname(p));
	return d && d !== "/" ? `${d}/${basename(p)}` : basename(p);
};

export class FilesPage extends GridPage {
	protected rows(app: App, data: AnalyticsData): Row[] {
		const pal = app.pal;
		const stats = cached(app, data, "fileStats", () => fileStats(data.records));
		const timeline = cached(app, data, "fileTimeline", () => fileTimeline(data.records, data.range, 10));
		const daily = cached(app, data, "daily", () => dailySeries(data.records, data.range));
		const langs = cached(app, data, "codeLangs", () => topCounts(data.records, "codeLangs"));
		const days = rangeDayKeys(data, daily);
		const files = stats.files.filter((f) => f.edit + f.write > 0).sort((a, b) => b.edit + b.write - (a.edit + a.write)).slice(0, 20);

		const first: Row = {
			min: 8,
			pref: 22,
			panels: [
				{
					title: "TOP FILES",
					right: "edit + write (reads in brackets)",
					weight: 2,
					draw: (s, ctx) =>
						hbars(
							s,
							files.map((f) => ({ label: shortPath(f.path), value: f.edit + f.write, valueLabel: `${fmtInt(f.edit + f.write)} (${fmtInt(f.read)}r)` })),
							ctx,
							{ labelWidth: 30, onClick: (i) => drill(app, data, { file: files[i]!.path }, `file ${basename(files[i]!.path)}`) },
						),
				},
				{
					title: "LANGUAGES",
					weight: 1,
					draw: (s, ctx) => {
						const parts = stats.languages.slice(0, 5).map((l, i) => ({ value: l.count, color: pal.series(i), label: l.ext }));
						const rest = stats.languages.slice(5).reduce((a, l) => a + l.count, 0);
						if (rest > 0) parts.push({ value: rest, color: pal.series(5), label: "other" });
						waffle(s, 0, 0, parts, ctx, { cols: 10, rows: Math.min(10, s.h) });
					},
				},
				{
					title: "DIRECTORIES",
					weight: 1.4,
					draw: (s, ctx) =>
						treemap(
							s,
							stats.dirs.slice(0, 16).map((d) => ({ label: basename(d.dir) || d.dir, value: d.count })),
							ctx,
						),
				},
			],
		};

		const second: Row = {
			min: 9,
			pref: 12,
			panels: [
				{
					title: "FILE ACTIVITY",
					right: "edits per day",
					weight: 1.3,
					draw: (s, ctx: ChartCtx) => {
						const lw = Math.min(16, s.w >> 2);
						const cellW = s.w - lw - 1 >= timeline.days.length * 2 ? 2 : 1;
						const fit = Math.max(1, Math.floor((s.w - lw - 1) / cellW));
						const from = Math.max(0, timeline.days.length - fit);
						const cols = Math.min(fit, timeline.days.length);
						const max = Math.max(1, ...timeline.matrix.flat());
						timeline.files.forEach((f, i) => s.text(0, i, cut(ctx, basename(f), lw), ctx.pal.text));
						heatGrid(s, lw + 1, 0, timeline.files.length, cols, (r, c) => timeline.matrix[r]![from + c]! / max, ctx, { cellW });
					},
				},
				{
					title: "LINES CHANGED",
					right: "added up, deleted down",
					draw: (s, ctx) => {
						const add = days.map((k) => daily.get(k)?.editAdd ?? 0);
						const del = days.map((k) => daily.get(k)?.editDel ?? 0);
						mirrorBars(s, add, del, ctx, { xLabels: days.map((k) => String(Number(k.slice(8)))) });
					},
				},
				{
					title: "CODE BLOCK LANGUAGES",
					draw: (s, ctx) => hbars(s, langs.slice(0, 8).map((l) => ({ label: l.key, value: l.count })), ctx, { labelWidth: 10 }),
				},
			],
		};
		return [first, second];
	}
}
