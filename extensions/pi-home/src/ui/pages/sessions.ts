import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { matchesKey } from "@earendil-works/pi-tui";
import { exportSessionHtml, type LiveSession, liveSessions, renameSession, trashSession } from "../../index/actions.ts";
import { sessionRoots } from "../../index/indexer.ts";
import {
	defaultFilter,
	filterSessions,
	listProjects,
	mainModel,
	RANGES,
	type RangeId,
	rangeBounds,
	type SessionFilter,
	sessionTitle,
	totalTokens,
} from "../../index/query.ts";
import { fullTextSearch, snippets } from "../../index/search.ts";
import type { SessionRecord } from "../../index/types.ts";
import { homeDataDir, tildify } from "../../paths.ts";
import type { Surface } from "../../term/canvas.ts";
import { padEnd, strWidth, truncate } from "../../term/width.ts";
import type { App, Page } from "../app.ts";
import { fmtAgo, fmtCost, fmtDateTime, fmtInt, fmtMinutes, fmtTokens, shortModel } from "../format.ts";
import { navHandlers, openSession } from "../nav.ts";
import { ConfirmModal, keyValues, ListView, MenuModal, type MenuItem, PromptModal, section, selectRow, TextInput } from "../widgets.ts";
import { homeHooks, launchTarget } from "./home.ts";

type SortKey = "activity" | "created" | "cost" | "tokens" | "minutes" | "calls" | "size";
const SORTS: { id: SortKey; label: string; value: (r: SessionRecord) => number }[] = [
	{ id: "activity", label: "LAST ACTIVITY", value: (r) => r.lastActivity },
	{ id: "created", label: "CREATED", value: (r) => r.created },
	{ id: "cost", label: "COST", value: (r) => r.cost + r.warmCost },
	{ id: "tokens", label: "TOKENS", value: totalTokens },
	{ id: "minutes", label: "ACTIVE TIME", value: (r) => r.activeMinutes },
	{ id: "calls", label: "MODEL CALLS", value: (r) => r.assistantMessages },
	{ id: "size", label: "FILE SIZE", value: (r) => r.size },
];

const BIG_FILE = 20 * 1024 * 1024;

/** Sessions tab: session manager (SESSIONS.md §4). */
export class SessionsPage implements Page {
	readonly title = "SESSIONS";
	private readonly app: App;
	private filter: SessionFilter = defaultFilter();
	private rangeId: RangeId = "all";
	private sort: SortKey = "activity";
	private drillLabel: string | null = null;
	private readonly search = new TextInput();
	private searchFocused = false;
	private fullText: { query: string; counts: Map<string, number>; running: boolean; error?: string } | null = null;
	private snippetCache = new Map<string, string[]>();
	private readonly list = new ListView();
	private rows: SessionRecord[] = [];
	private rowsKey = "";
	private marked = new Set<string>();
	private live = new Map<string, LiveSession>();
	private liveAt = 0;
	private cleanupMode = false;

	constructor(app: App) {
		this.app = app;
		this.filter.includeSubagents = !app.config.hideSubagents;
		this.list.onActivate = () => this.openSelected();
		navHandlers.drillDown = (a, patch, label) => {
			this.filter = { ...defaultFilter(), includeSubagents: this.filter.includeSubagents, ...patch };
			this.rangeId = "all";
			this.drillLabel = label;
			this.fullText = null;
			this.search.set(patch.text ?? "");
			this.cleanupMode = false;
			this.list.selected = 0;
			a.go("sessions");
		};
	}

	captureText(): boolean {
		return this.searchFocused;
	}

	enter(): void {
		this.refreshLive(true);
	}

	private refreshLive(force = false): void {
		if (!force && Date.now() - this.liveAt < 2000) return;
		this.liveAt = Date.now();
		this.live = liveSessions();
	}

	// ── data ──────────────────────────────────────────────────────────────

