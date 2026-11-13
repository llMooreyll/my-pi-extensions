import { matchesKey } from "@earendil-works/pi-tui";
import { describeProfile, emptyProfile, normalizeProfile } from "../../../shared/profile.ts";
import { tildify } from "../../paths.ts";
import type { Surface } from "../../term/canvas.ts";
import { truncate } from "../../term/width.ts";
import type { App, Page } from "../app.ts";
import { ConfirmModal, ListView, MenuModal, PromptModal, section, selectRow } from "../widgets.ts";
import { argsEnv, FullCommandModal, previewArgs, previewCommand } from "./profile-hooks.ts";
import { ProfileEditorPage } from "./profile-editor.ts";

type Entry = { kind: "preset"; name: string } | { kind: "global" } | { kind: "projects" };

export class PresetsPage implements Page {
	readonly title = "PRESETS";
	private readonly list = new ListView();
	private readonly app: App;

	constructor(app: App) {
		this.app = app;
		this.list.onActivate = () => this.edit();
	}

	private entries(): Entry[] {
		const cfg = this.app.config;
		return [
			...Object.keys(cfg.presets).map((name): Entry => ({ kind: "preset", name })),
			{ kind: "global" },
			{ kind: "projects" },
		];
	}

	private label(e: Entry): string {
		if (e.kind === "preset") return e.name;
		if (e.kind === "global") return "GLOBAL DEFAULT";
		return `PROJECT DEFAULTS (${Object.keys(this.app.config.projectDefaults).length})`;
	}

	private get current(): Entry | undefined {
		return this.entries()[this.list.selected];
	}

	hints(): string {
		return "↑↓ move  enter edit  n new  r rename  c duplicate  d delete  tab next tab  q quit";
	}

	// ── actions ─────────────────────────────────────────────────────────

	private uniqueName(base: string): string {
		let name = base;
		for (let i = 2; name in this.app.config.presets; i++) name = `${base}-${i}`;
		return name;
	}

	private newPreset(): void {
		this.app.modal(
			new PromptModal("NEW PRESET NAME", "", (v) => {
				const name = v.trim();
				if (!name) return;
				if (name in this.app.config.presets) return this.app.toast(`preset "${name}" already exists`, "error");
				this.app.config.presets[name] = emptyProfile();
				this.app.saveConfig();
				this.list.selected = Object.keys(this.app.config.presets).indexOf(name);
				this.app.toast(`preset "${name}" created`);
			}),
		);
	}

	private edit(): void {
		const e = this.current;
		if (!e) return;
		const target = { kind: "new" as const, cwd: process.cwd() };
		if (e.kind === "preset") this.app.push(new ProfileEditorPage(this.app, target, null, { editPreset: e.name }));
		else if (e.kind === "global") this.app.push(new ProfileEditorPage(this.app, target, null, { editDefault: "global" }));
		else {
			const cwds = Object.keys(this.app.config.projectDefaults);
			if (cwds.length === 0) return this.app.toast("no project defaults yet: save one from a project's profile editor (d)");
			this.app.modal(
				new MenuModal(
					"PROJECT DEFAULTS",
					cwds.map((cwd) => ({
						label: tildify(cwd),
						run: () => this.app.push(new ProfileEditorPage(this.app, { kind: "new", cwd }, null, { editDefault: "project" })),
					})),
				),
			);
		}
	}

	private rename(e: Entry): void {
		if (e.kind !== "preset") return this.app.toast("only presets can be renamed");
		this.app.modal(
			new PromptModal("RENAME PRESET", e.name, (v) => {
				const name = v.trim();
				const presets = this.app.config.presets;
				if (!name || name === e.name) return;
				if (name in presets) return this.app.toast(`preset "${name}" already exists`, "error");
				// Rebuild to keep the list order.
				this.app.config.presets = Object.fromEntries(Object.entries(presets).map(([k, p]) => [k === e.name ? name : k, p]));
				this.app.saveConfig();
				this.app.toast(`renamed to "${name}"`);
			}),
		);
	}

