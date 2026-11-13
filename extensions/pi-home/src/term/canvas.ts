import { DEFAULT, type RGB } from "./color.ts";
import { graphemes, graphemeWidth } from "./width.ts";

export const BOLD = 1;
export const DIM = 2;
export const ITALIC = 4;
export const UNDERLINE = 8;
export const REVERSE = 16;

/**
 * Cell style. Omitted fg/bg keep whatever colour the cell already has, so text drawn on a panel
 * inherits the panel background. Omitted attr resets attributes to 0 on text writes.
 */
export interface Style {
	fg?: RGB;
	bg?: RGB;
	attr?: number;
}

export interface MouseInfo {
	/** Column/row relative to the hit region's top-left corner. */
	x: number;
	y: number;
	button: number;
	shift: boolean;
	ctrl: boolean;
	alt: boolean;
}

export interface HitRegion {
	x: number;
	y: number;
	w: number;
	h: number;
	onClick?: (m: MouseInfo) => void;
	/** dir = -1 for wheel up, +1 for wheel down. */
	onWheel?: (dir: number, m: MouseInfo) => void;
}

type BoxKind = "single" | "double" | "heavy" | "round" | "ascii";
const BOX: Record<BoxKind, string> = {
	// tl tr bl br h v
	single: "┌┐└┘─│",
	double: "╔╗╚╝═║",
	heavy: "┏┓┗┛━┃",
	round: "╭╮╰╯─│",
	ascii: "++++-|",
};

/** Full-screen cell buffer. A wide grapheme occupies its cell plus a continuation cell holding "". */
export class Canvas {
	w = 0;
	h = 0;
	ch: string[] = [];
	fg = new Int32Array(0);
	bg = new Int32Array(0);
	at = new Uint8Array(0);
	/** Click/wheel targets registered during the current frame; later entries win. */
	hits: HitRegion[] = [];

	constructor(w: number, h: number) {
		this.resize(w, h);
	}

	resize(w: number, h: number): void {
		this.w = Math.max(1, w);
		this.h = Math.max(1, h);
		const n = this.w * this.h;
		this.ch = new Array<string>(n).fill(" ");
		this.fg = new Int32Array(n).fill(DEFAULT);
		this.bg = new Int32Array(n).fill(DEFAULT);
		this.at = new Uint8Array(n);
	}

	clear(fg: RGB, bg: RGB): void {
		this.ch.fill(" ");
		this.fg.fill(fg);
		this.bg.fill(bg);
		this.at.fill(0);
		this.hits = [];
	}

	root(): Surface {
		return new Surface(this, 0, 0, this.w, this.h);
	}

	/** Topmost hit region containing the absolute cell (x, y). */
	hitAt(x: number, y: number): HitRegion | undefined {
		for (let i = this.hits.length - 1; i >= 0; i--) {
			const r = this.hits[i]!;
			if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r;
		}
		return undefined;
	}

	/** Write one grapheme of width gw at absolute (x, y); caller guarantees it fits. */
	putAbs(x: number, y: number, g: string, gw: number, s: Style, resetAttr: boolean): void {
		const w = this.w;
		const i = y * w + x;
		// Writing over half of a wide glyph: blank the other half.
		if (this.ch[i] === "" && x > 0) this.ch[i - 1] = " ";
		if (gw === 2) {
			// The cell after our continuation may be the orphaned tail of a wide glyph we cover.
			if (x + 2 < w && this.ch[i + 2] === "") this.ch[i + 2] = " ";
		} else if (x + 1 < w && this.ch[i + 1] === "") {
			this.ch[i + 1] = " ";
		}
		this.ch[i] = g;
		if (s.fg !== undefined) this.fg[i] = s.fg;
		if (s.bg !== undefined) this.bg[i] = s.bg;
		if (s.attr !== undefined) this.at[i] = s.attr;
		else if (resetAttr) this.at[i] = 0;
		if (gw === 2) {
			const j = i + 1;
			this.ch[j] = "";
			this.fg[j] = this.fg[i]!;
			this.bg[j] = this.bg[i]!;
			this.at[j] = this.at[i]!;
		}
	}
}

/**
 * A clipped rectangular view onto a Canvas. Coordinates passed to methods are relative to the
 * surface; anything outside it is silently dropped. All drawing code receives a Surface.
 */
export class Surface {
	readonly canvas: Canvas;
	/** Absolute position and size (already clipped to the canvas). */
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;

	constructor(canvas: Canvas, x: number, y: number, w: number, h: number) {
		this.canvas = canvas;
		const x0 = Math.max(0, x);
		const y0 = Math.max(0, y);
		const x1 = Math.min(canvas.w, x + Math.max(0, w));
		const y1 = Math.min(canvas.h, y + Math.max(0, h));
		this.x = x0;
		this.y = y0;
		this.w = Math.max(0, x1 - x0);
		this.h = Math.max(0, y1 - y0);
	}