	private effectiveFilter(): SessionFilter {
		const f = { ...this.filter, text: this.fullText ? "" : this.search.value.trim() };
		if (this.rangeId !== "all") f.from = Math.max(f.from, rangeBounds(this.rangeId).from);
		return f;
	}

	private computeRows(): void {
		const idx = this.app.index;
		const key = JSON.stringify([
			idx.revision,
			this.rangeId,
			this.sort,
			this.search.value,
			this.fullText?.query,
			this.fullText?.counts.size,
			this.cleanupMode,
			{ ...this.filter, ids: this.filter.ids ? [...this.filter.ids] : null },
		]);
		if (key === this.rowsKey) return;
		this.rowsKey = key;
		let rows: SessionRecord[];
		if (this.cleanupMode) {
			rows = this.cleanupCandidates().map((c) => c.rec);
		} else {
			rows = filterSessions(idx.records.values(), this.effectiveFilter(), this.app.meta);
			if (this.fullText) rows = rows.filter((r) => this.fullText!.counts.has(r.file));
			const sort = SORTS.find((s) => s.id === this.sort)!;
			if (this.fullText && !this.fullText.running) {
				const c = this.fullText.counts;
				rows.sort((a, b) => (c.get(b.file) ?? 0) - (c.get(a.file) ?? 0));
			} else rows.sort((a, b) => sort.value(b) - sort.value(a));
		}
		this.rows = rows;
		for (const f of [...this.marked]) if (!idx.records.has(f)) this.marked.delete(f);
	}

	/** Sessions worth cleaning up, with the reason (SESSIONS.md §4 "整理助手"). */
	private cleanupCandidates(): { rec: SessionRecord; reason: string }[] {
		const recs = [...this.app.index.records.values()];
		const files = new Set(recs.map((r) => r.file));
		const seenTitle = new Map<string, string>();
		const out: { rec: SessionRecord; reason: string }[] = [];
		for (const r of recs.sort((a, b) => b.lastActivity - a.lastActivity)) {
			let reason = "";
			if (r.userTurns === 0 && r.assistantMessages === 0) reason = "EMPTY";
			else if (r.isSubagent && r.parentSession && !files.has(r.parentSession)) reason = "ORPHAN SUBAGENT";
			else if (r.cwd && !existsSync(r.cwd)) reason = "CWD MISSING";
			else if (r.size > BIG_FILE) reason = `LARGE ${Math.round(r.size / 1048576)}MB`;
			else {
				const t = `${r.cwd}\n${sessionTitle(r)}`;
				if (seenTitle.has(t)) reason = "DUPLICATE TITLE";
				else seenTitle.set(t, r.file);
			}
			if (reason) out.push({ rec: r, reason });
		}
		return out;
	}

	private cleanupReason = new Map<string, string>();

	private get current(): SessionRecord | undefined {
		return this.rows[this.list.selected];
	}

	private targets(): SessionRecord[] {
		if (this.marked.size) return this.rows.filter((r) => this.marked.has(r.file));
		return this.current ? [this.current] : [];
	}

	// ── actions ───────────────────────────────────────────────────────────

	private openSelected(): void {
		const r = this.current;
		if (r) launchTarget(this.app, { kind: "resume", cwd: r.cwd, sessionFile: r.file }, r);
	}

	private runFullText(q: string): void {
		const query = q.trim();
		if (!query) {
			this.fullText = null;
			return;
		}
		this.fullText = { query, counts: new Map(), running: true };
		this.snippetCache.clear();
		void fullTextSearch(query, sessionRoots()).then((res) => {
			if (this.fullText?.query !== query) return;
			this.fullText = { query, counts: res.counts, running: false, error: res.error };
			this.app.requestRender();
		});
	}

