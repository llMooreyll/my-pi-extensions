import { matchesKey } from "@earendil-works/pi-tui";
import { liveSessions, type LiveSession } from "../../index/actions.ts";
import { mainModel, sessionTitle, totalTokens } from "../../index/query.ts";
import { compactTree, readSessionTree } from "../../index/session-tree.ts";
import type { SessionRecord } from "../../index/types.ts";
import { loadModels, type ModelEntry } from "../../resources/models.ts";
import { tildify } from "../../paths.ts";
import type { Surface } from "../../term/canvas.ts";
import { truncate } from "../../term/width.ts";
import type { App, Page } from "../app.ts";
import { axisLabel, type ChartCtx, cut, ellipsis, gantt, hbars, legend, lineChart, noData, seriesGlyph, tree, type TreeNode, waffle } from "../charts/index.ts";
import { fmtAgo, fmtCost, fmtDateTime, fmtMinutes, fmtTokens, shortModel } from "../format.ts";
import { homeHooks, launchTarget } from "./home.ts";
import { type AnalyticsData, GridPage, type Row } from "./analytics/layout.ts";
import { navHandlers } from "../nav.ts";

const NO_DATA: AnalyticsData = { records: [], range: { from: 0, to: 0 }, rangeId: "all" };

/** "1.0M" / "200K" / "128K" → tokens, null when not parseable. */
function parseWindow(s: string | undefined): number | null {
	const m = /^([\d.]+)\s*([KMB]?)$/i.exec(s ?? "");
	if (!m) return null;
	const mult = { "": 1, K: 1e3, M: 1e6, B: 1e9 }[m[2]!.toUpperCase() as "" | "K" | "M" | "B"];
	return Number(m[1]) * mult;
}

/** Index of the first call at or after time `t`, or -1. */
function callIndexAt(cT: number[], t: number): number {
	return cT.findIndex((c) => c >= t);
}

const fileTag = (f: { edit: number; write: number; read: number }): string => `e${f.edit + f.write} r${f.read}`;

/** The scrolling panels below the header. */
class DetailGrid extends GridPage {
	override hints = "j/k scroll panels  PgUp/PgDn page";
	private readonly page: SessionDetailPage;

	constructor(page: SessionDetailPage) {
		super();
		this.page = page;
	}