	/** Child surface at relative (x, y), clipped to this surface. */
	sub(x: number, y: number, w: number, h: number): Surface {
		const ax = this.x + x;
		const ay = this.y + y;
		const cx0 = Math.max(ax, this.x);
		const cy0 = Math.max(ay, this.y);
		const cx1 = Math.min(ax + w, this.x + this.w);
		const cy1 = Math.min(ay + h, this.y + this.h);
		return new Surface(this.canvas, cx0, cy0, Math.max(0, cx1 - cx0), Math.max(0, cy1 - cy0));
	}

	inset(left: number, top = left, right = left, bottom = top): Surface {
		return this.sub(left, top, this.w - left - right, this.h - top - bottom);
	}

	/** Draw one grapheme; returns its cell width (0 when clipped). */
	put(x: number, y: number, g: string, s: Style = {}): number {
		if (y < 0 || y >= this.h || x < 0 || x >= this.w) return 0;
		const gw = graphemeWidth(g);
		if (gw === 0) return 0;
		if (gw === 2 && x + 1 >= this.w) {
			this.canvas.putAbs(this.x + x, this.y + y, " ", 1, s, true);
			return 1;
		}
		this.canvas.putAbs(this.x + x, this.y + y, g, gw, s, true);
		return gw;
	}

	/** Draw a string starting at (x, y), clipped at the right edge. Returns the x after the last cell. */
	text(x: number, y: number, str: string, s: Style = {}): number {
		if (y < 0 || y >= this.h) return x;
		let cx = x;
		for (const g of graphemes(str)) {
			const gw = graphemeWidth(g);
			if (gw === 0) continue;
			if (cx >= this.w) break;
			if (cx >= 0) {
				if (gw === 2 && cx + 1 >= this.w) {
					this.canvas.putAbs(this.x + cx, this.y + y, " ", 1, s, true);
					cx += 1;
					break;
				}
				this.canvas.putAbs(this.x + cx, this.y + y, g, gw, s, true);
			}
			cx += gw;
		}
		return cx;
	}

	/** Draw text aligned inside [x, x+w): align = left | right | center. */
	textIn(x: number, y: number, w: number, str: string, s: Style = {}, align: "left" | "right" | "center" = "left"): void {
		const view = this.sub(x, y, w, 1);
		let width = 0;
		for (const g of graphemes(str)) width += graphemeWidth(g);
		const off = align === "right" ? w - width : align === "center" ? Math.floor((w - width) / 2) : 0;
		view.text(Math.max(0, off), 0, str, s);
	}

	/** Fill a rectangle with ch and style (fg/bg/attr all applied). */
	fill(x: number, y: number, w: number, h: number, s: Style, ch = " "): void {
		for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy++) {
			for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx++) {
				this.canvas.putAbs(this.x + xx, this.y + yy, ch, 1, s, true);
			}
		}
	}

	/** Change colours/attributes of existing cells without touching characters. */
	paint(x: number, y: number, w: number, h: number, s: Style): void {
		const c = this.canvas;
		for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy++) {
			for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx++) {
				const i = (this.y + yy) * c.w + this.x + xx;
				if (s.fg !== undefined) c.fg[i] = s.fg;
				if (s.bg !== undefined) c.bg[i] = s.bg;
				if (s.attr !== undefined) c.at[i] = s.attr;
			}
		}
	}

	hline(x: number, y: number, w: number, s: Style, ch = "─"): void {
		this.fill(x, y, w, 1, s, ch);
	}

	vline(x: number, y: number, h: number, s: Style, ch = "│"): void {
		this.fill(x, y, 1, h, s, ch);
	}

	box(x: number, y: number, w: number, h: number, s: Style, kind: BoxKind = "single"): void {
		if (w < 2 || h < 2) return;
		const [tl, tr, bl, br, hz, vt] = [...BOX[kind]] as [string, string, string, string, string, string];
		this.hline(x + 1, y, w - 2, s, hz);
		this.hline(x + 1, y + h - 1, w - 2, s, hz);
		this.vline(x, y + 1, h - 2, s, vt);
		this.vline(x + w - 1, y + 1, h - 2, s, vt);
		this.put(x, y, tl, s);
		this.put(x + w - 1, y, tr, s);
		this.put(x, y + h - 1, bl, s);
		this.put(x + w - 1, y + h - 1, br, s);
	}

	/** Register a click/wheel target for the relative rectangle (clipped to this surface). */
	hit(x: number, y: number, w: number, h: number, region: Omit<HitRegion, "x" | "y" | "w" | "h">): void {
		const r = this.sub(x, y, w, h);
		if (r.w <= 0 || r.h <= 0) return;
		const ox = this.x + x;
		const oy = this.y + y;
		const wrap = (m: MouseInfo): MouseInfo => ({ ...m, x: m.x + (r.x - ox), y: m.y + (r.y - oy) });
		this.canvas.hits.push({
			x: r.x,
			y: r.y,
			w: r.w,
			h: r.h,
			onClick: region.onClick ? (m) => region.onClick!(wrap(m)) : undefined,
			onWheel: region.onWheel ? (d, m) => region.onWheel!(d, wrap(m)) : undefined,
		});
	}
}