	private rename(): void {
		const r = this.current;
		if (!r) return;
		if (this.live.has(r.file)) {
			this.app.toast("session is open in pi — rename it there with /name", "error");
			return;
		}
		this.app.modal(
			new PromptModal("RENAME_SESSION", r.name ?? "", (name) => {
				if (!name.trim()) return;
				renameSession(r.file, name.trim())
					.then(() => this.app.index.reparse(r.file))
					.then(() => this.app.toast(`renamed to "${name.trim()}"`))
					.catch((e: unknown) => this.app.toast(`rename failed: ${String(e)}`, "error"));
			}),
		);
	}

	private editTags(): void {
		const r = this.current;
		if (!r) return;
		const targets = this.targets();
		const initial = targets.length === 1 ? this.app.meta.tags(r.id).join(", ") : "";
		this.app.modal(
			new PromptModal(`TAGS (${targets.length} session${targets.length > 1 ? "s" : ""}, comma separated)`, initial, (v) => {
				const tags = v.split(",").map((t) => t.trim()).filter(Boolean);
				for (const t of targets) this.app.meta.setTags(t.id, targets.length === 1 ? tags : [...this.app.meta.tags(t.id), ...tags]);
				this.rowsKey = "";
				this.app.toast(`tags saved for ${targets.length} session(s)`);
			}),
		);
	}

	private editNote(): void {
		const r = this.current;
		if (!r) return;
		this.app.modal(
			new PromptModal("NOTE", this.app.meta.note(r.id), (v) => {
				this.app.meta.setNote(r.id, v);
				this.app.toast("note saved");
			}),
		);
	}

	private exportHtml(): void {
		const targets = this.targets();
		if (!targets.length) return;
		const dir = join(homeDataDir(), "exports");
		mkdirSync(dir, { recursive: true });
		this.app.toast(`exporting ${targets.length} session(s)…`);
		let done = 0;
		const failures: string[] = [];
		void (async () => {
			for (const r of targets) {
				const out = join(dir, `${basename(r.file, ".jsonl")}.html`);
				try {
					await exportSessionHtml(this.app.config.piBinary, r.file, out);
					done++;
				} catch (e) {
					failures.push(String(e));
				}
			}
			if (failures.length) this.app.toast(`export: ${done} ok, ${failures.length} failed: ${failures[0]}`, "error", 6000);
			else this.app.toast(`exported ${done} to ${tildify(dir)}`, "info", 6000);
		})();
	}

	private remove(): void {
		const targets = this.targets();
		if (!targets.length) return;
		const liveOnes = targets.filter((t) => this.live.has(t.file));
		if (liveOnes.length) {
			this.app.toast("cannot delete a session that is open in pi", "error");
			return;
		}
		this.app.modal(
			new ConfirmModal(`Move ${targets.length} session file(s) to the trash?`, () => {
				void (async () => {
					let ok = 0;
					for (const t of targets) {
						try {
							await trashSession(t.file);
							this.app.index.remove(t.file);
							this.marked.delete(t.file);
							ok++;
						} catch (e) {
							this.app.toast(`trash failed: ${String(e)}`, "error");
							return;
						}
					}
					this.app.toast(`moved ${ok} file(s) to the trash`);
				})();
			}, false),
		);
	}

	private pickProject(): void {
		const projects = listProjects(this.app.index.records.values(), this.app.config.pinnedProjects);
		const items: MenuItem[] = [
			{ label: "ALL PROJECTS", run: () => (this.filter.cwd = null) },
			...projects.map((p) => ({ label: p.name, hint: tildify(p.cwd), run: () => (this.filter.cwd = p.cwd) })),
		];
		this.app.modal(new MenuModal("FILTER_PROJECT", items));
	}

	private pickTag(): void {
		const tags = this.app.meta.allTags();
		if (!tags.length) {
			this.app.toast("no tags yet — press t on a session to add some");
			return;
		}
		this.app.modal(
			new MenuModal("FILTER_TAG", [
				{ label: "ANY TAG", run: () => (this.filter.tag = null) },
				...tags.map((t) => ({ label: `#${t}`, run: () => (this.filter.tag = t) })),
			]),
		);
	}