	protected rows(app: App): Row[] {
		const r = this.page.rec;
		const ev = r.ev;
		const pal = app.pal;
		const ctxOf = (c: ChartCtx): ChartCtx => ({ pal: c.pal, progress: app.progress(500) });
		const rows: Row[] = [];
		const one = (title: string, min: number, pref: number, draw: (s: Surface, ctx: ChartCtx) => void, right?: string): void => {
			rows.push({ min, pref, panels: [{ title, ...(right ? { right } : {}), draw: (s, c) => draw(s, ctxOf(c)) }] });
		};

		// CONTEXT_LEVEL
		const ctxVals = ev.cT.map((_, i) => ev.cIn[i]! + ev.cCR[i]! + ev.cCW[i]!);
		const peak = Math.max(0, ...ctxVals);
		const entry = this.page.modelEntry();
		const limit = entry?.contextWindow && parseWindow(entry.contextWindow) ? entry.contextWindow : null;
		const compactions = ev.eT
			.map((t, i) => ({ t, kind: ev.dict[ev.eKind[i]!] }))
			.filter((e) => e.kind === "compaction")
			.map((e) => ({ index: callIndexAt(ev.cT, e.t), label: "compact" }))
			.filter((m) => m.index >= 0);
		one(
			"CONTEXT_LEVEL",
			6,
			12,
			(s, ctx) => lineChart(s, [{ values: ctxVals, color: pal.p100 }], ctx, { area: true, yAxis: true, ...(compactions.length ? { markers: compactions } : {}) }),
			`peak ${axisLabel(peak)}${limit ? ` · limit ${limit}` : ""}`,
		);

		// CUMULATIVE_COST
		let run = 0;
		const cum = ev.cCost.map((c) => (run += c));
		const changes = ev.eT
			.map((t, i) => ({ t, kind: ev.dict[ev.eKind[i]!], model: ev.dict[ev.eVal[i]!] ?? "" }))
			.filter((e) => e.kind === "model_change")
			.map((e) => ({ index: callIndexAt(ev.cT, e.t), label: shortModel(e.model) }))
			.filter((m) => m.index >= 0);
		one(
			"CUMULATIVE_COST",
			6,
			12,
			(s, ctx) => lineChart(s, [{ values: cum, color: pal.p100 }], ctx, { area: true, yAxis: true, money: true, ...(changes.length ? { markers: changes } : {}) }),
			fmtCost(run),
		);

		// TURNS
		const turns = ev.uT.length;
		one(
			"TURNS",
			4,
			2 + Math.min(12, turns + 1),
			(s, ctx) => {
				const end = Math.max(r.lastActivity, ev.cT.at(-1) ?? 0, ev.tT.at(-1) ?? 0);
				const first = Math.max(0, turns - Math.max(0, s.h - 1));
				const items: { label: string; start: number; end: number; color: ChartCtx["pal"]["p100"] }[] = [];
				for (let i = first; i < turns; i++) {
					const start = ev.uT[i]!;
					const stop = i + 1 < turns ? ev.uT[i + 1]! : end;
					const calls = ev.cT.filter((t) => t >= start && t < stop).length;
					const tools = ev.tT.filter((t) => t >= start && t < stop).length;
					items.push({ label: `turn ${i + 1} · ${calls} calls · ${tools} tools`, start, end: Math.max(stop, start + 1), color: pal.series(0) });
				}
				const from = items[0]?.start ?? 0;
				const hm = (t: number): string => new Date(t).toTimeString().slice(0, 5);
				gantt(s, items, from, end, ctx, end - from < 36 * 3_600_000 ? { tickFormat: hm } : {});
			},
			`${turns} turns`,
		);

		// TOOL_DNA and TOOLS share the per-tool ranking.
		const toolRank = Object.entries(r.tools).sort((a, b) => b[1].calls - a[1].calls);
		const rankOf = new Map(toolRank.map(([name], i) => [name, i]));
		const nCells = ev.tTool.length;
		one(
			"TOOL_DNA",
			4,
			Math.min(14, 3 + Math.ceil(nCells / 120)),
			(s, ctx) => {
				if (nCells === 0) return noData(s, ctx);
				const lines = Math.max(1, s.h - 1);
				for (let i = 0; i < Math.min(nCells, lines * s.w); i++) {
					const k = rankOf.get(ev.dict[ev.tTool[i]!] ?? "") ?? 0;
					s.text(i % s.w, Math.floor(i / s.w), seriesGlyph(ctx, k, toolRank.length), { fg: pal.series(k) });
				}
				legend(s, 0, s.h - 1, toolRank.map(([name], i) => ({ label: name, color: pal.series(i) })), ctx);
			},
			`${nCells} results`,
		);

		one("TOOLS", 3, 2 + Math.min(12, toolRank.length), (s, ctx) =>
			hbars(
				s,
				toolRank.map(([name, st], i) => ({ label: name, value: st.calls, part: st.errors, color: pal.series(i) })),
				ctx,
			),
		);

		// MODELS
		const models = Object.entries(r.models).sort((a, b) => b[1].calls - a[1].calls);
		one("MODELS", 7, 7, (s, ctx) =>
			waffle(
				s,
				0,
				0,
				models.map(([m, st], i) => ({ value: st.calls, color: pal.series(i), label: shortModel(m) })),
				ctx,
				{ cols: 10, rows: 5 },
			),
		);

		// FILES
		const files = Object.entries(r.files).sort((a, b) => b[1].edit + b[1].write - (a[1].edit + a[1].write) || b[1].read - a[1].read);
		one("FILES", 3, 2 + Math.min(12, files.length), (s, ctx) => {
			if (files.length === 0) return noData(s, ctx);
			files.slice(0, s.h).forEach(([f, st], y) => {
				const tag = fileTag(st);
				s.text(0, y, cut(ctx, tildify(f), s.w - tag.length - 2), pal.text);
				s.textIn(0, y, s.w, tag, pal.dim, "right");
			});
		});

		// BRANCHES
		const node = this.page.branchTree;
		const nodes = node ? countNodes(node) : 1;
		one(
			"BRANCHES",
			4,
			2 + Math.min(20, nodes),
			(s, ctx) => {
				if (node === undefined) return void s.text(0, 0, `loading${ellipsis(ctx)}`, pal.dim);
				if (node === null) return void s.text(0, 0, "unavailable", pal.dim);
				if (node.children.length === 0) return void s.text(0, 0, "NO BRANCHES", pal.dim);
				tree(s, node, ctx);
			},
			r.branches ? `${r.branches} branches` : undefined,
		);
		return rows;
	}
}

