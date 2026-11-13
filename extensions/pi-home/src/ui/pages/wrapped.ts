import { matchesKey } from "@earendil-works/pi-tui";
import { costStats, dailySeries, type DayStats, fileStats, hourWeekday, longestRuns, modelLabels, modelStats, streaks, toolStats, topCounts } from "../../index/aggregate.ts";
import { defaultFilter, filterSessions } from "../../index/query.ts";
import type { SessionRecord } from "../../index/types.ts";
import { Canvas, type Surface } from "../../term/canvas.ts";
import { oneLine, strWidth, truncate } from "../../term/width.ts";
import type { App, Page } from "../app.ts";
import { BIG_HEIGHT, bigTextScale, bigTextWidth, drawBigText } from "../bigtext.ts";
import { axisLabel, bigNumber, bigNumberWidth, type ChartCtx, cut, hbars, heatGrid, noData, polar24, sparkline, tagCloud, waffle } from "../charts/index.ts";
import { fmtCost, fmtDate, fmtDuration, fmtInt, fmtMinutes, fmtTokens, shortModel } from "../format.ts";
import { openSession } from "../nav.ts";
import { dayBadge } from "./analytics/time.ts";
import { dayRange, view } from "./analytics/layout.ts";

export type WrappedPeriod = "month" | "quarter" | "all";

const PERIOD_LABEL: Record<WrappedPeriod, string> = { month: "THIS MONTH", quarter: "THIS QUARTER", all: "ALL TIME" };

function periodRange(period: WrappedPeriod): { from: number; to: number } {
	const now = new Date();
	if (period === "all") return { from: 0, to: Number.POSITIVE_INFINITY };
	const month = period === "month" ? now.getMonth() : Math.floor(now.getMonth() / 3) * 3;
	return { from: new Date(now.getFullYear(), month, 1).getTime(), to: Number.POSITIVE_INFINITY };
}

const tokensOf = (d: DayStats): number => d.input + d.output + d.cacheRead + d.cacheWrite;
const shortPath = (p: string): string => p.split("/").slice(-2).join("/");

interface Data {
	records: SessionRecord[];
	empty: boolean;
	daily: Map<string, DayStats>;
	sessions: number;
	turns: number;
	tokens: number;
	cost: number;
	hours: number;
	busiest: { day: string; tokens: number; calls: number; hours: number[] } | null;
	models: ReturnType<typeof modelStats>;
	tools: ReturnType<typeof toolStats>;
	badge: ReturnType<typeof dayBadge>;
	hourly: number[];
	priciest: ReturnType<typeof costStats>["bySession"];
	files: ReturnType<typeof fileStats>["files"];
	added: number;
	deleted: number;
	run: ReturnType<typeof longestRuns>[number] | null;
	words: { key: string; count: number }[];
	label: (model: string) => string;
	streak: ReturnType<typeof streaks>;
}

function compute(app: App, period: WrappedPeriod): Data {
	const range = periodRange(period);
	const records = filterSessions(app.index.records.values(), { ...defaultFilter(), from: range.from, to: range.to, includeSubagents: view.includeSubagents });
	const daily = dailySeries(records, range);
	const sessionIds = new Set<string>();
	const models = modelStats(records, range);
	const labels = modelLabels(models.map((m) => m.model));
	const d: Omit<Data, "busiest"> = {
		records,
		empty: records.length === 0,
		daily,
		sessions: 0,
		turns: 0,
		tokens: 0,
		cost: 0,
		hours: 0,
		models,
		tools: toolStats(records, range),
		badge: dayBadge(hourWeekday(records, range)),
		hourly: new Array<number>(24).fill(0),
		priciest: costStats(records, range).bySession,
		files: fileStats(records).files.filter((f) => f.edit + f.write > 0).sort((a, b) => b.edit + b.write - (a.edit + a.write)),
		added: 0,
		deleted: 0,
		run: longestRuns(records, 1)[0] ?? null,
		words: topCounts(records, "words"),
		label: (m) => labels.get(m) ?? shortModel(m),
		streak: streaks(daily),
	};
	let best: { day: string; tokens: number; calls: number } | null = null;
	for (const [k, day] of daily) {
		for (const id of day.sessions) sessionIds.add(id);
		d.turns += day.userTurns;
		d.tokens += tokensOf(day);
		d.cost += day.cost + day.warmCost;
		d.hours += day.activeMinutes / 60;
		d.added += day.editAdd;
		d.deleted += day.editDel;
		if (!best || tokensOf(day) > best.tokens) best = { day: k, tokens: tokensOf(day), calls: day.calls };
	}
	d.sessions = sessionIds.size;
	let busiest: Data["busiest"] = null;
	if (best) {
		const hours = new Array<number>(24).fill(0);
		const r = dayRange(best.day);
		for (const rec of records) for (const t of rec.ev.cT) if (t >= r.from && t < r.to) hours[new Date(t).getHours()]!++;
		busiest = { ...best, hours };
	}
	for (const rec of records) for (const t of rec.ev.cT) if (t >= range.from) d.hourly[new Date(t).getHours()]!++;
	return { ...d, busiest };
}

