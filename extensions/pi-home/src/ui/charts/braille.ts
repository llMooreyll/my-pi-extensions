import type { Surface } from "../../term/canvas.ts";
import type { RGB } from "../../term/color.ts";
import { strWidth } from "../../term/width.ts";
import { axisLabel, type ChartCtx, fgOf, markerGlyph, niceMax, noData, prog, seriesGlyph, tooSmall, ellipsis, cut, padCut } from "./common.ts";

// Braille dot bit for [column][row] inside a cell.
const BIT = [
	[0x01, 0x02, 0x04, 0x40],
	[0x08, 0x10, 0x20, 0x80],
];

function popcount(n: number): number {
	let c = 0;
	for (let v = n; v; v &= v - 1) c++;
	return c;
}

function plotLine(cv: BrailleCanvas, x0: number, y0: number, x1: number, y1: number, color: RGB | undefined, every: number): void {
	let x = Math.round(x0);
	let y = Math.round(y0);
	const xe = Math.round(x1);
	const ye = Math.round(y1);
	const dx = Math.abs(xe - x);
	const dy = -Math.abs(ye - y);
	const sx = x < xe ? 1 : -1;
	const sy = y < ye ? 1 : -1;
	let err = dx + dy;
	for (let step = 0; ; step++) {
		if (step % every < Math.ceil(every / 2)) cv.set(x, y, color);
		if (x === xe && y === ye) break;
		const e2 = 2 * err;
		if (e2 >= dy) {
			err += dy;
			x += sx;
		}
		if (e2 <= dx) {
			err += dx;
			y += sy;
		}
	}
}

/**
 * Dot canvas: each terminal cell holds 2x4 braille dots. `pw` x `ph` is the dot resolution.
 * Colour is per cell: the last colour written to a cell wins. Cells without dots are not drawn.
 * Set `ascii = true` (charts do this when pal.caps.unicode is false) to draw `.`, `*`, `#` by dot
 * count instead of braille glyphs.
 */
export class BrailleCanvas {
	readonly pw: number;
	readonly ph: number;
	ascii = false;
	private readonly wCells: number;
	private readonly hCells: number;
	private readonly bits: Uint8Array;
	private readonly colors: Int32Array;

	constructor(wCells: number, hCells: number) {
		this.wCells = Math.max(0, wCells);
		this.hCells = Math.max(0, hCells);
		this.pw = this.wCells * 2;
		this.ph = this.hCells * 4;
		this.bits = new Uint8Array(this.wCells * this.hCells);
		this.colors = new Int32Array(this.wCells * this.hCells).fill(-1);
	}

	/** Set one dot (dot coordinates); out-of-range dots are ignored. */
	set(px: number, py: number, color?: RGB): void {
		const x = Math.round(px);
		const y = Math.round(py);
		if (x < 0 || y < 0 || x >= this.pw || y >= this.ph) return;
		const i = (y >> 2) * this.wCells + (x >> 1);
		this.bits[i]! |= BIT[x & 1]![y & 3]!;
		if (color !== undefined) this.colors[i] = color;
	}

	/** Bresenham line between two dots. */
	line(x0: number, y0: number, x1: number, y1: number, color?: RGB): void {
		plotLine(this, x0, y0, x1, y1, color, 1);
	}

	/** Draw every non-empty cell at (x, y) on the surface; cells without a colour use `fallback`. */
	draw(s: Surface, x: number, y: number, fallback: RGB): void {
		for (let cy = 0; cy < this.hCells; cy++) {
			for (let cx = 0; cx < this.wCells; cx++) {
				const i = cy * this.wCells + cx;
				const b = this.bits[i]!;
				if (b === 0) continue;
				const n = popcount(b);
				const ch = this.ascii ? (n >= 5 ? "#" : n >= 3 ? "*" : ".") : String.fromCharCode(0x2800 + b);
				const c = this.colors[i]!;
				s.text(x + cx, y + cy, ch, fgOf(c === -1 ? fallback : c));
			}
		}
	}
}

