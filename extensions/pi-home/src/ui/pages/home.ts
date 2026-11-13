import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { matchesKey } from "@earendil-works/pi-tui";
import { DAY_MS, listProjects, mainModel, type Project, sessionTitle, startOfDay, totalTokens } from "../../index/query.ts";
import type { SessionRecord } from "../../index/types.ts";
import { type LaunchTarget, targetArgs } from "../../launch/args.ts";
import { tildify } from "../../paths.ts";
import type { Surface } from "../../term/canvas.ts";
import { truncate } from "../../term/width.ts";
import type { App, Page } from "../app.ts";
import { BIG_HEIGHT, bigTextScale, bigTextWidth, drawBigText } from "../bigtext.ts";
import { fmtAgo, fmtCost, fmtTokens, shortModel } from "../format.ts";
import { keyValues, ListView, PromptModal, progressBar, section, selectRow } from "../widgets.ts";

type Focus = "projects" | "sessions";

/**
 * Hooks installed by the profile layer (docs/tasks/B-profile.md step B4). Without them pi-home
 * launches plain pi with only the session-selection arguments.
 */
export const homeHooks: {
	/** Full pi argument list for a launch (session selection + profile flags + --home-profile). */
	buildArgs?: (app: App, target: LaunchTarget, rec: SessionRecord | null) => string[];
	/** Open the profile editor for a target. */
	editProfile?: (app: App, target: LaunchTarget, rec: SessionRecord | null) => void;
} = {};

/** Open a target in pi through the zsh launch loop. */
export function launchTarget(app: App, target: LaunchTarget, rec: SessionRecord | null): void {
	const args = homeHooks.buildArgs ? homeHooks.buildArgs(app, target, rec) : targetArgs(target);
	app.launch({ cwd: target.cwd, args });
}

export class HomePage implements Page {
	readonly title = "HOME";
	private focus: Focus = "projects";
	private readonly projList = new ListView();
	private readonly sessList = new ListView();
	private projects: Project[] = [];
	private sessions: SessionRecord[] = [];
	private rev = -1;

	private readonly app: App;

	constructor(app: App) {
		this.app = app;
		this.projList.onActivate = () => this.newSession();
		this.sessList.onActivate = (i) => {
			const r = this.sessions[i];
			if (r) launchTarget(this.app, { kind: "resume", cwd: r.cwd, sessionFile: r.file }, r);
		};
	}

	private refresh(): void {
		const idx = this.app.index;
		if (this.rev === idx.revision) return;
		this.rev = idx.revision;
		const prevCwd = this.projects[this.projList.selected]?.cwd;
		this.projects = listProjects(idx.records.values(), this.app.config.pinnedProjects);
		if (prevCwd) {
			const i = this.projects.findIndex((p) => p.cwd === prevCwd);
			if (i >= 0) this.projList.selected = i;
		} else {
			// Start on the project pi-home was launched from, if known.
			const i = this.projects.findIndex((p) => p.cwd === process.cwd());
			if (i >= 0) this.projList.selected = i;
		}
		this.loadSessions();
	}

	private loadSessions(): void {
		const p = this.projects[this.projList.selected];
		this.sessions = p
			? [...this.app.index.records.values()]
					.filter((r) => r.cwd === p.cwd && (!r.isSubagent || !this.app.config.hideSubagents))
					.sort((a, b) => b.lastActivity - a.lastActivity)
			: [];
	}

	private get project(): Project | undefined {
		return this.projects[this.projList.selected];
	}

	private newSession(): void {
		const p = this.project;
		if (!p) return;
		if (!p.exists) {
			this.app.toast(`directory does not exist: ${tildify(p.cwd)}`, "error");
			return;
		}
		launchTarget(this.app, { kind: "new", cwd: p.cwd }, null);
	}

	private continueLatest(): void {
		const p = this.project;
		if (!p) return;
		const latest = this.sessions[0];
		if (!latest) return this.newSession();
		launchTarget(this.app, { kind: "resume", cwd: p.cwd, sessionFile: latest.file }, latest);
	}

