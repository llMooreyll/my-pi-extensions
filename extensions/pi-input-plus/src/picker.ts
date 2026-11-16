import { homedir } from "node:os";
import { dirname } from "node:path";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, decodeKittyPrintable, matchesKey, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { type Accept, type Entry, listDirectory, matchEntries, searchTree } from "./listing.js";
import type { PickOptions, PickResult } from "./service.js";

type Mode = "normal" | "search";

/** The text a key press types, or undefined for control and navigation keys. */
export function printable(data: string): string | undefined {
	const decoded = decodeKittyPrintable(data);
	if (decoded !== undefined) return decoded;
	if (data.startsWith("\x1b") || data.length === 0) return undefined;
	const chars = [...data];
	return chars.length === 1 && chars[0]! >= " " && chars[0] !== "\x7f" ? data : undefined;
}

function buildAccept(options: PickOptions): Accept | undefined {
	const extensions = options.extensions?.map((e) => e.toLowerCase());
	const { accept } = options;
	if (!extensions?.length && !accept) return undefined;
	return (path) => {
		if (extensions?.length && !extensions.some((e) => path.toLowerCase().endsWith(e))) return false;
		return accept ? accept(path) : true;
	};
}

/** Shortens from the middle so the end of the name, including its extension, stays visible. */
export function truncateMiddle(text: string, width: number): string {
	if (visibleWidth(text) <= width || width < 4) return text;
	const chars = [...text];
	const extension = /\.[A-Za-z0-9]{1,8}$/.exec(text)?.[0].length ?? 0;
	const tailLength = Math.min(chars.length - 1, extension + 4, Math.floor((width - 1) / 2));
	let tail = chars.slice(chars.length - tailLength);
	let tailWidth = visibleWidth(tail.join(""));
	while (tail.length > 1 && tailWidth > Math.floor((width - 1) / 2)) {
		tailWidth -= visibleWidth(tail.shift()!);
	}
	const head: string[] = [];
	let headWidth = 0;
	for (const char of chars) {
		const charWidth = visibleWidth(char);
		if (headWidth + charWidth + 1 + tailWidth > width) break;
		head.push(char);
		headWidth += charWidth;
	}
	return `${head.join("")}…${tail.join("")}`;
}

