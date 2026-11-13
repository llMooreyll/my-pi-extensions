import { defaultFilter, filterSessions, RANGES, type RangeId, rangeBounds } from "../../index/query.ts";
import type { Surface } from "../../term/canvas.ts";
import { strWidth } from "../../term/width.ts";
import type { App, Page } from "../app.ts";
import { type AnalyticsData, cachedBy, restartAnimation, type SubPage, view } from "./analytics/layout.ts";
import { BehaviourPage } from "./analytics/behaviour.ts";
import { CostPage } from "./analytics/cost.ts";
import { FilesPage } from "./analytics/files.ts";
import { ModelsPage } from "./analytics/models.ts";
import { OverviewPage } from "./analytics/overview.ts";
import { ProjectsPage } from "./analytics/projects.ts";
import { TimePage } from "./analytics/time.ts";
import { ToolsPage } from "./analytics/tools.ts";

export type { AnalyticsData } from "./analytics/layout.ts";

/** WRAPPED entry card; Pi Wrapped itself is added in a later step. */
class WrappedEntryPage implements SubPage {
	draw(s: Surface, app: App): void {
		s.textIn(0, Math.floor(s.h / 2), s.w, "Press enter to start Pi Wrapped", app.pal.strong, "center");
	}
	key(): boolean {
		return false;
	}
}

export class AnalyticsPage implements Page {
	readonly title = "ANALYTICS";
	private readonly subs: { name: string; page: SubPage }[] = [
		{ name: "OVERVIEW", page: new OverviewPage() },
		{ name: "TIME", page: new TimePage() },
		{ name: "COST", page: new CostPage() },
		{ name: "MODELS", page: new ModelsPage() },
		{ name: "TOOLS", page: new ToolsPage() },
		{ name: "FILES", page: new FilesPage() },
		{ name: "PROJECTS", page: new ProjectsPage() },
		{ name: "BEHAVIOUR", page: new BehaviourPage() },
		{ name: "WRAPPED", page: new WrappedEntryPage() },
	];
	private sub = 0;
	private rangeId: RangeId = "30d";

	constructor(_app: App) {}

	enter(app: App): void {
		restartAnimation(app);
	}

	hints(): string {
		const own = this.subs[this.sub]!.page.hints ?? "";
		return `[ ] sub-tab  r range  s subagents  ${own}  tab next tab  q quit`.replace(/ {3,}/g, "  ");
	}

	private setSub(app: App, i: number): void {
		this.sub = (i + this.subs.length) % this.subs.length;
		restartAnimation(app);
	}

	private setRange(app: App, id: RangeId): void {
		this.rangeId = id;
		restartAnimation(app);
	}

	private data(app: App): AnalyticsData {
		const range = rangeBounds(this.rangeId);
		const records = cachedBy(app, `records|${this.rangeId}`, () =>
			filterSessions(app.index.records.values(), { ...defaultFilter(), from: range.from, to: range.to, includeSubagents: view.includeSubagents }),
		);
		return { records, range, rangeId: this.rangeId };
	}

	key(data: string, app: App): boolean {
		if (data === "[") return this.setSub(app, this.sub - 1), true;
		if (data === "]") return this.setSub(app, this.sub + 1), true;
		if (data === "r") {
			const i = RANGES.findIndex((r) => r.id === this.rangeId);
			this.setRange(app, RANGES[(i + 1) % RANGES.length]!.id);
			return true;
		}
		if (data === "s") {
			view.includeSubagents = !view.includeSubagents;
			restartAnimation(app);
			return true;
		}
		return this.subs[this.sub]!.page.key(data, app);
	}

	draw(s: Surface, app: App): void {
		const pal = app.pal;
		// Right side: range selector and subagent toggle.
		const ranges = RANGES.map((r) => r.label);
		const right = `${ranges.join(" ")}  +SUB`;
		const rx = Math.max(0, s.w - strWidth(right) - 1);
		let x = rx;
		RANGES.forEach((r) => {
			const active = r.id === this.rangeId;
			s.text(x, 0, r.label, active ? pal.sel : pal.dim);
			s.hit(x, 0, strWidth(r.label), 1, { onClick: () => this.setRange(app, r.id) });
			x += strWidth(r.label) + 1;
		});
		x += 1;
		s.text(x, 0, "+SUB", view.includeSubagents ? pal.sel : pal.dim);
		s.hit(x, 0, 4, 1, {
			onClick: () => {
				view.includeSubagents = !view.includeSubagents;
				restartAnimation(app);
			},
		});
		// Left side: sub-tab bar.
		const bar = s.sub(0, 0, Math.max(0, rx - 1), 1);
		const full = this.subs.reduce((a, t) => a + strWidth(t.name) + 2, 1);
		const gap = full <= bar.w ? 2 : 1;
		let tx = 1;
		this.subs.forEach((t, i) => {
			const w = strWidth(t.name);
			if (tx + w > bar.w) return;
			bar.text(tx, 0, t.name, i === this.sub ? pal.sel : pal.dim);
			bar.hit(tx, 0, w, 1, { onClick: () => this.setSub(app, i) });
			tx += w + gap;
		});
		s.hline(0, 1, s.w, pal.faint, pal.caps.unicode ? "─" : "-");
		const page = this.subs[this.sub]!.page;
		page.draw(s.sub(1, 2, Math.max(0, s.w - 2), Math.max(0, s.h - 2)), app, this.data(app));
		if (page.status) s.textIn(0, 1, s.w, ` ${page.status} `, pal.dim, "right");
	}
}
