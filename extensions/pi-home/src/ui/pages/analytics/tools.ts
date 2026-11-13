import { toolDna, toolStats, toolTransitions, topCounts } from "../../../index/aggregate.ts";
import type { Surface } from "../../../term/canvas.ts";
import type { App } from "../../app.ts";
import { boxplot, type ChartCtx, cut, donut, fgOf, hbars, heatGrid, legend, noData, seriesGlyph, waffle } from "../../charts/index.ts";
import { fmtInt } from "../../format.ts";
import { openSession } from "../../nav.ts";
import { type AnalyticsData, allRecords, cached, drill, GridPage, type Row } from "./layout.ts";

function drawDna(s: Surface, ctx: ChartCtx, dna: ReturnType<typeof toolDna>, open: (id: string) => void): void {
	const pal = ctx.pal;
	if (dna.rows.length === 0 || s.h < 3 || s.w < 8) {
		s.text(0, 0, dna.rows.length === 0 ? "NO DATA" : ".", pal.dim);
		return;
	}
	legend(s, 0, s.h - 1, dna.names.slice(0, 6).map((n, i) => ({ label: n, color: pal.series(i) })), ctx);
	const p = ctx.progress ?? 1;
	dna.rows.slice(0, s.h - 1).forEach((row, y) => {
		const n = row.tools.length;
		const shown = Math.min(n, s.w);
		for (let x = 0; x < shown; x++) {
			if (x >= shown * p) break;
			// Sessions longer than the width are sampled evenly.
			const idx = n <= s.w ? x : Math.floor((x * n) / s.w);
			const tool = row.tools[idx]!;
			s.text(x, y, seriesGlyph(ctx, tool % 6, 6), fgOf(pal.series(tool)));
		}
		s.hit(0, y, s.w, 1, { onClick: () => open(row.id) });
	});
}

export class ToolsPage extends GridPage {
	protected rows(app: App, data: AnalyticsData): Row[] {
		const pal = app.pal;
		const tools = cached(app, data, "toolStats", () => toolStats(data.records, data.range));
		const trans = cached(app, data, "toolTransitions", () => toolTransitions(data.records, data.range, 10));
		const dna = cached(app, data, "toolDna", () => toolDna(data.records, 60));
		const bash = cached(app, data, "bashCmds", () => topCounts(data.records, "bashCmds"));
		const git = cached(app, data, "gitSubs", () => topCounts(data.records, "gitSubs"));
		const custom = cached(app, data, "customTypes", () => topCounts(data.records, "customTypes"));
		const byId = new Map(allRecords(app).map((r) => [r.id, r]));
		const source = { builtin: 0, extension: 0, mcp: 0 };
		for (const t of tools) source[t.source] += t.calls;
		const top10 = tools.slice(0, 10);
		const maxTrans = Math.max(1, ...trans.matrix.flat());

		const first: Row = {
			min: 8,
			pref: 12,
			panels: [
				{
					title: "TOOL CALLS",
					right: "errors in red",
					draw: (s, ctx) =>
						hbars(s, top10.map((t, i) => ({ label: t.tool, value: t.calls, part: t.errors, color: pal.series(i), valueLabel: fmtInt(t.calls) })), ctx, {
							labelWidth: 14,
							onClick: (i) => drill(app, data, { tool: top10[i]!.tool }, `tool ${top10[i]!.tool}`),
						}),
				},
				{
					title: "DURATION",
					right: "log scale",
					draw: (s, ctx) => boxplot(s, top10.map((t) => ({ label: t.tool, values: t.durMs })), ctx, { log: true, format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`) }),
				},
			],
		};

		const second: Row = {
			min: 9,
			pref: 14,
			panels: [
				{
					title: "TRANSITIONS",
					right: "row -> next column",
					w: 52,
					draw: (s, ctx) => {
						const n = Math.min(trans.tools.length, s.h - 1);
						if (n <= 0 || trans.matrix.flat().every((v) => v === 0)) return noData(s, ctx);
						const lw = Math.min(14, Math.max(...trans.tools.slice(0, n).map((t) => t.length + 3)));
						trans.tools.slice(0, n).forEach((t, i) => s.text(0, 1 + i, cut(ctx, `${i} ${t}`, lw), ctx.pal.text));
						for (let i = 0; i < n; i++) s.text(lw + 1 + i * 2, 0, String(i), ctx.pal.dim);
						heatGrid(s, lw + 1, 1, n, n, (r, c) => Math.log1p(trans.matrix[r]![c]!) / Math.log1p(maxTrans), ctx);
					},
				},
				{
					title: "TOOL DNA",
					right: "latest sessions, one cell per call",
					draw: (s, ctx) => drawDna(s, ctx, dna, (id) => byId.has(id) && openSession(app, byId.get(id)!)),
				},
			],
		};

		const third: Row = {
			min: 9,
			pref: 10,
			panels: [
				{
					title: "BASH COMMANDS",
					draw: (s, ctx) => hbars(s, bash.slice(0, 8).map((b) => ({ label: b.key, value: b.count })), ctx, { labelWidth: 10 }),
				},
				{
					title: "GIT SUB-COMMANDS",
					draw: (s, ctx) => {
						const parts = git.slice(0, 5).map((g, i) => ({ value: g.count, color: pal.series(i), label: g.key }));
						const rest = git.slice(5).reduce((a, g) => a + g.count, 0);
						if (rest > 0) parts.push({ value: rest, color: pal.series(5), label: "other" });
						waffle(s, 0, 0, parts, ctx, { cols: 6, rows: Math.min(6, s.h) });
					},
				},
				{
					title: "EXTENSIONS",
					right: "custom entries",
					draw: (s, ctx) => hbars(s, custom.slice(0, 8).map((c) => ({ label: c.key, value: c.count })), ctx, { labelWidth: 16 }),
				},
				{
					title: "TOOL SOURCE",
					draw: (s, ctx) =>
						donut(
							s,
							[
								{ value: source.builtin, color: pal.series(0), label: "builtin" },
								{ value: source.extension, color: pal.series(1), label: "extension" },
								{ value: source.mcp, color: pal.series(2), label: "mcp" },
							],
							ctx,
						),
				},
			],
		};
		return [first, second, third];
	}
}