interface Card {
	title: string;
	draw(s: Surface, ctx: ChartCtx, d: Data, app: App, period: WrappedPeriod): void;
	sentence(d: Data, period: WrappedPeriod): string;
}

const SENTENCE_BADGE: Record<string, string> = {
	"NIGHT OWL": "Most of your calls happen in the small hours.",
	"EARLY BIRD": "You start early: the morning is your prime time.",
	"WEEKEND WARRIOR": "Weekends are where much of your work happens.",
	"OFFICE HOURS": "You keep strict office hours, nine to six.",
	BALANCED: "Your work is spread evenly across the day and week.",
};

function bigText(s: Surface, y: number, text: string, ctx: ChartCtx): number {
	const pal = ctx.pal;
	const px = pal.caps.unicode ? bigTextScale(text, s.w) : 0;
	if (px === 0) {
		s.textIn(0, y + 1, s.w, truncate(text, s.w), pal.strong, "center");
		return 3;
	}
	drawBigText(s, Math.floor((s.w - bigTextWidth(text, px)) / 2), y, text, { fg: pal.p100 }, { fg: pal.p25 }, 1, px);
	return BIG_HEIGHT + 1;
}

function numberAt(s: Surface, x: number, y: number, w: number, text: string, compact: string, ctx: ChartCtx): void {
	const uni = ctx.pal.caps.unicode;
	const t = uni && bigNumberWidth(text) > w ? compact : text;
	bigNumber(s, x + Math.max(0, Math.floor((w - (uni ? bigNumberWidth(t) : strWidth(t))) / 2)), y, t, ctx);
}