	private duplicate(e: Entry): void {
		if (e.kind !== "preset") return this.app.toast("only presets can be duplicated");
		this.app.modal(
			new PromptModal("DUPLICATE PRESET AS", this.uniqueName(`${e.name}-copy`), (v) => {
				const name = v.trim();
				if (!name) return;
				if (name in this.app.config.presets) return this.app.toast(`preset "${name}" already exists`, "error");
				this.app.config.presets[name] = structuredClone(this.app.config.presets[e.name]!);
				this.app.saveConfig();
				this.list.selected = Object.keys(this.app.config.presets).indexOf(name);
				this.app.toast(`duplicated as "${name}"`);
			}),
		);
	}

	private remove(e: Entry): void {
		if (e.kind !== "preset") return this.app.toast("only presets can be deleted here");
		this.app.modal(
			new ConfirmModal(`Delete preset "${e.name}"?`, () => {
				delete this.app.config.presets[e.name];
				this.app.saveConfig();
				this.app.toast(`preset "${e.name}" deleted`);
			}),
		);
	}

	private showFullCommand(): void {
		const e = this.current;
		if (!e || e.kind === "projects") return;
		const profile = normalizeProfile(e.kind === "preset" ? this.app.config.presets[e.name] : this.app.config.globalDefault);
		if (profile) this.app.modal(new FullCommandModal(previewArgs({ kind: "new", cwd: process.cwd() }, profile, argsEnv(process.cwd()))));
	}

	key(data: string): boolean {
		const e = this.current;
		if (data === "n") return this.newPreset(), true;
		if (e && data === "r") return this.rename(e), true;
		if (e && data === "c") return this.duplicate(e), true;
		if (e && data === "d") return this.remove(e), true;
		if (data === "v") return this.showFullCommand(), true;
		if (matchesKey(data, "escape")) return false;
		return this.list.key(data, this.entries().length);
	}

	// ── drawing ─────────────────────────────────────────────────────────

	draw(s: Surface, app: App): void {
		const pal = app.pal;
		const entries = this.entries();
		const leftW = Math.floor(s.w * 0.32);
		const left = s.sub(0, 0, leftW, s.h);
		const right = s.sub(leftW + 2, 0, s.w - leftW - 2, s.h);
		s.vline(leftW, 0, s.h, pal.faint, pal.caps.unicode ? "│" : "|");

		const ly = section(left, 1, 0, left.w - 2, "PRESETS", pal);
		this.list.draw(left.sub(1, ly, left.w - 2, left.h - ly), entries.length, (i, row, sel) => {
			if (sel) selectRow(row, pal);
			const e = entries[i]!;
			const pseudo = e.kind !== "preset";
			row.text(0, 0, `${sel ? ">" : " "} ${truncate(this.label(e), row.w - 3)}`, sel ? pal.sel : pseudo ? pal.strong : pal.text);
		});

		const e = this.current;
		if (!e) return;
		let y = section(right, 0, 0, right.w, this.label(e), pal);
		if (e.kind === "projects") {
			const cwds = Object.keys(app.config.projectDefaults);
			if (cwds.length === 0) right.text(0, y, "No project defaults. Save one with d in a project's profile editor.", pal.dim);
			for (const cwd of cwds) {
				right.text(0, y++, truncate(tildify(cwd), right.w), pal.strong);
				const lines = describeProfile(normalizeProfile(app.config.projectDefaults[cwd]) ?? emptyProfile());
				right.text(2, y++, truncate(lines.join(" · ") || "default settings", right.w - 2), pal.dim);
				if (y >= right.h - 1) break;
			}
			return;
		}
		const profile = normalizeProfile(e.kind === "preset" ? app.config.presets[e.name] : app.config.globalDefault);
		if (!profile) {
			right.text(0, y, e.kind === "global" ? "No global default set. Press enter to create one." : "Invalid preset.", pal.dim);
			return;
		}
		const lines = describeProfile(profile);
		if (lines.length === 0) right.text(0, y++, "Default settings only.", pal.dim);
		for (const l of lines) right.text(0, y++, truncate(`- ${l}`, right.w), pal.text);

		y++;
		y = section(right, 0, y, right.w, "COMMAND_PREVIEW (new session here)", pal);
		const text = previewCommand({ kind: "new", cwd: process.cwd() }, profile, argsEnv(process.cwd()));
		const w = right.w;
		for (let i = 0; i * w < text.length && y + i < right.h; i++) {
			const last = y + i === right.h - 1 && (i + 1) * w < text.length;
			right.text(0, y + i, last ? truncate(text.slice(i * w), w) : text.slice(i * w, (i + 1) * w), pal.text);
		}
	}
}