	private pickSort(): void {
		this.app.modal(
			new MenuModal(
				"SORT_BY",
				SORTS.map((s) => ({ label: s.label, run: () => (this.sort = s.id) })),
				SORTS.findIndex((s) => s.id === this.sort),
			),
		);
	}

	private clearFilters(): void {
		this.filter = { ...defaultFilter(), includeSubagents: this.filter.includeSubagents };
		this.drillLabel = null;
		this.fullText = null;
		this.search.set("");
		this.cleanupMode = false;
		this.rangeId = "all";
	}

	// ── input ─────────────────────────────────────────────────────────────

	paste(text: string): boolean {
		if (!this.searchFocused) return false;
		this.search.insert(text);
		return true;
	}

	hints(): string {
		if (this.searchFocused) return "type to filter  ?text = full-text search  enter apply  esc cancel";
		if (this.cleanupMode) return "CLEANUP: space mark  d trash marked  c exit cleanup";
		return "enter open  i detail  f fork  e profile  r rename  t tags  * fav  x export  d trash  space mark  / search  P T S F # E o X filters  c cleanup";
	}

	key(data: string, app: App): boolean {
		this.computeRows();
		if (this.searchFocused) {
			if (matchesKey(data, "escape")) {
				this.searchFocused = false;
				return true;
			}
			if (matchesKey(data, "enter")) {
				this.searchFocused = false;
				const v = this.search.value;
				if (v.startsWith("?")) this.runFullText(v.slice(1));
				else this.fullText = null;
				return true;
			}
			if (matchesKey(data, "up") || matchesKey(data, "down")) {
				this.searchFocused = false;
				return this.list.key(data, this.rows.length);
			}
			this.search.key(data);
			if (!this.search.value.startsWith("?")) this.fullText = null;
			this.list.selected = 0;
			return true;
		}
		if (matchesKey(data, "escape")) {
			if (this.drillLabel || this.fullText || this.search.value || this.cleanupMode) {
				this.clearFilters();
				return true;
			}
			return false;
		}
		const r = this.current;
		switch (data) {
			case "/":
				this.searchFocused = true;
				return true;
			case "i":
				if (r) openSession(app, r);
				return true;
			case "f":
				if (r) launchTarget(app, { kind: "fork", cwd: r.cwd, sessionFile: r.file }, r);
				return true;
			case "e":
				if (r && homeHooks.editProfile) homeHooks.editProfile(app, { kind: "resume", cwd: r.cwd, sessionFile: r.file }, r);
				else if (r) app.toast("profile editor not available", "error");
				return true;
			case "r":
				this.rename();
				return true;
			case "t":
				this.editTags();
				return true;
			case "n":
				this.editNote();
				return true;
			case "*":
				for (const t of this.targets()) app.meta.toggleFavorite(t.id);
				this.rowsKey = "";
				return true;
			case "x":
				this.exportHtml();
				return true;
			case "d":
				this.remove();
				return true;
			case " ":
				if (r) {
					if (this.marked.has(r.file)) this.marked.delete(r.file);
					else this.marked.add(r.file);
					this.list.selected++;
					this.list.clamp(this.rows.length);
				}
				return true;
			case "a":
				if (this.marked.size === this.rows.length) this.marked.clear();
				else for (const x of this.rows) this.marked.add(x.file);
				return true;
			case "P":
				this.pickProject();
				return true;
			case "T": {
				const i = RANGES.findIndex((x) => x.id === this.rangeId);
				this.rangeId = RANGES[(i + 1) % RANGES.length]!.id;
				return true;
			}
			case "S":
				this.filter.includeSubagents = !this.filter.includeSubagents;
				return true;
			case "F":
				this.filter.onlyFavorites = !this.filter.onlyFavorites;
				return true;
			case "#":
				this.pickTag();
				return true;
			case "E":
				this.filter.onlyErrors = !this.filter.onlyErrors;
				return true;
			case "o":
				this.pickSort();
				return true;
			case "X":
				this.clearFilters();
				return true;
			case "c":
				this.cleanupMode = !this.cleanupMode;
				this.list.selected = 0;
				return true;
		}
		if (matchesKey(data, "right")) {
			if (r) openSession(app, r);
			return true;
		}
		return this.list.key(data, this.rows.length);
	}