const CARDS: Card[] = [
	{
		title: "YOUR PI YEAR",
		sentence: (d, p) => `${fmtMinutes(d.hours * 60)} with Pi across ${fmtInt(d.sessions)} sessions ${p === "all" ? "so far" : PERIOD_LABEL[p].toLowerCase()}.`,
		draw: (s, ctx, d) => {
			const p = ctx.progress ?? 1;
			const cells: [string, string, string][] = [
				["SESSIONS", fmtInt(d.sessions * p), axisLabel(d.sessions * p)],
				["TURNS", fmtInt(d.turns * p), axisLabel(d.turns * p)],
				["TOKENS", fmtTokens(d.tokens * p), axisLabel(d.tokens * p)],
				["COST", fmtCost(d.cost * p), axisLabel(d.cost * p, true)],
				["ACTIVE HOURS", (d.hours * p).toFixed(d.hours >= 100 ? 0 : 1), axisLabel(d.hours * p)],
			];
			const w = Math.floor(s.w / cells.length);
			const y = Math.max(0, Math.floor((s.h - 8) / 2));
			cells.forEach(([label, text, compact], i) => {
				s.textIn(i * w, y, w, label, ctx.pal.dim, "center");
				numberAt(s, i * w, y + 2, w - 1, text, compact, ctx);
			});
			const tokensPerDay = [...d.daily.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => tokensOf(v));
			sparkline(s, 0, y + 7, s.w, tokensPerDay, ctx.pal.dim, ctx);
		},
	},
	{
		title: "BUSIEST DAY",
		sentence: (d) => (d.busiest ? `${d.busiest.day}: ${fmtTokens(d.busiest.tokens)} tokens over ${fmtInt(d.busiest.calls)} calls.` : "No activity yet."),
		draw: (s, ctx, d) => {
			const b = d.busiest;
			if (!b) return noData(s, ctx);
			const y = Math.max(0, Math.floor((s.h - 9) / 2));
			const text = b.day;
			const uniW = ctx.pal.caps.unicode ? bigNumberWidth(text) : strWidth(text);
			bigNumber(s, Math.floor((s.w - uniW) / 2), y, text, ctx);
			const cellW = s.w >= 50 ? 2 : 1;
			const x0 = Math.floor((s.w - 24 * cellW) / 2);
			const max = Math.max(1, ...b.hours);
			[0, 6, 12, 18].forEach((h) => s.text(x0 + h * cellW, y + 4, String(h), ctx.pal.dim));
			heatGrid(s, x0, y + 5, 1, 24, (_, c) => b.hours[c]! / max, ctx, { cellW });
			s.textIn(0, y + 7, s.w, `${fmtTokens(b.tokens)} tokens`, ctx.pal.text, "center");
		},
	},
	{
		title: "FAVOURITES",
		sentence: (d) => `Favourite model: ${d.label(d.models[0]?.model ?? "none")}. Favourite tool: ${d.tools[0]?.tool ?? "none"}.`,
		draw: (s, ctx, d) => {
			const pal = ctx.pal;
			const half = Math.floor(s.w / 2);
			const cols = half >= 48 ? 10 : 6;
			const rows = Math.min(cols, Math.max(1, s.h - 2));
			const make = (items: { label: string; value: number }[]): { value: number; color: number; label: string }[] => {
				const parts = items.slice(0, 5).map((it, i) => ({ value: it.value, color: pal.series(i), label: it.label }));
				const rest = items.slice(5).reduce((a, it) => a + it.value, 0);
				if (rest > 0) parts.push({ value: rest, color: pal.series(5), label: "other" });
				return parts;
			};
			s.text(0, 0, "MODELS", pal.title);
			waffle(s.sub(0, 0, half, s.h), 0, 1, make(d.models.map((m) => ({ label: d.label(m.model), value: m.calls }))), ctx, { cols, rows });
			s.text(half + 1, 0, "TOOLS", pal.title);
			waffle(s.sub(half + 1, 0, s.w - half - 1, s.h), 0, 1, make(d.tools.map((t) => ({ label: t.tool, value: t.calls }))), ctx, { cols, rows });
		},
	},
	{
		title: "YOUR RHYTHM",
		sentence: (d) => SENTENCE_BADGE[d.badge.name] ?? "",
		draw: (s, ctx, d) => {
			const pal = ctx.pal;
			const clockW = Math.min(30, Math.floor(s.w / 2));
			const left = s.sub(0, 0, s.w - clockW - 2, s.h);
			const px = pal.caps.unicode ? bigTextScale(d.badge.name, left.w) : 0;
			const y = Math.max(0, Math.floor((s.h - 8) / 2));
			if (px > 0) drawBigText(left, Math.floor((left.w - bigTextWidth(d.badge.name, px)) / 2), y, d.badge.name, { fg: pal.p100 }, { fg: pal.p25 }, 1, px);
			else left.textIn(0, y + 1, left.w, d.badge.name, pal.strong, "center");
			left.textIn(0, y + 7, left.w, d.badge.pct > 0 ? `${d.badge.pct}% of your calls` : "no single pattern dominates", pal.text, "center");
			polar24(s.sub(s.w - clockW, 0, clockW, s.h), d.hourly, ctx);
		},
	},
	{
		title: "PRICIEST SESSION",
		sentence: (d) => (d.priciest[0] ? `One session cost ${fmtCost(d.priciest[0].cost)}: ${truncate(oneLine(d.priciest[0].title), 60)}` : "No cost recorded."),
		draw: (s, ctx, d, app) => {
			const top = d.priciest[0];
			if (!top) return noData(s, ctx);
			const text = fmtCost(top.cost * (ctx.progress ?? 1));
			numberAt(s, 0, 0, s.w, text, axisLabel(top.cost, true), ctx);
			s.textIn(0, 4, s.w, cut(ctx, oneLine(top.title), s.w), ctx.pal.strong, "center");
			s.textIn(0, 5, s.w, cut(ctx, shortPath(top.cwd), s.w), ctx.pal.dim, "center");
			const list = d.priciest.slice(0, Math.max(1, Math.min(5, s.h - 7)));
			const byId = new Map(d.records.map((r) => [r.id, r]));
			hbars(
				s.sub(Math.floor(s.w * 0.1), 7, Math.floor(s.w * 0.8), s.h - 7),
				list.map((x) => ({ label: oneLine(x.title), value: x.cost, valueLabel: fmtCost(x.cost) })),
				ctx,
				{ labelWidth: 26, onClick: (i) => byId.has(list[i]!.id) && openSession(app, byId.get(list[i]!.id)!) },
			);
		},
	},
	{
		title: "MOST EDITED FILE",
		sentence: (d) => (d.files[0] ? `${shortPath(d.files[0].path)} changed ${fmtInt(d.files[0].edit + d.files[0].write)} times; +${fmtInt(d.added)} / -${fmtInt(d.deleted)} lines overall.` : "No edits recorded."),
		draw: (s, ctx, d) => {
			const top = d.files[0];
			if (!top) return noData(s, ctx);
			numberAt(s, 0, 0, s.w, fmtInt((top.edit + top.write) * (ctx.progress ?? 1)), axisLabel(top.edit + top.write), ctx);
			s.textIn(0, 4, s.w, cut(ctx, top.path, s.w), ctx.pal.strong, "center");
			const list = d.files.slice(0, Math.max(1, Math.min(6, s.h - 6)));
			hbars(
				s.sub(Math.floor(s.w * 0.1), 6, Math.floor(s.w * 0.8), s.h - 6),
				list.map((f) => ({ label: shortPath(f.path), value: f.edit + f.write, valueLabel: fmtInt(f.edit + f.write) })),
				ctx,
				{ labelWidth: 28 },
			);
		},
	},
	{
		title: "LONGEST RUN",
		sentence: (d) => (d.run ? `One run kept the agent busy for ${fmtDuration(d.run.ms)}.` : "No long run recorded."),
		draw: (s, ctx, d) => {
			const r = d.run;
			if (!r) return noData(s, ctx);
			const hours = r.ms / 3_600_000;
			const value = (hours >= 1 ? hours : r.ms / 60_000) * (ctx.progress ?? 1);
			numberAt(s, 0, 1, s.w, value.toFixed(1), axisLabel(value), ctx);
			s.textIn(0, 5, s.w, hours >= 1 ? "HOURS" : "MINUTES", ctx.pal.dim, "center");
			const text = oneLine(r.prompt || r.title);
			const w = Math.min(s.w - 4, 70);
			for (let i = 0; i < 3; i++) {
				const chunk = text.slice(i * w * 2, (i + 1) * w * 2);
				if (chunk) s.textIn(0, 7 + i, s.w, cut(ctx, chunk, w), ctx.pal.text, "center");
			}
		},
	},
	{
		title: "YOUR WORDS",
		sentence: (d) => (d.words[0] ? `You said "${d.words[0].key}" more than anything else.` : "Not enough messages yet."),
		draw: (s, ctx, d) => tagCloud(s.sub(Math.floor(s.w * 0.05), 0, Math.floor(s.w * 0.9), s.h), d.words.slice(0, 70).map((w) => ({ text: w.key, weight: w.count })), ctx),
	},
	{
		title: "THAT IS A WRAP",
		sentence: () => "Thanks for building with Pi.",
		draw: (s, ctx, d, _app, period) => {
			const pal = ctx.pal;
			const rows: [string, string][] = [
				["PERIOD", PERIOD_LABEL[period]],
				["SESSIONS", fmtInt(d.sessions)],
				["TOKENS", fmtTokens(d.tokens)],
				["COST", fmtCost(d.cost)],
				["ACTIVE", fmtMinutes(d.hours * 60)],
				["TOP MODEL", d.label(d.models[0]?.model ?? "n/a")],
				["TOP TOOL", d.tools[0]?.tool ?? "n/a"],
				["LONGEST STREAK", `${d.streak.longest} days`],
				["DAY TYPE", d.badge.name],
				["BUSIEST DAY", d.busiest ? fmtDate(new Date(`${d.busiest.day}T12:00:00`).getTime()) : "n/a"],
			];
			const kw = Math.max(...rows.map(([k]) => k.length));
			const vw = Math.max(...rows.map(([, v]) => strWidth(v)));
			const x = Math.max(0, Math.floor((s.w - (kw + 3 + vw)) / 2));
			const y = Math.max(0, Math.floor((s.h - rows.length) / 2));
			rows.forEach(([k, v], i) => {
				s.text(x, y + i, k, pal.dim);
				s.text(x + kw + 1, y + i, ":", pal.faint);
				s.text(x + kw + 3, y + i, truncate(v, Math.max(1, s.w - x - kw - 3)), i === 3 ? pal.strong : pal.text);
			});
		},
	},
];

