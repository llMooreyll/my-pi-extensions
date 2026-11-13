import { matchesKey } from "@earendil-works/pi-tui";
import type { Style, Surface } from "../term/canvas.ts";
import { printable } from "../term/input.ts";
import { graphemes, graphemeWidth, strWidth, truncate } from "../term/width.ts";
import type { Palette } from "../theme.ts";
import type { App, Modal } from "./app.ts";

/** "[ TITLE ]" heading with a rule underneath. Returns the y of the first row below it. */
export function section(s: Surface, x: number, y: number, w: number, title: string, pal: Palette, right?: string): number {
	s.text(x, y, `[ ${title} ]`, pal.title);
	if (right) s.textIn(x, y, w, right, pal.dim, "right");
	s.hline(x, y + 1, w, pal.faint, pal.caps.unicode ? "─" : "-");
	return y + 2;
}

/** Aligned "KEY : value" rows. Returns the y after the last row. */
export function keyValues(s: Surface, x: number, y: number, rows: [string, string][], pal: Palette, valueStyle?: Style): number {
	const kw = Math.max(0, ...rows.map(([k]) => strWidth(k)));
	for (const [k, v] of rows) {
		s.text(x, y, k, pal.dim);
		s.text(x + kw + 1, y, ":", pal.faint);
		s.text(x + kw + 3, y, v, valueStyle ?? pal.text);
		y++;
	}
	return y;
}

/** "[██████▌    ] 63%" with 1/8-cell precision. Returns the x after the label. */
export function progressBar(s: Surface, x: number, y: number, w: number, ratio: number, pal: Palette, label = true): number {
	const r = Math.max(0, Math.min(1, ratio));
	s.text(x, y, "[", pal.dim);
	const inner = Math.max(1, w - 2);
	const eighths = Math.round(r * inner * 8);
	const full = Math.floor(eighths / 8);
	const part = eighths % 8;
	const partial = pal.caps.unicode ? " ▏▎▍▌▋▊▉"[part]! : part >= 4 ? "#" : " ";
	for (let i = 0; i < inner; i++) {
		if (i < full) s.put(x + 1 + i, y, pal.caps.unicode ? "█" : "#", { fg: pal.p100 });
		else if (i === full && part > 0) s.put(x + 1 + i, y, partial, { fg: pal.p100 });
		else s.put(x + 1 + i, y, pal.caps.unicode ? "░" : ".", { fg: pal.p25 });
	}
	s.text(x + inner + 1, y, "]", pal.dim);
	if (!label) return x + inner + 2;
	return s.text(x + inner + 3, y, `${Math.round(r * 100)}%`, pal.text);
}

// ── List ────────────────────────────────────────────────────────────────

export interface ListOptions {
	/** Rows per item (default 1). */
	itemHeight?: number;
	/** Called on Enter or click on the selected item. */
	onActivate?: (index: number) => void;
}

/**
 * Scrollable selection list. The caller owns the data; the list tracks `selected` and `scroll`.
 * Draw with draw(surface, count, renderItem); handle keys with key(data, count).
 */
export class ListView {
	selected = 0;
	scroll = 0;
	private lastHeight = 10;
	private readonly itemHeight: number;
	onActivate?: (index: number) => void;

	constructor(opts: ListOptions = {}) {
		this.itemHeight = opts.itemHeight ?? 1;
		this.onActivate = opts.onActivate;
	}

