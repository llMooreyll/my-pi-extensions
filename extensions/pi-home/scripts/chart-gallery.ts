// Dev tool: renders every chart with synthetic data, then checks that no chart draws outside its
// surface and that only whitelisted glyphs are used.
// Usage: node scripts/chart-gallery.ts [truecolor|256|plain] [width] [height]
import { Canvas, Surface } from "../src/term/canvas.ts";
import { detectCaps, type TierSetting } from "../src/term/caps.ts";
import { Renderer } from "../src/term/renderer.ts";
import { loadThemeColors, makePalette, type Palette } from "../src/theme.ts";
import * as C from "../src/ui/charts/index.ts";
import type { ChartCtx } from "../src/ui/charts/index.ts";

const tier = (process.argv[2] ?? "truecolor") as TierSetting;
const width = Number(process.argv[3] ?? 120);
const height = Number(process.argv[4] ?? 30);
if (!["truecolor", "256", "plain"].includes(tier)) throw new Error(`bad tier: ${tier}`);

const env = { ...process.env, PI_HOME_TIER: undefined };
const pal: Palette = makePalette(loadThemeColors(), detectCaps(env, tier, false));
const ctx: ChartCtx = { pal, progress: 1 };

let seed = 12345;
const rnd = (): number => {
	seed = (seed * 1664525 + 1013904223) % 4294967296;
	return seed / 4294967296;
};
const arr = (n: number, f: (i: number) => number): number[] => Array.from({ length: n }, (_, i) => f(i));
const series = (i: number) => pal.series(i);