	// ── drawing ───────────────────────────────────────────────────────────

	draw(s: Surface, app: App): void {
		this.refreshLive();
		this.computeRows();
		if (this.cleanupMode) this.cleanupReason = new Map(this.cleanupCandidates().map((c) => [c.rec.file, c.reason]));
		const pal = app.pal;
		const wide = s.w >= 120;
		// The list gets most of the width so titles stay readable; the detail panel keeps 36-52 columns.
		const listW = wide ? s.w - Math.min(52, Math.max(36, Math.floor(s.w * 0.28))) : s.w;
		this.drawFilterBar(s.sub(1, 0, s.w - 2, 2), app);
		const listArea = s.sub(1, 2, listW - 2, s.h - 2);
		this.drawList(listArea, app);
		if (wide) {
			const r = this.current;
			const detail = s.sub(listW + 2, 2, s.w - listW - 3, s.h - 2);
			for (let y = 0; y < detail.h; y++) s.put(listW, 2 + y, "│", pal.faint);
			if (r) this.drawDetail(detail, r, app);
		}
	}

	private drawFilterBar(s: Surface, app: App): void {
		const pal = app.pal;
		let x = 0;
		x = s.text(x, 0, "/ ", this.searchFocused ? pal.strong : pal.dim);
		const searchW = Math.min(40, Math.max(16, Math.floor(s.w * 0.3)));
		s.fill(x, 0, searchW, 1, { bg: pal.panelBg });
		this.search.draw(s, x, 0, searchW, { fg: pal.p100, bg: pal.panelBg }, this.searchFocused, pal.sel, "search…  (?text = full text)");
		s.hit(x, 0, searchW, 1, { onClick: () => (this.searchFocused = true) });
		x += searchW + 2;
		const chip = (label: string, active: boolean, onClick: () => void): void => {
			const t = ` ${label} `;
			s.text(x, 0, t, active ? pal.sel : pal.dim);
			s.hit(x, 0, strWidth(t), 1, { onClick });
			x += strWidth(t) + 1;
		};
		const proj = this.filter.cwd ? basename(this.filter.cwd) : "ALL";
		chip(`P:${truncate(proj, 18)}`, this.filter.cwd !== null, () => this.pickProject());
		chip(`T:${RANGES.find((r) => r.id === this.rangeId)!.label}`, this.rangeId !== "all", () => {
			const i = RANGES.findIndex((r) => r.id === this.rangeId);
			this.rangeId = RANGES[(i + 1) % RANGES.length]!.id;
		});
		chip("S:SUB", this.filter.includeSubagents, () => (this.filter.includeSubagents = !this.filter.includeSubagents));
		chip("F:FAV", this.filter.onlyFavorites, () => (this.filter.onlyFavorites = !this.filter.onlyFavorites));
		chip(`#:${this.filter.tag ?? "TAG"}`, this.filter.tag !== null, () => this.pickTag());
		chip("E:ERR", this.filter.onlyErrors, () => (this.filter.onlyErrors = !this.filter.onlyErrors));
		chip(`o:${SORTS.find((x) => x.id === this.sort)!.label}`, false, () => this.pickSort());
		const count = `${this.rows.length} SESSIONS${this.marked.size ? ` · ${this.marked.size} MARKED` : ""}`;
		s.textIn(0, 0, s.w, count, pal.title, "right");
		// Second row: drill-down / full-text / cleanup banner.
		let banner = "";
		if (this.cleanupMode) banner = "CLEANUP ASSISTANT :: empty, orphaned, missing-cwd, large and duplicate sessions";
		else if (this.fullText)
			banner = this.fullText.running
				? `FULL TEXT "${this.fullText.query}" :: searching…`
				: `FULL TEXT "${this.fullText.query}" :: ${this.fullText.counts.size} files${this.fullText.error ? ` (${this.fullText.error})` : ""}`;
		else if (this.drillLabel) banner = `DRILL-DOWN :: ${this.drillLabel}`;
		if (banner) {
			s.text(0, 1, `» ${banner}`, pal.strong);
			s.textIn(0, 1, s.w, "esc / X clear", pal.dim, "right");
		} else s.hline(0, 1, s.w, pal.faint);
	}