function tildePath(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Vim-style file picker: hjkl to move, / to search, Enter or Space to choose, q or Esc to close. */
class PickerComponent implements Component {
	private dir: string;
	private mode: Mode = "normal";
	private query = "";
	private showHidden = false;
	private entries: Entry[] = [];
	private results: Entry[] | undefined;
	private searchTimer: ReturnType<typeof setTimeout> | undefined;
	private filtered: Entry[] = [];
	private index = 0;
	private scroll = 0;
	private message: string | undefined;
	/** Entry to put the cursor on once the next directory listing arrives. */
	private focusPath: string | undefined;
	private searchAbort: AbortController | undefined;
	private loadToken = 0;
	private readonly accept: Accept | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly options: PickOptions,
		private readonly done: (result: PickResult | undefined) => void,
	) {
		this.dir = options.cwd;
		this.accept = buildAccept(options);
		void this.load();
	}

	dispose(): void {
		this.loadToken++;
		this.searchTimer && clearTimeout(this.searchTimer);
		this.searchAbort?.abort();
	}

	invalidate(): void {}

	private get pageSize(): number {
		return Math.max(5, Math.min(20, this.tui.terminal.rows - 10));
	}

	private view(): Entry[] {
		return this.query ? this.filtered : this.entries;
	}

	private async load(): Promise<void> {
		const token = ++this.loadToken;
		this.searchTimer && clearTimeout(this.searchTimer);
		this.searchAbort?.abort();
		this.results = undefined;
		this.filtered = [];
		this.query = "";
		this.mode = "normal";
		try {
			const entries = await listDirectory(this.dir, this.showHidden, this.accept);
			if (token !== this.loadToken) return;
			this.entries = entries;
			this.message = undefined;
		} catch (error) {
			if (token !== this.loadToken) return;
			this.entries = [];
			this.message = error instanceof Error ? error.message : String(error);
		}
		const focused = this.focusPath === undefined ? -1 : this.entries.findIndex((e) => e.path === this.focusPath);
		this.focusPath = undefined;
		this.index = Math.max(0, focused);
		this.scroll = Math.max(0, this.index - Math.floor(this.pageSize / 2));
		this.tui.requestRender();
	}

	/** Re-runs the search for the current query; fd narrows the candidates, `matchEntries` ranks them. */
	private startSearch(): void {
		this.searchTimer && clearTimeout(this.searchTimer);
		this.searchAbort?.abort();
		const query = this.query.trim();
		if (!query) {
			this.results = undefined;
			this.filtered = [];
			this.message = undefined;
			return;
		}
		const controller = new AbortController();
		this.searchAbort = controller;
		this.message = "searching…";
		this.searchTimer = setTimeout(() => {
			void searchTree(this.dir, this.showHidden, this.accept, query, controller.signal).then((results) => {
				if (controller.signal.aborted) return;
				this.results = results;
				this.message = undefined;
				this.refilter();
				this.tui.requestRender();
			});
		}, 60);
	}

	private refilter(): void {
		this.filtered = this.query.trim() ? matchEntries(this.results ?? [], this.query) : [];
		this.index = 0;
		this.scroll = 0;
	}

	private setQuery(query: string): void {
		this.query = query;
		this.index = 0;
		this.scroll = 0;
		this.startSearch();
	}

	private move(delta: number): void {
		const length = this.view().length;
		if (length === 0) return;
		this.index = Math.max(0, Math.min(length - 1, this.index + delta));
		const page = this.pageSize;
		if (this.index < this.scroll) this.scroll = this.index;
		else if (this.index >= this.scroll + page) this.scroll = this.index - page + 1;
	}

	private jump(index: number): void {
		this.index = 0;
		this.scroll = 0;
		this.move(index);
	}

	private enter(entry: Entry): void {
		this.dir = entry.path;
		void this.load();
	}

	private choose(): void {
		const entry = this.view()[this.index];
		if (!entry) return;
		if (entry.isDirectory && this.options.selectDirectories === false) return this.enter(entry);
		this.done({ path: entry.path, isDirectory: entry.isDirectory });
	}

	private openCurrent(): void {
		const entry = this.view()[this.index];
		if (!entry) return;
		if (entry.isDirectory) this.enter(entry);
		else this.choose();
	}

	/** Leaves search with the cursor on the chosen result, shown in its own directory. */
	private focusResult(): void {
		const entry = this.filtered[this.index];
		if (!entry) {
			this.mode = "normal";
			return;
		}
		this.focusPath = entry.path;
		this.dir = dirname(entry.path);
		void this.load();
	}

	private parent(): void {
		const up = dirname(this.dir);
		if (up === this.dir) return;
		this.dir = up;
		void this.load();
	}

	handleInput(data: string): void {
		if (this.mode === "search") this.inputSearch(data);
		else this.inputNormal(data);
		this.tui.requestRender();
	}

	private inputNormal(data: string): void {
		const key = printable(data);
		if (matchesKey(data, "escape") || key === "q") return this.done(undefined);
		if (matchesKey(data, "enter") || matchesKey(data, "space")) return this.choose();
		if (key === "j" || matchesKey(data, "down")) return this.move(1);
		if (key === "k" || matchesKey(data, "up")) return this.move(-1);
		if (matchesKey(data, "ctrl+d")) return this.move(Math.floor(this.pageSize / 2));
		if (matchesKey(data, "ctrl+u")) return this.move(-Math.floor(this.pageSize / 2));
		if (key === "g") return this.jump(0);
		if (key === "G") return this.jump(this.view().length - 1);
		if (key === "h" || matchesKey(data, "left") || matchesKey(data, "backspace")) return this.parent();
		if (key === "l" || matchesKey(data, "right")) return this.openCurrent();
		if (key === ".") {
			this.showHidden = !this.showHidden;
			return void this.load();
		}
		if (key === "/") this.mode = "search";
	}

	private inputSearch(data: string): void {
		if (matchesKey(data, "escape")) {
			this.mode = "normal";
			return;
		}
		if (matchesKey(data, "enter")) return this.focusResult();
		if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) return this.move(1);
		if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) return this.move(-1);
		if (matchesKey(data, "ctrl+u")) return this.setQuery("");
		if (matchesKey(data, "backspace")) {
			if (!this.query) {
				this.mode = "normal";
				return;
			}
			return this.setQuery([...this.query].slice(0, -1).join(""));
		}
		const key = printable(data);
		if (key !== undefined) this.setQuery(this.query + key);
	}

	render(width: number): string[] {
		const { theme } = this;
		const w = Math.max(24, width);
		const inner = w - 2;
		const border = (text: string): string => theme.fg("borderAccent", text);
		const row = (content: string): string => {
			const fitted = truncateToWidth(content, inner, "…");
			return border("│") + fitted + " ".repeat(Math.max(0, inner - visibleWidth(fitted))) + border("│");
		};

		const title = ` ${this.options.title ?? "Pick a file"} `;
		const titleText = theme.fg("accent", theme.bold(title));
		const lines: string[] = [border("╭─") + titleText + border("─".repeat(Math.max(0, inner - 1 - visibleWidth(title))) + "╮")];

		const dirText = tildePath(this.dir);
		const room = inner - 2;
		const shownDir = visibleWidth(dirText) > room ? `…${[...dirText].slice(-(room - 1)).join("")}` : dirText;
		lines.push(row(` ${theme.fg("mdLink", shownDir)}`));
		if (this.mode === "search" || this.query) {
			const cursor = this.mode === "search" ? theme.inverse(" ") : "";
			lines.push(row(` ${theme.fg("accent", "/")}${this.query}${cursor}`));
		} else {
			lines.push(row(""));
		}

		const view = this.view();
		const page = this.pageSize;
		for (let i = 0; i < page; i++) {
			const entry = view[this.scroll + i];
			if (!entry) {
				const empty = i === 0 ? (this.message ?? (this.query ? "no match" : "(empty)")) : "";
				lines.push(row(empty ? `  ${theme.fg("dim", empty)}` : ""));
				continue;
			}
			const selected = this.scroll + i === this.index;
			const full = entry.isDirectory && !entry.label.endsWith("/") ? `${entry.label}/` : entry.label;
			const label = truncateMiddle(full, inner - 4);
			const text = entry.isDirectory ? theme.fg("accent", label) : label;
			const line = ` ${selected ? "▸" : " "} ${text}`;
			const padded = line + " ".repeat(Math.max(0, inner - visibleWidth(line)));
			lines.push(row(selected ? theme.bg("selectedBg", padded) : line));
		}

		const count = view.length > 0 ? `${this.index + 1}/${view.length}` : "0/0";
		const hints =
			this.mode === "search"
				? "type to filter · ⏎ focus result · ↑↓ ^n ^p move · esc normal"
				: "j k move · h up · l open · ⏎ space pick · / search · . hidden · q quit";
		lines.push(row(` ${theme.fg("dim", hints)}`));
		const footer = ` ${count} `;
		lines.push(border("╰" + "─".repeat(Math.max(0, inner - visibleWidth(footer) - 1))) + theme.fg("dim", footer) + border("─╯"));
		return lines;
	}
}

export function openPicker(ui: ExtensionUIContext, options: PickOptions): Promise<PickResult | undefined> {
	return ui.custom<PickResult | undefined>((tui, theme, _keybindings, done) => new PickerComponent(tui, theme, options, done), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "70%", minWidth: 50, maxHeight: "90%" },
	});
}