type Run = (s: Surface, empty: boolean) => void;
const charts: { name: string; run: Run }[] = [
	{ name: "sparkline", run: (s, e) => C.sparkline(s, 0, 0, Math.min(s.w, 40), e ? [] : arr(60, (i) => 5 + 4 * Math.sin(i / 4) + rnd() * 3), pal.text, ctx) },
	{
		name: "hbars",
		run: (s, e) =>
			C.hbars(
				s,
				e ? [] : ["opus-5-5", "sonnet-5", "haiku-5-5", "gemini-3.8", "deepseek"].map((label, i) => ({ label, value: 900 - i * 170, part: i === 1 ? 120 : undefined, color: series(i) })),
				ctx,
				{ onClick: () => {} },
			),
	},
	{
		name: "vbars (stacked, y axis)",
		run: (s, e) =>
			C.vbars(s, e ? [] : arr(30, (i) => [20 + (i % 7) * 3, 40 + rnd() * 30, 10 + rnd() * 10, 8 + rnd() * 8]), [series(0), series(1), series(2), series(3)], ctx, {
				yAxis: true,
				xLabels: arr(30, (i) => `${i + 1}`),
			}),
	},
	{ name: "mirrorBars", run: (s, e) => C.mirrorBars(s, e ? [] : arr(30, () => rnd() * 100), e ? [] : arr(30, () => rnd() * 60), ctx, { xLabels: arr(30, (i) => `${i + 1}`) }) },
	{
		name: "heatGrid (punch card)",
		run: (s, e) => {
			C.heatGrid(s, 4, 0, 7, 24, (r, c) => (e ? 0 : Math.max(0, Math.sin((c - 6) / 4) * (r < 5 ? 1 : 0.4) + rnd() * 0.2)), ctx, {
				cursor: { r: 2, c: 10 },
				onClick: () => {},
			});
		},
	},
	{
		name: "calendarHeat",
		run: (s, e) => {
			const days = new Map<string, number>();
			if (!e) for (let i = 0; i < 300; i++) days.set(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10), rnd() * 100);
			C.calendarHeat(s, days, ctx, { weeks: 53, cursor: new Date().toISOString().slice(0, 10), onClick: () => {} });
		},
	},
	{
		name: "lineChart (area, markers)",
		run: (s, e) =>
			C.lineChart(s, e ? [] : [{ values: arr(40, (i) => i * i * 0.3 + rnd() * 20), color: series(0) }, { values: arr(40, (i) => i * 8), color: series(1) }], ctx, {
				area: true,
				yAxis: true,
				money: true,
				markers: [
					{ index: 10, label: "$1" },
					{ index: 30, label: "$100" },
				],
			}),
	},
	{ name: "scatter (log)", run: (s, e) => C.scatter(s, e ? [] : arr(60, (i) => ({ x: 10 ** (rnd() * 3), y: 10 ** (rnd() * 3), color: series(i % 4) })), ctx, { xLabel: "latency", yLabel: "output", logX: true, logY: true }) },
	{
		name: "donut",
		run: (s, e) =>
			C.donut(
				s,
				e
					? []
					: [
							{ value: 55, color: series(0), label: "builtin" },
							{ value: 30, color: series(1), label: "extension" },
							{ value: 15, color: series(2), label: "mcp" },
						],
				ctx,
			),
	},
	{ name: "radar", run: (s, e) => C.radar(s, e ? [] : ["SPEED", "PRICE", "VOLUME", "RELIABILITY", "CACHE"].map((label) => ({ label, value: 0.3 + rnd() * 0.7 })), ctx) },
	{ name: "polar24", run: (s, e) => C.polar24(s, e ? [] : arr(24, (h) => (h > 8 && h < 20 ? 50 + rnd() * 50 : rnd() * 10)), ctx) },
	{
		name: "violin (log)",
		run: (s, e) => C.violin(s, ["opus", "sonnet", "haiku"].map((label, i) => ({ label, color: series(i), values: e ? [] : arr(200, () => 10 ** (1 + i * 0.5 + rnd() * 1.5)) })), ctx, { log: true }),
	},
	{
		name: "waffle",
		run: (s, e) =>
			C.waffle(
				s,
				2,
				0,
				e
					? []
					: [
							{ value: 62, color: series(0), label: "opus" },
							{ value: 25, color: series(1), label: "sonnet" },
							{ value: 9, color: series(2), label: "haiku" },
							{ value: 4, color: series(3), label: "other" },
						],
				ctx,
				{ cols: 10, rows: Math.min(10, Math.max(1, s.h)) },
			),
	},
	{ name: "treemap", run: (s, e) => C.treemap(s, e ? [] : ["pi-home", "dotfiles", "blog", "notes", "scripts", "infra", "misc"].map((label, i) => ({ label, value: 100 / (i + 1) })), ctx, { onClick: () => {} }) },
	{ name: "boxplot (log)", run: (s, e) => C.boxplot(s, ["read", "bash", "edit", "grep"].map((label, i) => ({ label, values: e ? [] : arr(100, () => 10 ** (1 + i * 0.4 + rnd() * 2)) })), ctx, { log: true }) },
	{
		name: "gantt",
		run: (s, e) => {
			const now = Date.now();
			C.gantt(s, e ? [] : ["pi-home", "dotfiles", "blog", "notes"].map((label, i) => ({ label, start: now - (90 - i * 15) * 86_400_000, end: now - i * 8 * 86_400_000, color: series(i) })), now - 100 * 86_400_000, now, ctx);
		},
	},
	{
		name: "tree",
		run: (s, e) => {
			const root: C.TreeNode = e
				? { label: "", children: [] }
				: { label: "main session", detail: "42 turns", children: [{ label: "scout", detail: "3m", children: [{ label: "reader", children: [] }] }, { label: "worker", children: [] }] };
			C.tree(s, root, ctx);
		},
	},
	{
		name: "flow",
		run: (s, e) =>
			C.flow(
				s,
				e
					? []
					: [
							{ from: "opus", to: "sonnet", value: 40 },
							{ from: "opus", to: "haiku", value: 5 },
							{ from: "sonnet", to: "opus", value: 400 },
							{ from: "haiku", to: "sonnet", value: 2000 },
						],
				ctx,
			),
	},
	{
		name: "bigNumber",
		run: (s, e) => {
			if (e) return C.noData(s, ctx);
			const w = C.bigNumber(s, 0, 0, "$1,234.56", ctx);
			C.bigNumber(s, w + 3, 0, "98.5% 12K 3M 4B -7", ctx);
		},
	},
	{
		name: "tagCloud",
		run: (s, e) => C.tagCloud(s, e ? [] : ["refactor", "please", "thanks", "fix", "test", "config", "git", "analytics", "tmux", "pi", "chart", "index"].map((text, i) => ({ text, weight: 100 / (i + 1) })), ctx),
	},
	{
		name: "legend + niceMax + axisLabel",
		run: (s, e) => {
			if (e) return C.noData(s, ctx);
			const x = C.legend(s, 0, 0, [{ label: "input", color: series(0) }, { label: "output", color: series(1) }], ctx);
			s.text(x + 2, 0, [0, 950, 1200, 3e6, 7.5e9].map((v) => C.axisLabel(v)).join(" ") + " " + C.axisLabel(4.2, true) + " " + C.niceMax(137), pal.dim);
		},
	},
];