	private drawList(s: Surface, app: App): void {
		const pal = app.pal;
		if (!this.rows.length) {
			const msg = app.index.progress.finished ? "NO SESSIONS MATCH" : "INDEXING…";
			s.textIn(0, Math.floor(s.h / 2), s.w, msg, pal.dim, "center");
			return;
		}
		this.list.draw(s, this.rows.length, (i, row, sel) => {
			const r = this.rows[i]!;
			if (sel) selectRow(row, pal);
			const base = sel ? pal.sel : pal.text;
			const dim = sel ? pal.sel : pal.dim;
			const marked = this.marked.has(r.file);
			// R running in pi, * favourite, f has a parent session, s subagent.
			const flags =
				(this.live.has(r.file) ? "R" : " ") +
				(app.meta.isFavorite(r.id) ? "*" : " ") +
				(r.parentSession ? "f" : " ") +
				(r.isSubagent ? "s" : " ");
			row.text(0, 0, marked ? "▌" : sel ? ">" : " ", sel ? pal.sel : { fg: pal.p100 });
			row.text(1, 0, flags, sel ? pal.sel : { fg: pal.p70, attr: 1 });
			const extra = this.cleanupMode
				? this.cleanupReason.get(r.file) ?? ""
				: this.fullText && !this.fullText.running
					? `${this.fullText.counts.get(r.file) ?? 0} hits`
					: "";
			const right = `${extra ? `${extra}  ` : ""}${padEnd(truncate(basename(r.cwd), 12), 12)} ${row.w >= 110 ? `${padEnd(truncate(shortModel(mainModel(r)), 14), 14)} ` : ""}${fmtTokens(totalTokens(r)).padStart(5)} ${fmtCost(r.cost + r.warmCost).padStart(6)} ${fmtAgo(r.lastActivity).padStart(8)}`;
			const rw = strWidth(right);
			row.text(6, 0, truncate(sessionTitle(r), Math.max(4, row.w - rw - 7)), base);
			row.textIn(0, 0, row.w, right, dim, "right");
		});
	}