	clamp(count: number): void {
		if (count <= 0) {
			this.selected = 0;
			this.scroll = 0;
			return;
		}
		this.selected = Math.max(0, Math.min(count - 1, this.selected));
		const visible = Math.max(1, Math.floor(this.lastHeight / this.itemHeight));
		if (this.selected < this.scroll) this.scroll = this.selected;
		if (this.selected >= this.scroll + visible) this.scroll = this.selected - visible + 1;
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, count - visible)));
	}

	/** Handle navigation keys; returns true when consumed. */
	key(data: string, count: number): boolean {
		const page = Math.max(1, Math.floor(this.lastHeight / this.itemHeight) - 1);
		if (matchesKey(data, "up") || data === "k") this.selected--;
		else if (matchesKey(data, "down") || data === "j") this.selected++;
		else if (matchesKey(data, "pageUp")) this.selected -= page;
		else if (matchesKey(data, "pageDown")) this.selected += page;
		else if (matchesKey(data, "home") || data === "g") this.selected = 0;
		else if (matchesKey(data, "end") || data === "G") this.selected = count - 1;
		else if (matchesKey(data, "enter")) {
			if (count > 0) this.onActivate?.(this.selected);
			return true;
		} else return false;
		this.clamp(count);
		return true;
	}

	/** Draw items; renderItem gets a surface for the item rows and whether it is selected. */
	draw(s: Surface, count: number, renderItem: (i: number, row: Surface, selected: boolean) => void): void {
		this.lastHeight = s.h;
		this.clamp(count);
		const visible = Math.floor(s.h / this.itemHeight);
		for (let k = 0; k < visible; k++) {
			const i = this.scroll + k;
			if (i >= count) break;
			const row = s.sub(0, k * this.itemHeight, s.w - 1, this.itemHeight);
			renderItem(i, row, i === this.selected);
			s.hit(0, k * this.itemHeight, s.w - 1, this.itemHeight, {
				onClick: () => {
					if (this.selected === i) this.onActivate?.(i);
					else this.selected = i;
				},
			});
		}
		s.hit(0, 0, s.w, s.h, {
			onWheel: (dir) => {
				this.selected += dir * 3;
				this.clamp(count);
			},
		});
		// Scrollbar in the last column.
		const total = count * this.itemHeight;
		if (total > s.h && s.h > 0) {
			const thumb = Math.max(1, Math.round((s.h * s.h) / total));
			const pos = Math.round(((this.scroll * this.itemHeight) / Math.max(1, total - s.h)) * (s.h - thumb));
			for (let y = 0; y < s.h; y++) {
				const on = y >= pos && y < pos + thumb;
				s.put(s.w - 1, y, on ? "┃" : "│", { attr: on ? 1 : 2 });
			}
		}
	}
}

/** Paint a full-width selected row (inverse video). Call before drawing the row's text with pal.sel. */
export function selectRow(row: Surface, pal: Palette): void {
	row.fill(0, 0, row.w, row.h, pal.sel);
}

// ── Text input ──────────────────────────────────────────────────────────

/** Single-line text field with cursor movement and basic editing shortcuts. */
export class TextInput {
	value = "";
	cursor = 0;

	constructor(value = "") {
		this.set(value);
	}

	set(v: string): void {
		this.value = v;
		this.cursor = graphemes(v).length;
	}

	/** Returns true when the key changed or moved within the field. */
	key(data: string): boolean {
		const g = graphemes(this.value);
		if (matchesKey(data, "backspace")) {
			if (this.cursor > 0) {
				g.splice(this.cursor - 1, 1);
				this.cursor--;
			}
		} else if (matchesKey(data, "delete")) {
			g.splice(this.cursor, 1);
		} else if (matchesKey(data, "left")) this.cursor = Math.max(0, this.cursor - 1);
		else if (matchesKey(data, "right")) this.cursor = Math.min(g.length, this.cursor + 1);
		else if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) this.cursor = 0;
		else if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) this.cursor = g.length;
		else if (matchesKey(data, "ctrl+u")) {
			g.splice(0, this.cursor);
			this.cursor = 0;
		} else if (matchesKey(data, "ctrl+w") || matchesKey(data, "alt+backspace")) {
			let i = this.cursor;
			while (i > 0 && g[i - 1] === " ") i--;
			while (i > 0 && g[i - 1] !== " " && g[i - 1] !== "/") i--;
			g.splice(i, this.cursor - i);
			this.cursor = i;
		} else {
			const p = printable(data);
			if (p === undefined) return false;
			const ins = graphemes(p);
			g.splice(this.cursor, 0, ...ins);
			this.cursor += ins.length;
		}
		this.value = g.join("");
		return true;
	}

	insert(text: string): void {
		const g = graphemes(this.value);
		const ins = graphemes(text.replace(/[\r\n]+/g, " "));
		g.splice(this.cursor, 0, ...ins);
		this.cursor += ins.length;
		this.value = g.join("");
	}

	/** Draw at (x, y) with width w; shows a block cursor when focused. Scrolls to keep the cursor visible. */
	draw(s: Surface, x: number, y: number, w: number, style: Style, focused: boolean, cursorStyle?: Style, placeholder = ""): void {
		const g = graphemes(this.value);
		if (!this.value && !focused && placeholder) {
			s.text(x, y, truncate(placeholder, w), { ...style, attr: 2 });
			return;
		}
		// Find a start index so the cursor fits.
		let start = 0;
		let widthToCursor = 0;
		for (let i = 0; i < this.cursor; i++) widthToCursor += graphemeWidth(g[i]!);
		while (widthToCursor > w - 1 && start < this.cursor) {
			widthToCursor -= graphemeWidth(g[start]!);
			start++;
		}
		let cx = x;
		for (let i = start; i < g.length; i++) {
			const gw = graphemeWidth(g[i]!);
			if (cx + gw > x + w) break;
			const st = focused && i === this.cursor ? (cursorStyle ?? { ...style, attr: 16 }) : style;
			s.text(cx, y, g[i]!, st);
			cx += gw;
		}
		if (focused && this.cursor >= g.length && cx < x + w) s.text(cx, y, " ", cursorStyle ?? { ...style, attr: 16 });
	}
}