const ALLOWED = /^[\x20-\x7e─│┌┐└┘├┤┬┴┼═║╔╗╚╝╟╢━┃\u2580-\u259f\u2800-\u28ff·…›»→←↑↓]*$/;

function snapshot(c: Canvas): string {
	return JSON.stringify([c.ch, Array.from(c.fg), Array.from(c.bg), Array.from(c.at)]);
}

/** Fill a canvas with a recognisable pattern so any stray write is detected. */
function sentinel(w: number, h: number): Canvas {
	const c = new Canvas(w, h);
	for (let i = 0; i < w * h; i++) {
		c.ch[i] = String.fromCharCode(0x41 + (i % 26));
		c.fg[i] = 0x100000 + i;
		c.bg[i] = 0x200000 + i;
		c.at[i] = i % 3;
	}
	return c;
}

function checkOutside(name: string, label: string, w: number, h: number, sx: number, sy: number, sw: number, sh: number, run: Run, empty: boolean): void {
	const c = sentinel(w, h);
	const before = sentinel(w, h);
	run(new Surface(c, sx, sy, sw, sh), empty);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (x >= sx && x < sx + sw && y >= sy && y < sy + sh) {
				const ch = c.ch[y * w + x]!;
				if (!ALLOWED.test(ch)) throw new Error(`${name} [${label}]: glyph ${JSON.stringify(ch)} not in whitelist`);
				if (!pal.caps.unicode && /[^\x20-\x7e]/.test(ch)) throw new Error(`${name} [${label}]: non-ASCII glyph without unicode`);
				continue;
			}
			const i = y * w + x;
			if (c.ch[i] !== before.ch[i] || c.fg[i] !== before.fg[i] || c.bg[i] !== before.bg[i] || c.at[i] !== before.at[i]) {
				throw new Error(`${name} [${label}]: cell (${x},${y}) outside the surface changed`);
			}
		}
	}
	void snapshot;
}

// 1. Containment and glyph checks at hostile sizes.
for (const ch of charts) {
	checkOutside(ch.name, "1x1", 20, 10, 5, 3, 1, 1, ch.run, false);
	checkOutside(ch.name, "8x3", 24, 10, 5, 3, 8, 3, ch.run, false);
	checkOutside(ch.name, "empty", 60, 20, 5, 3, 40, 12, ch.run, true);
	checkOutside(ch.name, "full", width + 6, height + 4, 3, 2, width, height - 1, ch.run, false);
}

// 2. Print the gallery, one screen-height block per chart.
const out: string[] = [];
const renderer = new Renderer((s) => out.push(s.replace(/\x1b\[\?2026[hl]/g, "").replace(/\x1b\[\d+;1H/g, "\n")));
for (const ch of charts) {
	const canvas = new Canvas(width, height);
	canvas.clear(pal.text.fg!, pal.screenBg);
	const root = canvas.root();
	root.text(0, 0, `== ${ch.name} [${tier}] ==`, pal.title);
	seed = 777;
	ch.run(root.sub(0, 1, width, height - 1), false);
	renderer.invalidate();
	renderer.render(canvas, pal.caps.colorMode);
	process.stdout.write(`${out.join("").replace(/^\n/, "")}\x1b[0m\n`);
	out.length = 0;
}