const ease = (t: number): number => 1 - (1 - Math.max(0, Math.min(1, t))) ** 3;

/** Pi Wrapped: nine full-screen cards over a month, quarter or all time. */
export class WrappedPage implements Page {
	readonly title = "WRAPPED";
	private card = 0;
	private dir = 1;
	private start = Date.now();
	private readonly data: Data;
	private readonly period: WrappedPeriod;

	constructor(app: App, period: WrappedPeriod) {
		this.period = period;
		this.data = compute(app, period);
	}

	enter(app: App): void {
		this.start = Date.now();
		app.animate(800);
	}

	hints(): string {
		return `<- -> card ${this.card + 1}/${CARDS.length}  click left/right half  esc back`;
	}

	private go(app: App, delta: number): void {
		const next = Math.max(0, Math.min(CARDS.length - 1, this.card + delta));
		if (next === this.card) return;
		this.dir = delta > 0 ? 1 : -1;
		this.card = next;
		this.start = Date.now();
		app.animate(800);
	}

	key(data: string, app: App): boolean {
		if (matchesKey(data, "right") || data === "l" || data === " ") return this.go(app, 1), true;
		if (matchesKey(data, "left") || data === "h") return this.go(app, -1), true;
		return false;
	}

	private drawCard(s: Surface, app: App, ctx: ChartCtx): void {
		const pal = app.pal;
		const card = CARDS[this.card]!;
		const inner = s.sub(2, 0, Math.max(0, s.w - 4), s.h);
		const titleH = bigText(inner, 1, card.title, ctx);
		const bodyTop = titleH + 2;
		const body = inner.sub(0, bodyTop, inner.w, Math.max(0, s.h - bodyTop - 4));
		if (this.data.empty) noData(body, ctx);
		else card.draw(body, ctx, this.data, app, this.period);
		inner.textIn(0, s.h - 3, inner.w, cut(ctx, card.sentence(this.data, this.period), inner.w), pal.text, "center");
		const uni = pal.caps.unicode;
		const bar = CARDS.map((_, i) => (i === this.card ? (uni ? "█" : "#") : uni ? "░" : ".")).join("");
		inner.textIn(0, s.h - 1, inner.w, bar, pal.dim, "center");
	}

