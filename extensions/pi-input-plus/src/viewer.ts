import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { printable } from "./picker.js";

const OVERLAY = { anchor: "center", width: "90%", minWidth: 40, maxHeight: "92%" } as const;

/** Bordered box with a title and a footer, shared by both viewers. */
function frame(theme: Theme, width: number, title: string, body: string[], footer: string): string[] {
	const w = Math.max(24, width);
	const inner = w - 2;
	const border = (text: string): string => theme.fg("borderAccent", text);
	const row = (content: string): string => {
		const fitted = truncateToWidth(content, inner, "…");
		return border("│") + fitted + " ".repeat(Math.max(0, inner - visibleWidth(fitted))) + border("│");
	};
	const heading = ` ${truncateToWidth(title, Math.max(1, inner - 4), "…")} `;
	return [
		border("╭─") + theme.fg("accent", theme.bold(heading)) + border("─".repeat(Math.max(0, inner - 1 - visibleWidth(heading))) + "╮"),
		...body.map(row),
		row(` ${theme.fg("dim", footer)}`),
		border(`╰${"─".repeat(inner)}╯`),
	];
}

class TextViewer implements Component {
	private top = 0;
	private wrapped: { width: number; rows: string[] } | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly title: string,
		private readonly text: string,
		private readonly done: () => void,
	) {}

	invalidate(): void {
		this.wrapped = undefined;
	}

	private get pageSize(): number {
		return Math.max(5, this.tui.terminal.rows - 8);
	}

	private rowsFor(width: number): string[] {
		if (this.wrapped?.width === width) return this.wrapped.rows;
		const lines = this.text.split("\n");
		const gutter = String(lines.length).length;
		const rows: string[] = [];
		lines.forEach((line, i) => {
			const parts = wrapTextWithAnsi(line.replace(/\t/g, "    "), Math.max(10, width - gutter - 3));
			(parts.length ? parts : [""]).forEach((part, j) => {
				const number = j === 0 ? String(i + 1).padStart(gutter) : " ".repeat(gutter);
				rows.push(` ${this.theme.fg("dim", number)} ${part}`);
			});
		});
		this.wrapped = { width, rows };
		return rows;
	}

	private scrollBy(delta: number, total: number): void {
		this.top = Math.max(0, Math.min(Math.max(0, total - this.pageSize), this.top + delta));
	}

	handleInput(data: string): void {
		const total = this.rowsFor(this.wrapped?.width ?? 80).length;
		const key = printable(data);
		const half = Math.floor(this.pageSize / 2);
		if (matchesKey(data, "escape") || key === "q") return this.done();
		if (key === "j" || matchesKey(data, "down") || matchesKey(data, "enter")) this.scrollBy(1, total);
		else if (key === "k" || matchesKey(data, "up")) this.scrollBy(-1, total);
		else if (matchesKey(data, "ctrl+d") || key === " ") this.scrollBy(half, total);
		else if (matchesKey(data, "ctrl+u")) this.scrollBy(-half, total);
		else if (matchesKey(data, "ctrl+f") || matchesKey(data, "pageDown")) this.scrollBy(this.pageSize, total);
		else if (matchesKey(data, "ctrl+b") || matchesKey(data, "pageUp")) this.scrollBy(-this.pageSize, total);
		else if (key === "g") this.top = 0;
		else if (key === "G") this.top = Math.max(0, total - this.pageSize);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const rows = this.rowsFor(Math.max(24, width) - 2);
		const page = this.pageSize;
		const body = rows.slice(this.top, this.top + page);
		while (body.length < page) body.push("");
		const shown = rows.length === 0 ? 0 : Math.min(rows.length, this.top + page);
		return frame(this.theme, width, this.title, body, `j k scroll · ^d ^u half page · g G ends · q close   ${shown}/${rows.length}`);
	}
}

/** chafa in symbols mode draws with text cells only, so it works under tmux and over ssh. */
function renderWithChafa(path: string, columns: number, rows: number): Promise<string[]> {
	const colors = /truecolor|24bit/i.test(process.env.COLORTERM ?? "") ? ["--colors", "full"] : [];
	return new Promise((resolve, reject) => {
		execFile(
			"chafa",
			["--format", "symbols", ...colors, "--animate", "off", "--size", `${columns}x${rows}`, path],
			{ maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
			(error, stdout) => {
				if (error) return reject(error);
				// Drop cursor show/hide sequences; the TUI owns the cursor.
				const cleaned = stdout.replace(/\x1b\[\?[0-9;]*[hl]/g, "");
				const lines = cleaned.split("\n");
				while (lines.length > 0 && lines.at(-1) === "") lines.pop();
				resolve(lines);
			},
		);
	});
}

class ImageViewer implements Component {
	private lines: string[] | undefined;
	private error: string | undefined;
	private sizeLabel = "";

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly path: string,
		private readonly done: () => void,
	) {
		const columns = Math.max(20, Math.floor(tui.terminal.columns * 0.9) - 4);
		const rows = Math.max(6, tui.terminal.rows - 8);
		void stat(path).then((s) => {
			this.sizeLabel = `${(s.size / 1024).toFixed(s.size < 1024 * 100 ? 1 : 0)} KB`;
		}, () => {});
		renderWithChafa(path, columns, rows).then(
			(lines) => {
				this.lines = lines;
				this.tui.requestRender();
			},
			(error: NodeJS.ErrnoException) => {
				this.error = error.code === "ENOENT" ? "chafa is not installed (pacman -S chafa); press o to open the image externally" : error.message;
				this.tui.requestRender();
			},
		);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const key = printable(data);
		if (matchesKey(data, "escape") || key === "q") return this.done();
		if (key === "o") {
			const child = spawn("xdg-open", [this.path], { detached: true, stdio: "ignore" });
			child.once("error", () => {});
			child.unref();
		}
	}

	render(width: number): string[] {
		const body = this.lines ?? [this.theme.fg(this.error ? "error" : "dim", ` ${this.error ?? "rendering…"}`)];
		return frame(this.theme, width, `${this.path}${this.sizeLabel ? ` · ${this.sizeLabel}` : ""}`, body, "o open externally · q close");
	}
}

export function openTextViewer(ui: ExtensionUIContext, title: string, text: string): Promise<void> {
	return ui.custom<void>((tui, theme, _keybindings, done) => new TextViewer(tui, theme, title, text, () => done()), {
		overlay: true,
		overlayOptions: OVERLAY,
	});
}

export function openImageViewer(ui: ExtensionUIContext, path: string): Promise<void> {
	return ui.custom<void>((tui, theme, _keybindings, done) => new ImageViewer(tui, theme, path, () => done()), {
		overlay: true,
		overlayOptions: OVERLAY,
	});
}