function countNodes(n: TreeNode): number {
	return 1 + n.children.reduce((a, c) => a + countNodes(c), 0);
}

export class SessionDetailPage implements Page {
	readonly title = "SESSION";
	readonly rec: SessionRecord;
	/** undefined while loading, null when the file could not be read. */
	branchTree: TreeNode | null | undefined = undefined;
	private models: ModelEntry[] = [];
	private live: LiveSession | undefined;
	private started = false;
	private readonly app: App;
	private readonly grid: DetailGrid;

	constructor(app: App, rec: SessionRecord) {
		this.app = app;
		this.rec = rec;
		this.grid = new DetailGrid(this);
	}

	/** Catalogue entry of the main model, when known. */
	modelEntry(): ModelEntry | undefined {
		const m = mainModel(this.rec);
		return this.models.find((e) => `${e.provider}/${e.id}` === m);
	}

	enter(): void {
		this.live = liveSessions().get(this.rec.file);
		if (this.started) return;
		this.started = true;
		void loadModels()
			.then((m) => {
				this.models = m;
				this.app.requestRender();
			})
			.catch(() => {});
		readSessionTree(this.rec.file)
			.then((t) => {
				this.branchTree = compactTree(t);
			})
			.catch(() => {
				this.branchTree = null;
			})
			.finally(() => this.app.requestRender());
	}

	hints(): string {
		return "enter resume  f fork  e profile  esc back";
	}

	key(data: string, app: App): boolean {
		const r = this.rec;
		if (matchesKey(data, "enter")) return launchTarget(app, { kind: "resume", cwd: r.cwd, sessionFile: r.file }, r), true;
		if (data === "f") return launchTarget(app, { kind: "fork", cwd: r.cwd, sessionFile: r.file }, r), true;
		if (data === "e") {
			if (homeHooks.editProfile) homeHooks.editProfile(app, { kind: "resume", cwd: r.cwd, sessionFile: r.file }, r);
			else app.toast("profile editor not available", "error");
			return true;
		}
		return this.grid.key(data, app);
	}

	draw(full: Surface, app: App): void {
		const pal = app.pal;
		const r = this.rec;
		const s = full.inset(1, 0, 1, 0);
		s.text(0, 0, truncate(sessionTitle(r), s.w), pal.strong);
		const model = mainModel(r);
		s.text(0, 1, truncate(`${tildify(r.cwd)}  ${fmtDateTime(r.created)} → ${fmtDateTime(r.lastActivity)} (${fmtAgo(r.lastActivity)})  ${model ? shortModel(model) : ""}`, s.w), pal.dim);
		const status = this.live ? `OPEN in pi (pid ${this.live.pid})` : "idle";
		const stats = `TOKENS ${fmtTokens(totalTokens(r))}  COST ${fmtCost(r.cost)}${r.warmCost ? ` + warm-up ${fmtCost(r.warmCost)}` : ""}  ACTIVE ${fmtMinutes(r.activeMinutes)}  ${status}`;
		s.text(0, 2, truncate(stats, s.w), pal.text);
		s.text(0, 3, truncate(this.hints(), s.w), pal.faint);
		const body = s.sub(0, 5, s.w, Math.max(0, s.h - 5));
		this.grid.draw(body, app, NO_DATA);
	}
}

export function installSessionDetail(_app: App): void {
	navHandlers.openSession = (app, rec) => app.push(new SessionDetailPage(app, rec));
}