	private openPath(): void {
		this.app.modal(
			new PromptModal("OPEN_DIRECTORY", `${tildify(process.cwd())}/`, (value) => {
				const p = resolve(value.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
				if (!existsSync(p) || !statSync(p).isDirectory()) {
					this.app.toast(`not a directory: ${value}`, "error");
					return;
				}
				launchTarget(this.app, { kind: "new", cwd: p }, null);
			}),
		);
	}

	private togglePin(): void {
		const p = this.project;
		if (!p) return;
		const pins = this.app.config.pinnedProjects;
		const i = pins.indexOf(p.cwd);
		if (i >= 0) pins.splice(i, 1);
		else pins.push(p.cwd);
		this.app.saveConfig();
		this.rev = -1;
		this.app.toast(i >= 0 ? `unpinned ${p.name}` : `pinned ${p.name}`);
	}

	private editProfile(): void {
		const p = this.project;
		if (!p) return;
		if (!homeHooks.editProfile) {
			this.app.toast("profile editor not available", "error");
			return;
		}
		if (this.focus === "sessions") {
			const r = this.sessions[this.sessList.selected];
			if (r) return homeHooks.editProfile(this.app, { kind: "resume", cwd: r.cwd, sessionFile: r.file }, r);
		}
		homeHooks.editProfile(this.app, { kind: "new", cwd: p.cwd }, null);
	}

	hints(): string {
		return this.focus === "projects"
			? "enter new session  c continue  e profile  o open path  p pin  → sessions  tab next tab  q quit"
			: "enter resume  f fork  e profile  ← projects  q quit";
	}

	key(data: string): boolean {
		this.refresh();
		if (matchesKey(data, "right") || matchesKey(data, "l")) {
			if (this.sessions.length) this.focus = "sessions";
			return true;
		}
		if (matchesKey(data, "left") || matchesKey(data, "h")) {
			this.focus = "projects";
			return true;
		}
		if (data === "c") return this.continueLatest(), true;
		if (data === "n") return this.newSession(), true;
		if (data === "o") return this.openPath(), true;
		if (data === "p") return this.togglePin(), true;
		if (data === "e") return this.editProfile(), true;
		if (data === "r") {
			void this.app.index.refresh();
			return true;
		}
		if (this.focus === "projects") {
			const before = this.projList.selected;
			const used = this.projList.key(data, this.projects.length);
			if (this.projList.selected !== before) {
				this.sessList.selected = 0;
				this.loadSessions();
			}
			return used;
		}
		if (data === "f") {
			const r = this.sessions[this.sessList.selected];
			if (r) launchTarget(this.app, { kind: "fork", cwd: r.cwd, sessionFile: r.file }, r);
			return true;
		}
		return this.sessList.key(data, this.sessions.length);
	}

	draw(s: Surface, app: App): void {
		this.refresh();
		const pal = app.pal;
		const wide = s.w >= 100 && s.h >= 24;
		const leftW = wide ? Math.max(48, Math.floor(s.w * 0.42)) : s.w;
		const left = s.sub(1, 0, leftW - 2, s.h);
		let y = 1;
		if (wide && pal.caps.unicode) {
			const title = "PI.HOME";
			const px = bigTextScale(title, left.w - 2);
			if (px > 0) {
				const reveal = app.progress(700);
				const tx = Math.max(0, Math.floor((left.w - bigTextWidth(title, px)) / 2));
				drawBigText(left, tx, y, title, { fg: pal.p100 }, { fg: pal.p25 }, reveal, px);
				y += BIG_HEIGHT + 2;
			}
		}
		y = section(left, 0, y, left.w, "PROJECTS", pal, `${this.projects.length}`);
		const listBox = left.sub(0, y, left.w, left.h - y);
		const focusedP = this.focus === "projects";
		listBox.box(0, 0, listBox.w, listBox.h, { fg: focusedP ? pal.p70 : pal.p25 }, "single");
		this.projList.draw(listBox.inset(1, 1, 1, 1), this.projects.length, (i, row, sel) => {
			const p = this.projects[i]!;
			const active = sel && focusedP;
			if (active) selectRow(row, pal);
			const st = active ? pal.sel : p.exists ? pal.text : pal.dim;
			const mark = p.pinned ? "*" : " ";
			row.text(0, 0, `${active ? ">" : sel ? "›" : " "}${mark}`, st);
			const right = `${p.sessions} · ${fmtAgo(p.lastActivity)}`;
			row.text(3, 0, truncate(p.name, row.w - right.length - 5), st);
			row.textIn(0, 0, row.w, right, active ? pal.sel : pal.dim, "right");
		});
		listBox.hit(0, 0, listBox.w, listBox.h, { onClick: () => (this.focus = "projects") });
		if (this.projList.selected !== this.lastSel) {
			this.lastSel = this.projList.selected;
			this.loadSessions();
		}

		if (!wide) return;
		const right = s.sub(leftW + 2, 0, s.w - leftW - 3, s.h);
		this.drawRight(right, app);
	}

	private lastSel = -1;

	private drawRight(s: Surface, app: App): void {
		const pal = app.pal;
		const p = this.project;
		let y = 1;
		y = section(s, 0, y, s.w, "PROJECT_STATUS", pal);
		if (p) {
			const tok = this.sessions.reduce((a, r) => a + totalTokens(r), 0);
			y = keyValues(
				s,
				0,
				y,
				[
					["PATH", tildify(p.cwd) + (p.exists ? "" : "  [MISSING]")],
					["SESSIONS", `${p.sessions}  (${fmtTokens(tok)} tokens)`],
					["COST", `${fmtCost(p.cost)} total  ·  ${fmtCost(p.cost7d)} last 7d`],
					["LAST", p.lastActivity ? fmtAgo(p.lastActivity) : "never"],
				],
				pal,
			);
		}
		y++;
		const sessH = Math.max(5, s.h - y - 9);
		y = section(s, 0, y, s.w, "RECENT_SESSIONS", pal, `${this.sessions.length}`);
		const box = s.sub(0, y, s.w, sessH);
		const focusedS = this.focus === "sessions";
		this.sessList.draw(box, this.sessions.length, (i, row, sel) => {
			const r = this.sessions[i]!;
			const active = sel && focusedS;
			if (active) selectRow(row, pal);
			const st = active ? pal.sel : pal.text;
			const meta = `${shortModel(mainModel(r))}  ${fmtCost(r.cost)}  ${fmtAgo(r.lastActivity)}`;
			row.text(0, 0, active ? ">" : " ", st);
			row.text(2, 0, truncate(sessionTitle(r), row.w - meta.length - 4), st);
			row.textIn(0, 0, row.w, meta, active ? pal.sel : pal.dim, "right");
		});
		box.hit(0, 0, box.w, box.h, { onClick: () => (this.focus = "sessions") });
		if (this.sessions.length === 0) s.text(2, y, "no sessions yet — enter starts one", pal.dim);
		y += sessH + 1;
		this.drawTemporal(s.sub(0, y, s.w, s.h - y), app);
	}

	/** Reference-style metrics: today vs average, week log, day / year progress. */
	private drawTemporal(s: Surface, app: App): void {
		const pal = app.pal;
		if (s.h < 6) return;
		let y = section(s, 0, 0, s.w, "TEMPORAL_METRICS", pal);
		const now = Date.now();
		const today = startOfDay(now);
		let todayCost = 0;
		let todayTok = 0;
		let monthCost = 0;
		const weekActive = new Array(7).fill(0);
		const monday = today - ((new Date(today).getDay() + 6) % 7) * DAY_MS;
		const monthStart = new Date(new Date(today).getFullYear(), new Date(today).getMonth(), 1).getTime();
		for (const r of app.index.records.values()) {
			if (r.lastActivity < monthStart) continue;
			const ev = r.ev;
			for (let i = 0; i < ev.cT.length; i++) {
				const t = ev.cT[i]!;
				if (t >= monthStart) monthCost += ev.cCost[i]!;
				if (t >= today) {
					todayCost += ev.cCost[i]!;
					todayTok += ev.cIn[i]! + ev.cOut[i]! + ev.cCR[i]! + ev.cCW[i]!;
				}
				if (t >= monday) weekActive[Math.min(6, Math.floor((t - monday) / DAY_MS))]++;
			}
		}
		const barW = Math.min(40, s.w - 24);
		const k = app.progress(600);
		const dayFrac = (now - today) / DAY_MS;
		const y0 = new Date(new Date(now).getFullYear(), 0, 1).getTime();
		const y1 = new Date(new Date(now).getFullYear() + 1, 0, 1).getTime();
		s.text(0, y, "> DAY PROG  ", pal.text);
		progressBar(s, 12, y++, barW, dayFrac * k, pal);
		s.text(0, y, "> YEAR PROG ", pal.text);
		progressBar(s, 12, y++, barW, ((now - y0) / (y1 - y0)) * k, pal);
		s.text(0, y, "> WEEK LOG  [", pal.text);
		let x = 13;
		const dow = (new Date(now).getDay() + 6) % 7;
		for (let d = 0; d < 7; d++) {
			const on = weekActive[d]! > 0;
			const glyph = d > dow ? "·" : on ? "█" : "░";
			s.text(x, y, glyph, { fg: on ? pal.p100 : pal.p25 });
			x += 2;
		}
		s.text(x - 1, y, "]", pal.text);
		s.text(x + 1, y++, `(${weekActive.filter((n) => n > 0).length}/7 THIS WEEK)`, pal.dim);
		s.text(0, y, `> TODAY     ${fmtTokens(todayTok)} tokens · ${fmtCost(todayCost)}   MONTH ${fmtCost(monthCost)}`, pal.text);
	}
}