function canvas(ctx: ChartCtx, wCells: number, hCells: number): BrailleCanvas {
	const cv = new BrailleCanvas(wCells, hCells);
	cv.ascii = !ctx.pal.caps.unicode;
	return cv;
}

/** Tier 0 has no colour: thin series i out so that densities differ. */
function keepDot(ctx: ChartCtx, i: number, px: number, py: number): boolean {
	if (ctx.pal.caps.tier !== 0) return true;
	switch (i % 3) {
		case 1:
			return (px + py) % 2 === 0;
		case 2:
			return px % 2 === 0 && py % 2 === 0;
		default:
			return true;
	}
}

/**
 * Braille line chart of one or more series, x spread over the width. Minimum 8 columns x 3 rows.
 * `area` stipples the area under each line; `min`/`max` fix the value range (default 0..nice max
 * with a y axis, 0..data max without); `yAxis` draws three tick labels (`money` formats them);
 * `markers` put a `↓` one row above the point at `index` with its label to the right (the top
 * row is reserved for them). Series after the first are dashed in tier 0.
 */
export function lineChart(
	s: Surface,
	series: { values: number[]; color: RGB }[],
	ctx: ChartCtx,
	opts: {
		area?: boolean;
		min?: number;
		max?: number;
		yAxis?: boolean;
		money?: boolean;
		markers?: { index: number; label: string }[];
	} = {},
): void {
	if (tooSmall(s, ctx, 8, 3)) return;
	const all = series.flatMap((sr) => sr.values).filter(Number.isFinite);
	const dataMax = Math.max(0, ...all);
	if (all.length === 0 || !(dataMax > 0 || (opts.max ?? 0) > 0)) return noData(s, ctx);
	const pal = ctx.pal;
	const min = opts.min ?? Math.min(0, ...all);
	const max = opts.max ?? (opts.yAxis ? niceMax(dataMax) : dataMax);
	const span = max - min || 1;
	const yOff = opts.markers?.length ? 1 : 0;
	const ticks = opts.yAxis ? [max, (max + min) / 2, min].map((v) => axisLabel(v, opts.money)) : [];
	const aw = opts.yAxis ? Math.max(...ticks.map(strWidth)) + 1 : 0;
	const wC = s.w - aw;
	const hC = s.h - yOff;
	if (wC < 2 || hC < 2) {
		s.text(0, 0, ellipsis(ctx), pal.dim);
		return;
	}
	if (opts.yAxis) {
		s.vline(aw - 1, yOff, hC, pal.faint, pal.caps.unicode ? "│" : "|");
		s.textIn(0, yOff, aw - 1, ticks[0]!, pal.dim, "right");
		if (hC > 4) s.textIn(0, yOff + Math.floor((hC - 1) / 2), aw - 1, ticks[1]!, pal.dim, "right");
		s.textIn(0, s.h - 1, aw - 1, ticks[2]!, pal.dim, "right");
	}
	const cv = canvas(ctx, wC, hC);
	const p = prog(ctx);
	const yOf = (v: number): number => cv.ph - 1 - Math.max(0, Math.min(1, ((v - min) / span) * p)) * (cv.ph - 1);
	const points: { px: number; py: number }[][] = [];
	series.forEach((sr, si) => {
		const n = sr.values.length;
		const pts = sr.values.map((v, i) => ({ px: n <= 1 ? (cv.pw - 1) / 2 : (i * (cv.pw - 1)) / (n - 1), py: yOf(Number.isFinite(v) ? v : min) }));
		points.push(pts);
		if (opts.area) {
			// Stipple below the polyline for every dot column, interpolating between samples.
			for (let i = 1; i < pts.length; i++) {
				const a = pts[i - 1]!;
				const b = pts[i]!;
				for (let px = Math.round(a.px); px <= Math.round(b.px); px++) {
					const f = b.px === a.px ? 0 : (px - a.px) / (b.px - a.px);
					const top = Math.round(a.py + (b.py - a.py) * f);
					for (let y = top; y < cv.ph; y++) if ((px + y) % 2 === 0 && keepDot(ctx, si, px, y)) cv.set(px, y, sr.color);
				}
			}
		}
		if (pts.length === 1) cv.set(pts[0]!.px, pts[0]!.py, sr.color);
		for (let i = 1; i < pts.length; i++) plotLine(cv, pts[i - 1]!.px, pts[i - 1]!.py, pts[i]!.px, pts[i]!.py, sr.color, pal.caps.tier === 0 && si % 3 === 2 ? 3 : 1);
	});
	cv.draw(s, aw, yOff, pal.p100);
	if (yOff) {
		const pts = points[0] ?? [];
		let lastEnd = -1;
		for (const m of [...(opts.markers ?? [])].sort((a, b) => a.index - b.index)) {
			const pt = pts[m.index];
			if (!pt) continue;
			const cx = aw + Math.floor(pt.px / 2);
			const cy = Math.max(0, yOff + Math.floor(pt.py / 4) - 1);
			if (cx <= lastEnd) continue;
			s.text(cx, cy, markerGlyph(ctx), pal.strong);
			const t = cut(ctx, m.label, s.w - cx - 2);
			if (t) s.text(cx + 2, cy, t, pal.dim);
			lastEnd = cx + 2 + strWidth(t);
		}
	}
}