// ── Modals ──────────────────────────────────────────────────────────────

export class ConfirmModal implements Modal {
	readonly width: number;
	readonly height = 7;
	private readonly message: string;
	private readonly onYes: () => void;

	constructor(message: string, onYes: () => void) {
		this.message = message;
		this.onYes = onYes;
		this.width = Math.min(80, Math.max(40, strWidth(message) + 6));
	}

	draw(s: Surface, app: App): void {
		const pal = app.pal;
		s.text(1, 0, "[ CONFIRM ]", pal.title);
		s.text(2, 2, truncate(this.message, s.w - 4), pal.text);
		s.text(2, 4, " y confirm ", pal.sel);
		s.hit(2, 4, 11, 1, {
			onClick: () => {
				app.closeModal();
				this.onYes();
			},
		});
		s.text(15, 4, " n / esc cancel ", pal.dim);
		s.hit(15, 4, 16, 1, { onClick: () => app.closeModal() });
	}

	key(data: string, app: App): void {
		if (data === "y" || data === "Y" || matchesKey(data, "enter")) {
			app.closeModal();
			this.onYes();
		} else if (data === "n" || data === "N" || matchesKey(data, "escape")) app.closeModal();
	}
}

export class PromptModal implements Modal {
	readonly width: number;
	readonly height = 7;
	private readonly input: TextInput;
	private readonly title: string;
	private readonly onSubmit: (value: string) => void;

	constructor(title: string, initial: string, onSubmit: (value: string) => void, width = 70) {
		this.title = title;
		this.input = new TextInput(initial);
		this.onSubmit = onSubmit;
		this.width = width;
	}

	draw(s: Surface, app: App): void {
		const pal = app.pal;
		s.text(1, 0, `[ ${this.title} ]`, pal.title);
		s.text(1, 2, ">", pal.strong);
		this.input.draw(s, 3, 2, s.w - 4, pal.text, true, pal.sel);
		s.text(1, 4, "enter confirm   esc cancel", pal.dim);
	}

	key(data: string, app: App): void {
		if (matchesKey(data, "escape")) app.closeModal();
		else if (matchesKey(data, "enter")) {
			app.closeModal();
			this.onSubmit(this.input.value);
		} else this.input.key(data);
	}

	paste(text: string): void {
		this.input.insert(text);
	}
}

export interface MenuItem {
	label: string;
	hint?: string;
	run: () => void;
}

/** Pick one action from a list. */
export class MenuModal implements Modal {
	readonly width: number;
	readonly height: number;
	private readonly list = new ListView();
	private readonly title: string;
	private readonly items: MenuItem[];

	constructor(title: string, items: MenuItem[], selected = 0) {
		this.title = title;
		this.items = items;
		this.width = Math.min(90, Math.max(36, ...items.map((i) => strWidth(i.label) + strWidth(i.hint ?? "") + 10)));
		this.height = Math.min(24, items.length + 5);
		this.list.selected = selected;
	}

	private choose(app: App, i: number): void {
		const item = this.items[i];
		app.closeModal();
		item?.run();
	}

	draw(s: Surface, app: App): void {
		const pal = app.pal;
		s.text(1, 0, `[ ${this.title} ]`, pal.title);
		this.list.onActivate = (i) => this.choose(app, i);
		this.list.draw(s.sub(0, 2, s.w, s.h - 2), this.items.length, (i, row, sel) => {
			const it = this.items[i]!;
			if (sel) selectRow(row, pal);
			const st = sel ? pal.sel : pal.text;
			row.text(1, 0, `${sel ? ">" : " "} ${it.label}`, st);
			if (it.hint) row.textIn(0, 0, row.w - 1, it.hint, sel ? pal.sel : pal.dim, "right");
		});
	}

	key(data: string, app: App): void {
		if (matchesKey(data, "escape")) {
			app.closeModal();
			return;
		}
		this.list.onActivate = (i) => this.choose(app, i);
		this.list.key(data, this.items.length);
	}
}
