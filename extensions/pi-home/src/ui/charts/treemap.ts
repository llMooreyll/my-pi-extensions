import type { Surface } from "../../term/canvas.ts";
import type { RGB } from "../../term/color.ts";
import { mix } from "../../term/color.ts";
import { strWidth } from "../../term/width.ts";
import { axisLabel, type ChartCtx, noData, tooSmall, cut } from "./common.ts";

interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}
interface Node {
	i: number;
	area: number;
}

/** Worst aspect ratio of `row` laid along a side of length `side` (visual units, cell height = 2). */
function worst(row: Node[], side: number): number {
	const sum = row.reduce((a, n) => a + n.area, 0);
	const max = Math.max(...row.map((n) => n.area));
	const min = Math.min(...row.map((n) => n.area));
	return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

/** Squarified layout (Bruls et al.) in visual units; x/w are cells, y/h are cell rows * 2. */
function squarify(nodes: Node[], rect: Rect): Map<number, Rect> {
	const out = new Map<number, Rect>();
	let r = { ...rect };
	let rest = nodes.slice();
	while (rest.length > 0) {
		const horizontal = r.w >= r.h; // lay the row along the short side
		const side = horizontal ? r.h : r.w;
		if (side <= 1e-9) break;
		const row: Node[] = [rest[0]!];
		let k = 1;
		while (k < rest.length && worst([...row, rest[k]!], side) <= worst(row, side)) row.push(rest[k++]!);
		rest = rest.slice(row.length);
		const sum = row.reduce((a, n) => a + n.area, 0);
		const thick = sum / side;
		let pos = 0;
		for (const n of row) {
			const len = n.area / thick;
			out.set(n.i, horizontal ? { x: r.x, y: r.y + pos, w: thick, h: len } : { x: r.x + pos, y: r.y, w: len, h: thick });
			pos += len;
		}
		r = horizontal ? { x: r.x + thick, y: r.y, w: r.w - thick, h: r.h } : { x: r.x, y: r.y + thick, w: r.w, h: r.h - thick };
	}
	return out;
}

/**
 * Squarified treemap filling the surface. Tiles are background-filled with the item colour
 * (default pal.series(i)) darkened to 45% towards pal.screenBg, with label and value inside when
 * they fit and a 1-cell gap right and below. Tier 0 / no unicode draws outlined boxes instead.
 * Minimum 6 columns x 3 rows. `onClick(i)` receives the index into `items`.
 */
export function treemap(
	s: Surface,
	items: { label: string; value: number; color?: RGB }[],
	ctx: ChartCtx,
	opts: { onClick?: (i: number) => void } = {},
): void {
	if (tooSmall(s, ctx, 6, 3)) return;
	const pal = ctx.pal;
	const live = items.map((it, i) => ({ i, area: it.value })).filter((n) => n.area > 0).sort((a, b) => b.area - a.area);
	if (live.length === 0) return noData(s, ctx);
	const total = live.reduce((a, n) => a + n.area, 0);
	const H = s.h * 2;
	const scaled = live.map((n) => ({ i: n.i, area: (n.area / total) * s.w * H }));
	const rects = squarify(scaled, { x: 0, y: 0, w: s.w, h: H });
	const outline = pal.caps.tier === 0 || !pal.caps.unicode;
	for (const [i, r] of rects) {
		const x0 = Math.round(r.x);
		const y0 = Math.round(r.y / 2);
		const w = Math.round(r.x + r.w) - x0;
		const h = Math.round((r.y + r.h) / 2) - y0;
		const tw = w - 1;
		const th = h - 1;
		if (tw < 1 || th < 1) continue;
		const it = items[i]!;
		const color = it.color ?? pal.series(i);
		let inner = { x: x0, y: y0, w: tw, h: th };
		if (outline) {
			s.box(x0, y0, tw, th, { fg: color }, pal.caps.unicode ? "single" : "ascii");
			inner = { x: x0 + 1, y: y0 + 1, w: tw - 2, h: th - 2 };
		} else {
			s.fill(x0, y0, tw, th, { bg: mix(color, pal.screenBg, 0.55), fg: pal.text.fg }, " ");
		}
		if (inner.w >= 3 && inner.h >= 1) {
			s.text(inner.x + 1, inner.y, cut(ctx, it.label, inner.w - 1), pal.strong);
			if (inner.h >= 2) {
				const v = axisLabel(it.value);
				if (strWidth(v) <= inner.w - 1) s.text(inner.x + 1, inner.y + 1, v, pal.text);
			}
		}
		const onClick = opts.onClick;
		if (onClick) s.hit(x0, y0, tw, th, { onClick: () => onClick(i) });
	}
}
