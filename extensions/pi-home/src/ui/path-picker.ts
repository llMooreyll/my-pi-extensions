import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { matchesKey } from "@earendil-works/pi-tui";
import { expandHome, formatDirInput, tildify } from "../paths.ts";
import type { Surface } from "../term/canvas.ts";
import { graphemes, strWidth, truncate } from "../term/width.ts";
import type { App, Modal } from "./app.ts";
import { ListView, PromptModal, selectRow, TextInput } from "./widgets.ts";

export interface PathPickerOptions {
	title?: string;
	initialDir: string;
	/** Optional known project cwds mapped to session count, shown as hints and in Ctrl+P quick jump. */
	knownProjects?: Map<string, number>;
	onSelect: (dirPath: string) => void;
}

type PickerMode = "browse" | "projects";

interface PickerEntry {
	kind: "current" | "parent" | "dir" | "project";
	label: string;
	fullPath: string;
	hint?: string;
}

interface SubdirItem {
	name: string;
	fullPath: string;
	isSymlink: boolean;
}

interface BrowseContext {
	scanDir: string;
	query: string;
	entries: PickerEntry[];
	prefixMatches: SubdirItem[];
	scanError: string | null;
}

function isDirectory(p: string): boolean {
	try {
		return existsSync(p) && statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Create the directory `raw` (a name relative to `base`, an absolute path, or ~/...) and return its
 * path. An existing directory is returned as is; anything else in the way is an error.
 */
export function makeDirectory(base: string, raw: string): string {
	const name = raw.trim();
	if (!name) throw new Error("name is empty");
	if (name.includes("\0")) throw new Error("name contains NUL");
	const target = resolve(base, expandHome(name));
	if (existsSync(target)) {
		if (isDirectory(target)) return target;
		throw new Error(`exists and is not a directory: ${tildify(target)}`);
	}
	mkdirSync(target, { recursive: true });
	return target;
}

function commonPrefix(names: string[]): string {
	if (names.length === 0) return "";
	let prefix = names[0]!;
	for (let i = 1; i < names.length; i++) {
		const s = names[i]!;
		let k = 0;
		while (k < prefix.length && k < s.length && prefix[k] === s[k]) k++;
		prefix = prefix.slice(0, k);
		if (!prefix) break;
	}
	return prefix;
}

export class PathPickerModal implements Modal {
	readonly width = 86;
	readonly height = 24;

	captureText(): boolean {
		return true;
	}

	private readonly title: string;
	private readonly baseDir: string;
	private readonly knownProjects: Map<string, number>;
	private readonly onSelect: (dirPath: string) => void;
	private readonly input: TextInput;
	private readonly list = new ListView();

	private mode: PickerMode = "browse";
	private savedBrowseInput = "";
	private showHidden = false;
	private listTouched = false;
	private lastSel = 0;
	private errorMsg: string | null = null;
	private entries: PickerEntry[] = [];
	private browseCtx: BrowseContext = { scanDir: "", query: "", entries: [], prefixMatches: [], scanError: null };
	private dirCache: { dir: string; includeHidden: boolean; mtimeMs: number; items: SubdirItem[] } | null = null;

	constructor(opts: PathPickerOptions) {
		this.title = opts.title ?? "OPEN_DIRECTORY";
		this.baseDir = resolve(opts.initialDir);
		this.knownProjects = opts.knownProjects ?? new Map();
		this.onSelect = opts.onSelect;
		this.input = new TextInput(formatDirInput(this.baseDir));
		this.refreshList();
	}

	private readSubdirs(dir: string, includeHidden: boolean): { items: SubdirItem[]; error: string | null } {
		let mtimeMs = -1;
		try {
			const st = statSync(dir);
			if (!st.isDirectory()) return { items: [], error: `not a directory: ${tildify(dir)}` };
			mtimeMs = st.mtimeMs;
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			return { items: [], error: code === "ENOENT" ? `directory not found: ${tildify(dir)}` : `cannot read: ${tildify(dir)}` };
		}
		if (
			this.dirCache &&
			this.dirCache.dir === dir &&
			this.dirCache.includeHidden === includeHidden &&
			this.dirCache.mtimeMs === mtimeMs
		) {
			return { items: this.dirCache.items, error: null };
		}
		try {
			const dirents = readdirSync(dir, { withFileTypes: true });
			const items: SubdirItem[] = [];
			for (const d of dirents) {
				if (!includeHidden && d.name.startsWith(".")) continue;
				const fullPath = join(dir, d.name);
				let dirOk = d.isDirectory();
				let isSymlink = false;
				if (!dirOk && d.isSymbolicLink()) {
					isSymlink = true;
					try {
						dirOk = statSync(fullPath).isDirectory();
					} catch {
						dirOk = false;
					}
				}
				if (dirOk) items.push({ name: d.name, fullPath, isSymlink });
			}
			items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
			this.dirCache = { dir, includeHidden, mtimeMs, items };
			return { items, error: null };
		} catch {
			return { items: [], error: `permission denied: ${tildify(dir)}` };
		}
	}

	private resolveTypedPath(): string | null {
		const raw = this.input.value.trim();
		if (!raw) return null;
		return resolve(this.baseDir, expandHome(raw));
	}

	private buildBrowseContext(): BrowseContext {
		const raw = this.input.value.trim();
		let scanDir: string;
		let query: string;
		if (!raw) {
			scanDir = this.baseDir;
			query = "";
		} else {
			const expanded = resolve(this.baseDir, expandHome(raw));
			const dirLike = raw.endsWith("/") || raw === "~" || raw === "." || raw === "..";
			if (dirLike) {
				scanDir = expanded;
				query = "";
			} else {
				scanDir = dirname(expanded);
				query = basename(expanded);
			}
		}

		const includeHidden = this.showHidden || query.startsWith(".");
		const { items, error } = this.readSubdirs(scanDir, includeHidden);
		if (error) {
			const parent = dirname(scanDir);
			const fallback: PickerEntry[] = [];
			if (parent !== scanDir && isDirectory(parent)) {
				fallback.push({ kind: "parent", label: "../", fullPath: parent, hint: "parent" });
			}
			return { scanDir, query, entries: fallback, prefixMatches: [], scanError: error };
		}

		const entries: PickerEntry[] = [];
		const prefixMatches: SubdirItem[] = [];

		if (!query) {
			entries.push({ kind: "current", label: `.  (${tildify(scanDir)})`, fullPath: scanDir, hint: "open current" });
			const parent = dirname(scanDir);
			if (parent !== scanDir) entries.push({ kind: "parent", label: "../", fullPath: parent, hint: "parent" });
			for (const it of items) {
				prefixMatches.push(it);
				entries.push(this.subdirEntry(it));
			}
			return { scanDir, query, entries, prefixMatches, scanError: null };
		}

		const qLower = query.toLowerCase();
		const exactPrefix: SubdirItem[] = [];
		const ciPrefix: SubdirItem[] = [];
		const substr: SubdirItem[] = [];
		for (const it of items) {
			if (it.name.startsWith(query)) exactPrefix.push(it);
			else if (it.name.toLowerCase().startsWith(qLower)) ciPrefix.push(it);
			else if (it.name.toLowerCase().includes(qLower)) substr.push(it);
		}
		prefixMatches.push(...exactPrefix, ...ciPrefix);
		for (const it of [...exactPrefix, ...ciPrefix, ...substr]) entries.push(this.subdirEntry(it));
		if (query === ".." || query === ".") {
			const parent = dirname(scanDir);
			if (parent !== scanDir) entries.unshift({ kind: "parent", label: "../", fullPath: parent, hint: "parent" });
		}
		return { scanDir, query, entries, prefixMatches, scanError: null };
	}

	private subdirEntry(it: SubdirItem): PickerEntry {
		const sess = this.knownProjects.get(it.fullPath);
		const tags: string[] = [];
		if (it.isSymlink) tags.push("link");
		if (sess !== undefined) tags.push(`${sess} sess`);
		return {
			kind: "dir",
			label: `${it.name}/`,
			fullPath: it.fullPath,
			hint: tags.length ? tags.join(" · ") : undefined,
		};
	}

	private buildProjectsEntries(): PickerEntry[] {
		const q = this.input.value.trim().toLowerCase();
		const out: PickerEntry[] = [];
		for (const [cwd, sess] of this.knownProjects) {
			const tilde = tildify(cwd);
			if (q && !cwd.toLowerCase().includes(q) && !tilde.toLowerCase().includes(q)) continue;
			out.push({
				kind: "project",
				label: basename(cwd) || cwd,
				fullPath: cwd,
				hint: `${tildify(cwd)} · ${sess} sess`,
			});
		}
		return out;
	}

	private refreshList(resetSelection = true): void {
		this.errorMsg = null;
		if (this.mode === "projects") {
			this.entries = this.buildProjectsEntries();
		} else {
			this.browseCtx = this.buildBrowseContext();
			this.entries = this.browseCtx.entries;
		}
		if (resetSelection) {
			this.list.selected = 0;
			this.list.scroll = 0;
			this.listTouched = false;
			this.lastSel = 0;
		} else {
			this.list.clamp(this.entries.length);
			this.lastSel = this.list.selected;
		}
	}

	private setInputPath(text: string): void {
		this.input.set(text);
		this.refreshList(true);
	}

	private goParent(): void {
		const current = this.browseCtx.scanDir || this.baseDir;
		const parent = dirname(current);
		if (parent !== current) this.setInputPath(formatDirInput(parent));
	}

	private completeTab(): void {
		const sel = this.entries[this.list.selected];
		if (this.mode === "projects") {
			if (sel) {
				this.mode = "browse";
				this.setInputPath(formatDirInput(sel.fullPath));
			}
			return;
		}
		if (this.listTouched && sel && (sel.kind === "dir" || sel.kind === "parent")) {
			this.setInputPath(formatDirInput(sel.fullPath));
			return;
		}
		const { scanDir, query, prefixMatches } = this.browseCtx;
		if (query && prefixMatches.length === 1) {
			this.setInputPath(formatDirInput(prefixMatches[0]!.fullPath));
			return;
		}
		if (query && prefixMatches.length > 1) {
			// Preserve case: only extend LCP on identical characters; fall back to exact-prefix group if mixed case.
			const exact = prefixMatches.filter((m) => m.name.startsWith(query));
			const pool = exact.length > 1 ? exact : prefixMatches;
			const lcp = commonPrefix(pool.map((m) => m.name));
			if (lcp.length > query.length && lcp.toLowerCase().startsWith(query.toLowerCase())) {
				const base = formatDirInput(scanDir);
				this.setInputPath(`${base}${lcp}`);
				return;
			}
		}
		if (!query && prefixMatches.length === 1 && this.list.selected === 0) {
			this.setInputPath(formatDirInput(prefixMatches[0]!.fullPath));
			return;
		}
		if (sel && (sel.kind === "dir" || sel.kind === "parent")) {
			this.setInputPath(formatDirInput(sel.fullPath));
		}
	}

	private submitPath(app: App, target: string): void {
		if (!isDirectory(target)) {
			this.errorMsg = `not a directory: ${tildify(target)}`;
			return;
		}
		app.closeModal();
		this.onSelect(target);
	}

	private activateEntry(app: App, i: number): void {
		const sel = this.entries[i];
		if (!sel) return;
		if (sel.kind === "current" || sel.kind === "project") {
			this.submitPath(app, sel.fullPath);
		} else {
			this.setInputPath(formatDirInput(sel.fullPath));
		}
	}

	private handleEnter(app: App): void {
		const sel = this.entries[this.list.selected];
		if (this.mode === "projects") {
			if (sel) this.submitPath(app, sel.fullPath);
			else this.errorMsg = "no matching project";
			return;
		}
		if (sel?.kind === "parent" && (this.listTouched || !this.resolveTypedPath())) {
			this.setInputPath(formatDirInput(sel.fullPath));
			return;
		}
		if (this.listTouched && sel && (sel.kind === "dir" || sel.kind === "current")) {
			this.submitPath(app, sel.fullPath);
			return;
		}
		const typed = this.resolveTypedPath();
		if (typed && isDirectory(typed)) {
			this.submitPath(app, typed);
			return;
		}
		if (sel && (sel.kind === "dir" || sel.kind === "current")) {
			this.submitPath(app, sel.fullPath);
			return;
		}
		this.errorMsg = typed ? `not a directory: ${tildify(typed)}` : "enter a path or select a directory";
	}

	/** Ask for a folder name and create it inside the directory currently being browsed. */
	private promptNewFolder(app: App): void {
		if (this.mode !== "browse") return;
		const parent = this.browseCtx.scanDir;
		if (this.browseCtx.scanError || !isDirectory(parent)) {
			this.errorMsg = "cannot create a folder here";
			return;
		}
		app.modal(
			new PromptModal(`NEW_FOLDER in ${tildify(parent)}`, "", (name) => {
				try {
					const created = makeDirectory(parent, name);
					this.dirCache = null;
					this.setInputPath(formatDirInput(created));
				} catch (e) {
					this.errorMsg = `mkdir failed: ${e instanceof Error ? e.message : String(e)}`;
				}
			}),
		);
	}

	private toggleMode(): void {
		if (this.mode === "browse") {
			this.savedBrowseInput = this.input.value;
			this.mode = "projects";
			this.input.set("");
		} else {
			this.mode = "browse";
			this.input.set(this.savedBrowseInput);
		}
		this.refreshList(true);
	}

	draw(s: Surface, app: App): void {
		const pal = app.pal;
		const title = this.mode === "projects" ? `${this.title} :: PROJECTS` : this.title;
		s.text(1, 0, `[ ${title} ]`, pal.title);
		const badge = `${this.mode === "browse" && this.showHidden ? ".* on  " : ""}${this.entries.length} items`;
		s.textIn(1, 0, s.w - 2, badge, pal.dim, "right");

		s.text(1, 1, this.mode === "projects" ? "/" : ">", pal.strong);
		const placeholder = this.mode === "projects" ? "filter known projects…" : "type path, Tab complete, ↑↓ browse";
		this.input.draw(s, 3, 1, s.w - 4, pal.text, true, pal.sel, placeholder);
		s.hline(0, 2, s.w, pal.faint, pal.caps.unicode ? "─" : "-");

		const listH = Math.max(1, s.h - 5);
		const listArea = s.sub(0, 3, s.w, listH);
		if (this.entries.length === 0) {
			const emptyMsg = this.mode === "projects" ? "no matching projects" : (this.browseCtx.scanError ?? "no subdirectories");
			listArea.text(2, 1, truncate(emptyMsg, Math.max(4, s.w - 4)), this.browseCtx.scanError ? { fg: pal.err } : pal.dim);
		} else {
			this.list.onActivate = (i) => this.activateEntry(app, i);
			this.list.draw(listArea, this.entries.length, (i, row, sel) => {
				const it = this.entries[i]!;
				if (sel) selectRow(row, pal);
				const st = sel ? pal.sel : it.kind === "current" ? pal.strong : pal.text;
				const hintW = it.hint ? strWidth(it.hint) + 3 : 0;
				const labelW = Math.max(8, row.w - 4 - hintW);
				row.text(1, 0, `${sel ? ">" : " "} ${truncate(it.label, labelW)}`, st);
				if (it.hint) row.textIn(0, 0, row.w - 1, it.hint, sel ? pal.sel : pal.dim, "right");
			});
			if (this.list.selected !== this.lastSel) {
				this.lastSel = this.list.selected;
				this.listTouched = true;
				this.errorMsg = null;
			}
		}

		const footerY = s.h - 1;
		const status = this.errorMsg ?? (this.mode === "browse" ? this.browseCtx.scanError : null);
		if (status) {
			s.text(1, footerY, truncate(status, s.w - 2), { fg: pal.err });
		} else {
			const hints =
				this.mode === "projects"
					? "enter open  tab browse dir  ↑↓ select  ctrl+p browse fs  esc cancel"
					: "tab complete  S-tab up  ↑↓ select  enter open  ^n new folder  ^p projects  ^t hidden";
			s.text(1, footerY, truncate(hints, s.w - 2), pal.dim);
		}
	}

	key(data: string, app: App): void {
		if (matchesKey(data, "escape")) {
			app.closeModal();
			return;
		}
		if (matchesKey(data, "enter")) {
			this.handleEnter(app);
			return;
		}
		if (matchesKey(data, "tab")) {
			this.completeTab();
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			if (this.mode === "browse") this.goParent();
			return;
		}
		if (matchesKey(data, "ctrl+p")) {
			this.toggleMode();
			return;
		}
		if (matchesKey(data, "ctrl+n")) {
			this.promptNewFolder(app);
			return;
		}
		if (matchesKey(data, "ctrl+t")) {
			if (this.mode === "browse") {
				this.showHidden = !this.showHidden;
				this.refreshList(true);
			}
			return;
		}
		if (["up", "down", "pageUp", "pageDown"].some((k) => matchesKey(data, k as "up"))) {
			const before = this.list.selected;
			this.list.key(data, this.entries.length);
			if (this.list.selected !== before || this.entries.length > 0) {
				this.listTouched = true;
				this.lastSel = this.list.selected;
				this.errorMsg = null;
			}
			return;
		}
		// Allow ctrl+w / alt+backspace to delete past a trailing "/" so segment deletion works smoothly.
		if ((matchesKey(data, "ctrl+w") || matchesKey(data, "alt+backspace")) && this.input.cursor > 1) {
			const g = graphemes(this.input.value);
			if (g[this.input.cursor - 1] === "/") {
				g.splice(this.input.cursor - 1, 1);
				this.input.value = g.join("");
				this.input.cursor--;
			}
		}
		if (this.input.key(data)) this.refreshList(true);
	}

	paste(text: string): void {
		this.input.insert(text);
		this.refreshList(true);
	}
}