	draw(s: Surface, app: App): void {
		const pal = app.pal;
		const elapsed = Date.now() - this.start;
		const progress = app.motion ? ease(elapsed / 700) : 1;
		const ctx: ChartCtx = { pal, progress };
		s.hit(0, 0, Math.floor(s.w / 2), s.h, { onClick: () => this.go(app, -1) });
		s.hit(Math.floor(s.w / 2), 0, s.w - Math.floor(s.w / 2), s.h, { onClick: () => this.go(app, 1) });
		const t = elapsed / 250;
		if (!app.motion || t >= 1) {
			this.drawCard(s, app, ctx);
			return;
		}
		// Slide in: render the card off-screen, then copy it shifted from the side.
		const tmp = new Canvas(s.w, s.h);
		tmp.clear(pal.p100, pal.screenBg);
		this.drawCard(tmp.root(), app, ctx);
		const off = Math.round((1 - ease(t)) * s.w * this.dir);
		const c = s.canvas;
		for (let y = 0; y < s.h; y++) {
			for (let x = 0; x < s.w; x++) {
				const dx = x + off;
				if (dx < 0 || dx >= s.w) continue;
				const si = y * tmp.w + x;
				const di = (s.y + y) * c.w + s.x + dx;
				const ch = tmp.ch[si]!;
				const wide = x + 1 < s.w && tmp.ch[si + 1] === "";
				c.ch[di] = (ch === "" && (dx === 0 || x === 0)) || (wide && dx === s.w - 1) ? " " : ch;
				c.fg[di] = tmp.fg[si]!;
				c.bg[di] = tmp.bg[si]!;
				c.at[di] = tmp.at[si]!;
			}
		}
		app.animate(100);
	}
}