	private drawDetail(s: Surface, r: SessionRecord, app: App): void {
		const pal = app.pal;
		let y = section(s, 0, 0, s.w, "SESSION", pal);
		const title = sessionTitle(r);
		s.text(0, y++, truncate(title, s.w), pal.strong);
		const live = this.live.get(r.file);
		y = keyValues(
			s,
			0,
			y + 1,
			[
				["PATH", truncate(tildify(r.cwd), s.w - 12)],
				["CREATED", fmtDateTime(r.created)],
				["LAST", `${fmtDateTime(r.lastActivity)} (${fmtAgo(r.lastActivity)})`],
				["STATUS", live ? `OPEN in pi (pid ${live.pid})` : r.isSubagent ? "subagent" : "idle"],
				["TURNS", `${r.userTurns} user · ${fmtInt(r.assistantMessages)} calls · ${fmtInt(r.toolCalls)} tools`],
				["TOKENS", `${fmtTokens(totalTokens(r))}  (in ${fmtTokens(r.tokens.input)} · out ${fmtTokens(r.tokens.output)} · cache ${fmtTokens(r.tokens.cacheRead)})`],
				["COST", `${fmtCost(r.cost)}${r.warmCost ? ` + warm-up ${fmtCost(r.warmCost)}` : ""}`],
				["ACTIVE", fmtMinutes(r.activeMinutes)],
				["PEAK CTX", fmtTokens(r.maxContext)],
				["ERRORS", `${r.errors} error · ${r.aborted} aborted · ${r.compactions} compactions`],
				["SIZE", `${(r.size / 1048576).toFixed(1)}MB${r.badLines ? ` · ${r.badLines} bad lines` : ""}`],
			],
			pal,
		);
		const tags = app.meta.tags(r.id);
		const note = app.meta.note(r.id);
		if (tags.length) s.text(0, y++, tags.map((t) => `#${t}`).join(" "), pal.title);
		if (note) s.text(0, y++, truncate(`NOTE: ${note}`, s.w), pal.dim);
		y++;
		// Context water level: one column per call, height = input+cacheRead+cacheWrite.
		if (y + 4 < s.h) {
			y = section(s, 0, y, s.w, "CONTEXT_LEVEL", pal, fmtTokens(r.maxContext));
			this.drawWater(s.sub(0, y, s.w, 3), r, app);
			y += 4;
		}
		// Model share.
		if (y + 3 < s.h) {
			y = section(s, 0, y, s.w, "MODELS", pal);
			const models = Object.entries(r.models).sort((a, b) => b[1].calls - a[1].calls);
			for (const [m, st] of models.slice(0, Math.min(4, s.h - y - 1))) {
				const share = st.calls / Math.max(1, r.assistantMessages);
				const bw = Math.max(1, Math.round(share * 20));
				s.text(0, y, "█".repeat(bw), { fg: pal.p70 });
				s.text(22, y++, truncate(`${shortModel(m)}  ${Math.round(share * 100)}%  ${fmtCost(st.cost)}`, s.w - 22), pal.text);
			}
			y++;
		}
		// Snippets for full-text matches, otherwise touched files.
		if (this.fullText && !this.fullText.running && y + 2 < s.h) {
			y = section(s, 0, y, s.w, "MATCHES", pal);
			const cached = this.snippetCache.get(r.file);
			if (!cached) {
				this.snippetCache.set(r.file, []);
				void snippets(this.fullText.query, r.file).then((sn) => {
					this.snippetCache.set(r.file, sn);
					app.requestRender();
				});
			}
			for (const sn of cached ?? []) if (y < s.h) s.text(0, y++, truncate(sn, s.w), pal.dim);
		} else if (y + 2 < s.h) {
			y = section(s, 0, y, s.w, "FILES", pal);
			const files = Object.entries(r.files).sort((a, b) => b[1].edit + b[1].write - (a[1].edit + a[1].write));
			for (const [f, st] of files) {
				if (y >= s.h) break;
				const tag = `${st.edit + st.write}e ${st.read}r`;
				s.text(0, y, truncate(tildify(f), s.w - tag.length - 2), pal.text);
				s.textIn(0, y++, s.w, tag, pal.dim, "right");
			}
		}
	}

	private drawWater(s: Surface, r: SessionRecord, app: App): void {
		const pal = app.pal;
		const ev = r.ev;
		const n = ev.cT.length;
		if (!n || s.w < 4) return;
		const levels = "▁▂▃▄▅▆▇█";
		const max = Math.max(1, r.maxContext);
		const k = app.progress(500);
		for (let x = 0; x < s.w; x++) {
			const a = Math.floor((x * n) / s.w);
			const b = Math.max(a + 1, Math.floor(((x + 1) * n) / s.w));
			let v = 0;
			for (let i = a; i < b && i < n; i++) v = Math.max(v, ev.cIn[i]! + ev.cCR[i]! + ev.cCW[i]!);
			const h = (v / max) * s.h * 8 * k;
			for (let row = 0; row < s.h; row++) {
				const fill = Math.max(0, Math.min(8, h - (s.h - 1 - row) * 8));
				if (fill > 0) s.put(x, row, levels[Math.max(0, Math.ceil(fill) - 1)]!, { fg: pal.ramp(v / max) });
			}
		}
	}
}
