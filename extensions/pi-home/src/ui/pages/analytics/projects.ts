import { matchesKey } from "@earendil-works/pi-tui";
import { projectStats, weekList } from "../../../index/aggregate.ts";
import type { Surface } from "../../../term/canvas.ts";
import type { App } from "../../app.ts";
import { type ChartCtx, cut, fgOf, gantt, legend, scatter, sparkline, vbars } from "../../charts/index.ts";
import { fmtAgo, fmtCost, fmtInt } from "../../format.ts";
import { type AnalyticsData, cached, drill, GridPage, type Row } from "./layout.ts";

const CARD_W = 26;
const CARD_H = 6;

type Stat = ReturnType<typeof projectStats>[number];

export class ProjectsPage extends GridPage {
	private selected = 0;
	private cols = 1;
	private count = 0;
	private wallRow = 0;
	private lastData: AnalyticsData | null = null;
	private lastProjects: Stat[] = [];
	protected override ownsArrows = true;
	override hints = "hjkl select project  enter drill down  PgUp/PgDn scroll";

	protected override pageKey(data: string, app: App): boolean {
		const move = (d: number): boolean => {
			this.selected = Math.max(0, Math.min(Math.max(0, this.count - 1), this.selected + d));
			return true;
		};
		if (matchesKey(data, "left")) return move(-1);
		if (matchesKey(data, "right")) return move(1);
		if (matchesKey(data, "up")) return move(-this.cols);
		if (matchesKey(data, "down")) return move(this.cols);
		if (matchesKey(data, "enter")) {
			const p = this.lastProjects[this.selected];
			if (p && this.lastData) drill(app, this.lastData, { cwd: p.cwd }, `project ${p.name}`);
			return true;
		}
		return false;
	}

	private drawWall(s: Surface, ctx: ChartCtx, app: App, data: AnalyticsData, projects: Stat[]): void {
		const pal = ctx.pal;
		this.cols = Math.max(1, Math.floor(s.w / CARD_W));
		const cw = Math.floor((s.w - (this.cols - 1)) / this.cols);
		const rowsFit = Math.max(1, Math.floor(s.h / CARD_H));
		const selRow = Math.floor(this.selected / this.cols);
		if (selRow < this.wallRow) this.wallRow = selRow;
		if (selRow >= this.wallRow + rowsFit) this.wallRow = selRow - rowsFit + 1;
		const uni = pal.caps.unicode;
		if (projects.length === 0) {
			s.text(0, 0, "NO DATA", pal.dim);
			return;
		}
		for (let r = 0; r < rowsFit; r++) {
			for (let c = 0; c < this.cols; c++) {
				const i = (this.wallRow + r) * this.cols + c;
				const p = projects[i];
				if (!p) continue;
				const x = c * (cw + 1);
				const y = r * CARD_H;
				const sel = i === this.selected;
				s.box(x, y, cw, CARD_H, sel ? pal.strong : pal.faint, sel ? (uni ? "double" : "ascii") : uni ? "single" : "ascii");
				s.text(x + 2, y + 1, cut(ctx, p.name, cw - 4), sel ? pal.sel : pal.strong);
				s.text(x + 2, y + 2, cut(ctx, `${fmtCost(p.cost)}  ${fmtInt(p.sessions)} sess`, cw - 4), pal.text);
				s.text(x + 2, y + 3, cut(ctx, `last ${fmtAgo(p.last)}`, cw - 4), pal.dim);
				sparkline(s, x + 2, y + 4, cw - 4, p.weekly, fgOf(pal.p70), ctx);
				s.hit(x, y, cw, CARD_H, {
					onClick: () => {
						this.selected = i;
						drill(app, data, { cwd: p.cwd }, `project ${p.name}`);
					},
				});
			}
		}
	}

	protected rows(app: App, data: AnalyticsData): Row[] {
		this.lastData = data;
		const pal = app.pal;
		const projects = cached(app, data, "projectStats", () => projectStats(data.records, data.range));
		const weeks = cached(app, data, "weekList", () => weekList(data.records, data.range));
		this.lastProjects = projects;
		this.count = projects.length;
		this.selected = Math.min(this.selected, Math.max(0, projects.length - 1));

		const top = projects.slice(0, 10);
		const share = projects.slice(0, 5);
		const shareCols = weeks.map((_, w) => {
			const total = projects.reduce((a, p) => a + (p.weekly[w] ?? 0), 0) || 1;
			const cols = share.map((p) => (p.weekly[w] ?? 0) / total);
			cols.push(projects.slice(5).reduce((a, p) => a + (p.weekly[w] ?? 0), 0) / total);
			return cols;
		});
		const names = [...share.map((p) => p.name), "other"];
		const first = Math.min(...projects.map((p) => p.first));
		const last = Math.max(...projects.map((p) => p.last));

		const wall: Row = {
			min: CARD_H + 2,
			pref: CARD_H * 3 + 2,
			panels: [{ title: "PROJECTS", right: `${projects.length}`, draw: (s, ctx) => this.drawWall(s, ctx, app, data, projects) }],
		};
		const charts: Row = {
			min: 9,
			pref: 12,
			panels: [
				{
					title: "SESSIONS VS COST",
					right: "log / log",
					draw: (s, ctx) => scatter(s, projects.map((p, i) => ({ x: p.sessions, y: p.cost, color: pal.series(i) })), ctx, { xLabel: "sessions", yLabel: "cost", logX: true, logY: true }),
				},
				{
					title: "LIFELINES",
					right: "first to last activity",
					weight: 1.3,
					draw: (s, ctx) =>
						gantt(
							s,
							top.map((p, i) => ({ label: p.name, start: p.first, end: p.last, color: pal.series(i), onClick: () => drill(app, data, { cwd: p.cwd }, `project ${p.name}`) })),
							first,
							last + 1,
							ctx,
							{ labelWidth: 14 },
						),
				},
				{
					title: "WEEKLY SHARE",
					right: "calls",
					draw: (s, ctx) => {
						legend(s, 0, s.h - 1, names.map((label, i) => ({ label: cut(ctx, label, 12), color: pal.series(i) })), ctx);
						vbars(s.sub(0, 0, s.w, s.h - 1), shareCols, names.map((_, i) => pal.series(i)), ctx, { max: 1, yAxis: true, xLabels: weeks.map((w) => w.slice(5)) });
					},
				},
			],
		};
		return [wall, charts];
	}
}