/**
 * Scatter plot of coloured points (2x2 dots each) inside an L-shaped axis. Minimum 10 columns x
 * 4 rows. `xLabel` goes on the last row, `yLabel` on the first; `logX`/`logY` use log10 scaling
 * (points with a value <= 0 on a log axis are skipped).
 */
export function scatter(
	s: Surface,
	points: { x: number; y: number; color: RGB }[],
	ctx: ChartCtx,
	opts: { xLabel?: string; yLabel?: string; logX?: boolean; logY?: boolean } = {},
): void {
	if (tooSmall(s, ctx, 10, 4)) return;
	const pal = ctx.pal;
	const fx = (v: number): number => (opts.logX ? Math.log10(v) : v);
	const fy = (v: number): number => (opts.logY ? Math.log10(v) : v);
	const pts = points.filter((q) => Number.isFinite(q.x) && Number.isFinite(q.y) && (!opts.logX || q.x > 0) && (!opts.logY || q.y > 0));
	if (pts.length === 0) return noData(s, ctx);
	const top = opts.yLabel ? 1 : 0;
	const bottom = opts.xLabel ? 1 : 0;
	const hC = s.h - top - bottom - 1;
	const wC = s.w - 1;
	if (hC < 2 || wC < 4) {
		s.text(0, 0, ellipsis(ctx), pal.dim);
		return;
	}
	const xs = pts.map((q) => fx(q.x));
	const ys = pts.map((q) => fy(q.y));
	const x0 = Math.min(...xs);
	const x1 = Math.max(...xs);
	const y0 = Math.min(...ys);
	const y1 = Math.max(...ys);
	const cv = canvas(ctx, wC, hC);
	const p = prog(ctx);
	const shown = Math.ceil(pts.length * p);
	for (let i = 0; i < shown; i++) {
		const px = x1 === x0 ? cv.pw / 2 : 1 + ((xs[i]! - x0) / (x1 - x0)) * (cv.pw - 3);
		const py = y1 === y0 ? cv.ph / 2 : 1 + (1 - (ys[i]! - y0) / (y1 - y0)) * (cv.ph - 3);
		const c = pts[i]!.color;
		for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) cv.set(px + dx - 0.5, py + dy - 0.5, c);
	}
	const uni = pal.caps.unicode;
	s.vline(0, top, hC + 1, pal.faint, uni ? "│" : "|");
	s.hline(1, top + hC, wC, pal.faint, uni ? "─" : "-");
	s.put(0, top + hC, uni ? "└" : "+", pal.faint);
	cv.draw(s, 1, top, pal.p100);
	if (opts.yLabel) s.text(0, 0, cut(ctx, opts.yLabel, s.w), pal.dim);
	if (opts.xLabel) s.textIn(0, s.h - 1, s.w, cut(ctx, opts.xLabel, s.w), pal.dim, "right");
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * Donut: braille ring on the left (starts at 12 o'clock, clockwise, sweeps in with progress),
 * legend with percentages on the right. Minimum 20 columns x 3 rows. Tier 0 separates slices by
 * dot density.
 */
export function donut(s: Surface, slices: { value: number; color: RGB; label: string }[], ctx: ChartCtx): void {
	if (tooSmall(s, ctx, 20, 3)) return;
	const total = slices.reduce((a, b) => a + Math.max(0, b.value), 0);
	if (!(total > 0)) return noData(s, ctx);
	const pal = ctx.pal;
	const hC = Math.min(s.h, 10, Math.floor((s.w - 14) / 2));
	if (hC < 3) {
		s.text(0, 0, ellipsis(ctx), pal.dim);
		return;
	}
	const wC = hC * 2;
	const cv = canvas(ctx, wC, hC);
	const cx = (cv.pw - 1) / 2;
	const cy = (cv.ph - 1) / 2;
	const R = cv.ph / 2 - 0.5;
	const r0 = R * 0.6;
	const cum: number[] = [];
	let acc = 0;
	for (const sl of slices) {
		acc += Math.max(0, sl.value) / total;
		cum.push(acc);
	}
	const p = prog(ctx);
	for (let py = 0; py < cv.ph; py++) {
		for (let px = 0; px < cv.pw; px++) {
			const dx = px - cx;
			const dy = py - cy;
			const d = Math.hypot(dx, dy);
			if (d > R || d < r0) continue;
			let f = Math.atan2(dx, -dy) / (2 * Math.PI);
			if (f < 0) f += 1;
			if (f > p) continue;
			const i = Math.min(slices.length - 1, cum.findIndex((c) => f < c + 1e-9));
			if (i < 0 || !keepDot(ctx, i, px, py)) continue;
			cv.set(px, py, slices[i]!.color);
		}
	}
	const oy = Math.floor((s.h - hC) / 2);
	cv.draw(s, 0, oy, pal.p100);
	const lx = wC + 2;
	const rows = Math.min(slices.length, s.h);
	const ly = Math.floor((s.h - rows) / 2);
	const labelW = Math.max(1, s.w - lx - 2 - 5);
	slices.slice(0, rows).forEach((sl, i) => {
		const y = ly + i;
		s.text(lx, y, seriesGlyph(ctx, i, slices.length), fgOf(sl.color));
		s.text(lx + 2, y, padCut(ctx, sl.label, Math.min(labelW, strWidth(sl.label))), pal.text);
		s.textIn(lx + 2, y, s.w - lx - 2, pct(Math.max(0, sl.value) / total), pal.dim, "right");
	});
}

/**
 * Radar chart: `axes` values 0..1 (clamped) as a polygon with spokes, labels outside the tips.
 * Minimum 20 columns x 9 rows (at least 3 axes). The polygon grows from the centre with progress.
 */
export function radar(s: Surface, axes: { label: string; value: number }[], ctx: ChartCtx): void {
	if (tooSmall(s, ctx, 20, 9)) return;
	if (axes.length < 3) return noData(s, ctx);
	const pal = ctx.pal;
	const labelW = Math.min(Math.max(...axes.map((a) => strWidth(a.label))), Math.floor(s.w / 4));
	const hC = Math.min(s.h - 2, Math.floor((s.w - 2 * (labelW + 1)) / 2));
	if (hC < 4) {
		s.text(0, 0, ellipsis(ctx), pal.dim);
		return;
	}
	const wC = hC * 2;
	const ox = Math.floor((s.w - wC) / 2);
	const oy = Math.floor((s.h - hC) / 2);
	const cv = canvas(ctx, wC, hC);
	const cx = (cv.pw - 1) / 2;
	const cy = (cv.ph - 1) / 2;
	const R = cv.ph / 2 - 1;
	const n = axes.length;
	const ang = (k: number): number => -Math.PI / 2 + (k * 2 * Math.PI) / n;
	const p = prog(ctx);
	const ring = (scaleR: number, every: number): void => {
		for (let k = 0; k < n; k++) {
			const a = ang(k);
			const b = ang(k + 1);
			plotLine(cv, cx + Math.cos(a) * R * scaleR, cy + Math.sin(a) * R * scaleR, cx + Math.cos(b) * R * scaleR, cy + Math.sin(b) * R * scaleR, pal.faint.fg, every);
		}
	};
	ring(1, 2);
	ring(0.5, 4);
	for (let k = 0; k < n; k++) plotLine(cv, cx, cy, cx + Math.cos(ang(k)) * R, cy + Math.sin(ang(k)) * R, pal.faint.fg, 2);
	const tip = (k: number): [number, number] => {
		const v = Math.max(0, Math.min(1, axes[k]!.value)) * p;
		return [cx + Math.cos(ang(k)) * R * v, cy + Math.sin(ang(k)) * R * v];
	};
	for (let k = 0; k < n; k++) {
		const [ax, ay] = tip(k);
		const [bx, by] = tip((k + 1) % n);
		plotLine(cv, ax, ay, bx, by, pal.p100, 1);
	}
	cv.draw(s, ox, oy, pal.p100);
	axes.forEach((a, k) => {
		const c = Math.cos(ang(k));
		const sn = Math.sin(ang(k));
		const col = ox + Math.floor((cx + c * R) / 2);
		const row = oy + Math.floor((cy + sn * R) / 4) + (sn < -0.3 ? -1 : sn > 0.3 ? 1 : 0);
		if (row < 0 || row >= s.h) return;
		if (c > 0.3) s.text(col + 1, row, cut(ctx, a.label, s.w - col - 1), pal.text);
		else if (c < -0.3) {
			const t = cut(ctx, a.label, col);
			s.text(col - strWidth(t), row, t, pal.text);
		} else {
			const t = cut(ctx, a.label, s.w);
			s.text(Math.max(0, Math.min(s.w - strWidth(t), col - Math.floor(strWidth(t) / 2))), row, t, pal.text);
		}
	});
}

/**
 * 24-hour clock face: one radial bar per hour (0 at 12 o'clock, clockwise), coloured by
 * pal.ramp(value / max), hour labels 0/6/12/18 outside. Minimum 12 columns x 7 rows.
 */
export function polar24(s: Surface, values: number[], ctx: ChartCtx): void {
	if (tooSmall(s, ctx, 12, 7)) return;
	const max = Math.max(0, ...values.slice(0, 24));
	if (!(max > 0)) return noData(s, ctx);
	const pal = ctx.pal;
	const hC = Math.min(s.h - 2, Math.floor((s.w - 6) / 2));
	if (hC < 3) {
		s.text(0, 0, ellipsis(ctx), pal.dim);
		return;
	}
	const wC = hC * 2;
	const ox = Math.floor((s.w - wC) / 2);
	const oy = Math.floor((s.h - hC) / 2);
	const cv = canvas(ctx, wC, hC);
	const cx = (cv.pw - 1) / 2;
	const cy = (cv.ph - 1) / 2;
	const R = cv.ph / 2 - 0.5;
	const r0 = R * 0.3;
	const p = prog(ctx);
	for (let h = 0; h < 24; h++) {
		const v = Math.max(0, values[h] ?? 0) / max;
		if (v <= 0) continue;
		const rEnd = r0 + (R - r0) * v * p;
		for (const off of [-0.09, 0, 0.09]) {
			const a = -Math.PI / 2 + ((h + 0.5) * 2 * Math.PI) / 24 + off;
			plotLine(cv, cx + Math.cos(a) * r0, cy + Math.sin(a) * r0, cx + Math.cos(a) * rEnd, cy + Math.sin(a) * rEnd, pal.ramp(Math.max(0.3, v)), 1);
		}
	}
	cv.draw(s, ox, oy, pal.p100);
	s.textIn(ox, Math.max(0, oy - 1), wC, "0", pal.dim, "center");
	s.textIn(ox, Math.min(s.h - 1, oy + hC), wC, "12", pal.dim, "center");
	s.text(Math.max(0, ox - 3), oy + Math.floor(hC / 2), "18", pal.dim);
	s.text(ox + wC + 1, oy + Math.floor(hC / 2), "6", pal.dim);
}

/**
 * One horizontal violin per group: density mirrored around a centre line, a median tick `|`.
 * Labels on the left, min/max axis labels on the last row. Minimum 16 columns x 3 rows. `log`
 * uses log10 of the values (values <= 0 ignored). Groups beyond the height are dropped.
 */
export function violin(
	s: Surface,
	groups: { label: string; values: number[]; color: RGB }[],
	ctx: ChartCtx,
	opts: { log?: boolean } = {},
): void {
	if (tooSmall(s, ctx, 16, 3)) return;
	const pal = ctx.pal;
	const tf = (v: number): number => (opts.log ? Math.log10(v) : v);
	const prep = groups.map((g) => g.values.filter((v) => Number.isFinite(v) && (!opts.log || v > 0)).sort((a, b) => a - b));
	const flat = prep.flat();
	if (flat.length === 0) return noData(s, ctx);
	const shown = Math.min(groups.length, s.h - 1);
	const lw = Math.min(Math.max(...groups.slice(0, shown).map((g) => strWidth(g.label))), Math.floor(s.w / 3));
	const wC = s.w - lw - 1;
	if (wC < 6 || shown < 1) {
		s.text(0, 0, ellipsis(ctx), pal.dim);
		return;
	}
	const band = Math.max(1, Math.floor((s.h - 1) / shown));
	const cv = canvas(ctx, wC, band * shown);
	const lo = tf(Math.min(...flat));
	const hi = tf(Math.max(...flat));
	const range = hi - lo || 1;
	const p = prog(ctx);
	const sigma = Math.max(1, cv.pw / 30);
	for (let g = 0; g < shown; g++) {
		const vals = prep[g]!;
		if (vals.length === 0) continue;
		const hist = new Array<number>(cv.pw).fill(0);
		for (const v of vals) hist[Math.min(cv.pw - 1, Math.floor(((tf(v) - lo) / range) * (cv.pw - 1)))]! += 1;
		const dens = hist.map((_, i) => {
			let t = 0;
			for (let j = Math.max(0, Math.floor(i - 3 * sigma)); j <= Math.min(cv.pw - 1, Math.ceil(i + 3 * sigma)); j++) t += hist[j]! * Math.exp(-((i - j) ** 2) / (2 * sigma * sigma));
			return t;
		});
		const dm = Math.max(...dens) || 1;
		const cyDot = g * band * 4 + (band * 4 - 1) / 2;
		const half = (band * 4 - 1) / 2;
		const color = groups[g]!.color;
		for (let x = 0; x < cv.pw; x++) {
			const h = Math.round((dens[x]! / dm) * half * p);
			if (dens[x]! / dm < 0.02) continue;
			for (let y = -h; y <= h; y++) if (keepDot(ctx, g, x, y)) cv.set(x, cyDot + y, color);
		}
		const med = vals[Math.floor(vals.length / 2)]!;
		const mx = ((tf(med) - lo) / range) * (cv.pw - 1);
		for (let y = -Math.round(half); y <= Math.round(half); y++) cv.set(mx, cyDot + y, pal.strong.fg);
	}
	cv.draw(s, lw + 1, 0, pal.p100);
	for (let g = 0; g < shown; g++) s.text(0, g * band + Math.floor((band - 1) / 2), padCut(ctx, groups[g]!.label, lw), pal.text);
	const minL = axisLabel(opts.log ? 10 ** lo : lo);
	const maxL = axisLabel(opts.log ? 10 ** hi : hi);
	s.text(lw + 1, s.h - 1, minL, pal.dim);
	s.textIn(lw + 1, s.h - 1, wC, maxL, pal.dim, "right");
}
