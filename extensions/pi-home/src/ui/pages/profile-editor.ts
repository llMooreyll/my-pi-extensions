import { matchesKey } from "@earendil-works/pi-tui";
import { emptyProfile, isEmptyProfile, normalizeProfile } from "../../../shared/profile.ts";
import type { Profile, ThinkingLevel } from "../../../shared/profile.ts";
import type { SessionRecord } from "../../index/types.ts";
import { sessionTitle } from "../../index/query.ts";
import type { LaunchTarget } from "../../launch/args.ts";
import { writeProfileFile } from "../../launch/profile-file.ts";
import { resolveProfile } from "../../launch/resolve.ts";
import { tildify } from "../../paths.ts";
import { loadModels, type ModelEntry } from "../../resources/models.ts";
import type { ResourceItem } from "../../resources/types.ts";
import type { Surface } from "../../term/canvas.ts";
import { strWidth, truncate } from "../../term/width.ts";
import type { App, Modal, Page } from "../app.ts";
import { ListView, MenuModal, PromptModal, section, selectRow, TextInput } from "../widgets.ts";
import { argsEnv, composeArgs, resourcesFor } from "./profile-hooks.ts";

// ── Checklist / chooser modal ───────────────────────────────────────────

export interface ChecklistItem {
	id: string;
	label: string;
	hint?: string;
}

/**
 * Filterable list. Multi mode: Space toggles, Enter confirms the checked ids. Single mode: Enter
 * picks the highlighted item. Typing edits the filter, so navigation uses arrows and page keys only.
 */
export class ChecklistModal implements Modal {
	readonly width = 92;
	readonly height = 26;
	private readonly filter = new TextInput();
	private readonly list = new ListView();
	private readonly checked: Set<string>;
	private shown: ChecklistItem[];
	private readonly title: string;
	private readonly items: ChecklistItem[];
	private readonly single: boolean;
	private readonly onDone: (ids: string[]) => void;

	constructor(title: string, items: ChecklistItem[], selected: string[], single: boolean, onDone: (ids: string[]) => void) {
		this.title = title;
		this.items = items;
		this.single = single;
		this.onDone = onDone;
		this.checked = new Set(selected);
		this.shown = items;
		if (single) this.list.selected = Math.max(0, items.findIndex((i) => i.id === selected[0]));
	}

	private refilter(): void {
		const q = this.filter.value.trim().toLowerCase();
		this.shown = q ? this.items.filter((i) => `${i.label} ${i.hint ?? ""}`.toLowerCase().includes(q)) : this.items;
		this.list.selected = 0;
		this.list.scroll = 0;
	}

	private finish(app: App, ids: string[]): void {
		app.closeModal();
		this.onDone(ids);
	}

	private activate(app: App, i: number): void {
		const it = this.shown[i];
		if (!it) return;
		if (this.single) this.finish(app, [it.id]);
		else if (!this.checked.delete(it.id)) this.checked.add(it.id);
	}

	draw(s: Surface, app: App): void {
		const pal = app.pal;
		s.text(1, 0, `[ ${this.title} ]`, pal.title);
		if (!this.single) s.textIn(1, 0, s.w - 2, `${this.checked.size}/${this.items.length} selected`, pal.dim, "right");
		s.text(1, 1, ">", pal.strong);
		this.filter.draw(s, 3, 1, s.w - 4, pal.text, true, pal.sel, "type to filter");
		s.hline(0, 2, s.w, pal.faint, pal.caps.unicode ? "─" : "-");
		this.list.onActivate = (i) => this.activate(app, i);
		this.list.draw(s.sub(0, 3, s.w, s.h - 5), this.shown.length, (i, row, sel) => {
			const it = this.shown[i]!;
			if (sel) selectRow(row, pal);
			const st = sel ? pal.sel : pal.text;
			const box = this.single ? (sel ? ">" : " ") : this.checked.has(it.id) ? "[x]" : "[ ]";
			row.text(1, 0, `${box} ${truncate(it.label, row.w - 8 - strWidth(it.hint ?? ""))}`, st);
			if (it.hint) row.textIn(0, 0, row.w - 1, it.hint, sel ? pal.sel : pal.dim, "right");
		});
		const hint = this.single ? "enter choose   esc cancel" : "space toggle   ctrl+a all/none   enter confirm   esc cancel";
		s.text(1, s.h - 1, hint, pal.dim);
	}

	key(data: string, app: App): void {
		if (matchesKey(data, "escape")) return app.closeModal();
		if (matchesKey(data, "enter")) {
			if (this.single) this.activate(app, this.list.selected);
			else this.finish(app, this.items.filter((i) => this.checked.has(i.id)).map((i) => i.id));
			return;
		}
		if (matchesKey(data, "ctrl+a") && !this.single) {
			const all = this.shown.every((i) => this.checked.has(i.id));
			for (const i of this.shown) (all ? this.checked.delete(i.id) : this.checked.add(i.id));
			return;
		}
		if (data === " " && !this.single) return this.activate(app, this.list.selected);
		if (["up", "down", "pageUp", "pageDown"].some((k) => matchesKey(data, k as "up"))) {
			this.list.key(data, this.shown.length);
			return;
		}
		if (this.filter.key(data)) this.refilter();
	}

	paste(text: string): void {
		this.filter.insert(text);
		this.refilter();
	}
}

// ── Editor ──────────────────────────────────────────────────────────────

interface Field {
	label: string;
	value: string;
	tag: "CLI" | "RUN";
	enter(): void;
	space?(): void;
}

interface Group {
	name: string;
	summary(): string;
	fields(): Field[];
}

type Focus = "header" | "groups" | "fields";

const THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const splitList = (s: string): string[] =>
	s
		.split(",")
		.map((x) => x.trim())
		.filter((x) => x !== "");
const count = (n: number, word: string): string => `${n} ${word}`;

function sourceTag(r: ResourceItem): string {
	return r.source.replace("-", " ");
}

/** Shell-style quoting for the preview only. */
function quote(a: string): string {
	return /^[\w@%+=:,./~*-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

export class ProfileEditorPage implements Page {
	readonly title = "PROFILE";
	private p: Profile;
	private readonly origin: string;
	private focus: Focus = "groups";
	private readonly groupList = new ListView({ itemHeight: 2 });
	private readonly fieldList = new ListView();
	private models: ModelEntry[] | null = null;
	private readonly groups: Group[];
	private readonly app: App;
	private readonly target: LaunchTarget;
	private readonly rec: SessionRecord | null;

	constructor(app: App, target: LaunchTarget, rec: SessionRecord | null) {
		this.app = app;
		this.target = target;
		this.rec = rec;
		const r = resolveProfile(app.config, target, rec);
		this.p = r.profile ? structuredClone(r.profile) : emptyProfile();
		this.origin = { session: "session", project: "project default", global: "global default", none: "none" }[r.origin];
		this.groups = this.buildGroups();
	}

	enter(): void {
		void loadModels().then((m) => {
			this.models = m;
			this.app.requestRender();
		});
	}

	hints(): string {
		return "↑↓ move  ←→ column  space toggle  enter edit  ctrl+s launch  d project default  g global default  p save preset  l load preset  x reset  esc back";
	}

	captureText(): boolean {
		return false;
	}

	private get res() {
		return resourcesFor(this.target.cwd);
	}

	// ── groups and fields ───────────────────────────────────────────────

	private menu(title: string, options: [string, string][], current: string, set: (v: string) => void): void {
		const items = options.map(([label, value]) => ({ label, run: () => set(value) }));
		this.app.modal(new MenuModal(title, items, Math.max(0, options.findIndex(([, v]) => v === current))));
	}

	private text(title: string, initial: string, set: (v: string) => void): void {
		this.app.modal(new PromptModal(title, initial, set, 90));
	}

	private checklist(title: string, items: ChecklistItem[], selected: string[], set: (ids: string[]) => void): void {
		const known = new Set(items.map((i) => i.id));
		const extra = selected.filter((id) => !known.has(id)).map((id) => ({ id, label: id, hint: "not found" }));
		this.app.modal(new ChecklistModal(title, [...items, ...extra], selected, false, set));
	}

	private toggleField(label: string, get: () => boolean, set: (v: boolean) => void, on = "ON", off = "OFF"): Field {
		return { label, value: get() ? on : off, tag: "CLI", enter: () => set(!get()), space: () => set(!get()) };
	}

	private modeField<T extends string>(label: string, get: () => T, set: (v: T) => void, options: [string, T][]): Field {
		return {
			label,
			value: get(),
			tag: "CLI",
			enter: () => this.menu(label.toUpperCase(), options, get(), (v) => set(v as T)),
		};
	}

	private listField(label: string, tag: "CLI" | "RUN", values: string[], edit: () => void): Field {
		return { label, value: values.length === 0 ? "(none)" : count(values.length, "selected"), tag, enter: edit };
	}

	private pathListField(label: string, tag: "CLI" | "RUN", get: () => string[], set: (v: string[]) => void): Field {
		return {
			label,
			value: get().length === 0 ? "(none)" : get().join(", "),
			tag,
			enter: () => this.text(`${label.toUpperCase()} (comma separated)`, get().join(", "), (v) => set(splitList(v))),
		};
	}

	private resourceChecklist(title: string, items: ResourceItem[], get: () => string[], set: (v: string[]) => void): void {
		this.checklist(
			title,
			items.map((r) => ({ id: r.arg, label: r.name, hint: sourceTag(r) })),
			get(),
			set,
		);
	}

	private buildGroups(): Group[] {
		const p = () => this.p;
		const mode = (m: string, n: number, word: string) => (m === "default" ? "default" : m === "none" ? `no ${word}` : `only ${n}`);
		return [
			{
				name: "SESSION",
				summary: () => p().sessionName ?? "unnamed",
				fields: () => [
					{
						label: "name",
						value: this.target.kind === "new" ? (p().sessionName ?? "(none)") : "(new sessions only)",
						tag: "CLI",
						enter: () => {
							if (this.target.kind !== "new") return this.app.toast("the session name applies to new sessions only");
							this.text("SESSION NAME", p().sessionName ?? "", (v) => (p().sessionName = v.trim() || null));
						},
					},
				],
			},
			{
				name: "MODEL",
				summary: () => `${p().model ?? "default"}${p().thinking ? ` · ${p().thinking}` : ""}`,
				fields: () => {
					const newOnly = this.target.kind === "new";
					const chooseModel = () => {
						if (!newOnly) return this.app.toast("the model applies to new sessions only");
						if (!this.models) return this.app.toast("loading the model list, try again in a moment");
						const items = [
							{ id: "", label: "(pi default)" },
							...this.models.map((m) => ({ id: `${m.provider}/${m.id}`, label: `${m.provider}/${m.id}`, hint: m.contextWindow })),
						];
						this.app.modal(new ChecklistModal("MODEL", items, [p().model ?? ""], true, ([id]) => (p().model = id || null)));
					};
					return [
						{ label: "model", value: newOnly ? (p().model ?? "(pi default)") : "(new sessions only)", tag: "CLI", enter: chooseModel },
						{
							label: "thinking",
							value: newOnly ? (p().thinking ?? "(pi default)") : "(new sessions only)",
							tag: "CLI",
							enter: () => {
								if (!newOnly) return this.app.toast("thinking applies to new sessions only");
								this.menu("THINKING", [["(pi default)", ""], ...THINKING.map((t): [string, string] => [t, t])], p().thinking ?? "", (v) => (p().thinking = (v || null) as ThinkingLevel | null));
							},
						},
						this.listField("models scope", "CLI", p().modelsScope, () => {
							const items = (this.models ?? []).map((m) => ({ id: `${m.provider}/${m.id}`, label: `${m.provider}/${m.id}`, hint: m.contextWindow }));
							this.checklist("MODELS SCOPE (cycling)", items, p().modelsScope, (ids) => (p().modelsScope = ids));
						}),
					];
				},
			},
			{
				name: "EXTENSIONS",
				summary: () => {
					const e = p().extensions;
					const base = e.mode === "default" ? "default" : e.mode === "only" ? `only ${e.only.length}` : `${e.exclude.length} excluded`;
					return p().mcp ? base : `${base} · no MCP`;
				},
				fields: () => {
					const e = p().extensions;
					const fs: Field[] = [
						this.modeField("mode", () => e.mode, (v) => (e.mode = v), [
							["default (everything pi would load)", "default"],
							["exclude (load all except the chosen)", "exclude"],
							["only (load just the chosen)", "only"],
						]),
					];
					if (e.mode === "exclude") {
						fs.push(this.listField("excluded", "CLI", e.exclude, () => this.resourceChecklist("EXCLUDE EXTENSIONS", this.res.extensions.filter((r) => r.enabledByDefault), () => e.exclude, (v) => (e.exclude = v))));
					}
					if (e.mode === "only") {
						fs.push(this.listField("loaded", "CLI", e.only, () => this.resourceChecklist("LOAD ONLY THESE EXTENSIONS", this.res.extensions, () => e.only, (v) => (e.only = v))));
					}
					fs.push(this.toggleField("MCP", () => p().mcp, (v) => (p().mcp = v)));
					return fs;
				},
			},
			{
				name: "SKILLS",
				summary: () => `${mode(p().skills.mode, p().skills.only.length, "skills")}${p().skills.hideInPrompt.length ? ` · ${p().skills.hideInPrompt.length} hidden` : ""}`,
				fields: () => {
					const s = p().skills;
					const fs: Field[] = [
						this.modeField("mode", () => s.mode, (v) => (s.mode = v), [
							["default", "default"],
							["only the chosen", "only"],
							["none", "none"],
						]),
					];
					if (s.mode === "only") fs.push(this.listField("loaded", "CLI", s.only, () => this.resourceChecklist("LOAD ONLY THESE SKILLS", this.res.skills, () => s.only, (v) => (s.only = v))));
					fs.push(
						this.listField("hide in prompt", "RUN", s.hideInPrompt, () =>
							this.checklist("HIDE SKILLS IN THE SYSTEM PROMPT", this.res.skills.map((r) => ({ id: r.name, label: r.name, hint: sourceTag(r) })), s.hideInPrompt, (v) => (s.hideInPrompt = v)),
						),
					);
					return fs;
				},
			},
			{
				name: "PROMPTS",
				summary: () => mode(p().promptTemplates.mode, p().promptTemplates.only.length, "prompt templates"),
				fields: () => {
					const t = p().promptTemplates;
					const fs: Field[] = [
						this.modeField("mode", () => t.mode, (v) => (t.mode = v), [
							["default", "default"],
							["only the chosen", "only"],
							["none", "none"],
						]),
					];
					if (t.mode === "only") fs.push(this.listField("loaded", "CLI", t.only, () => this.resourceChecklist("LOAD ONLY THESE PROMPT TEMPLATES", this.res.prompts, () => t.only, (v) => (t.only = v))));
					return fs;
				},
			},
			{
				name: "CONTEXT FILES",
				summary: () => {
					const c = p().contextFiles;
					const extra = c.extra.length ? ` + ${c.extra.length} extra` : "";
					return c.mode === "none" ? "none" : c.mode === "pick" ? `pick ${c.include.length}${extra}` : `default${extra}`;
				},
				fields: () => {
					const c = p().contextFiles;
					const fs: Field[] = [
						this.modeField("mode", () => c.mode, (v) => {
							c.mode = v;
							// Picking starts from "everything discovered" so the user removes what they do not want.
							if (v === "pick" && c.include.length === 0) c.include = this.res.contextFiles.map((f) => f.path);
						}, [
							["default (pi discovery)", "default"],
							["none (-nc)", "none"],
							["pick (keep only chosen)", "pick"],
						]),
					];
					if (c.mode === "pick") {
						fs.push(this.listField("keep", "RUN", c.include, () => this.checklist("KEEP THESE CONTEXT FILES", this.res.contextFiles.map((f) => ({ id: f.path, label: tildify(f.path), hint: f.scope })), c.include, (v) => (c.include = v))));
					}
					if (c.mode !== "none") fs.push(this.pathListField("extra files", "RUN", () => c.extra, (v) => (c.extra = v)));
					return fs;
				},
			},
			{
				name: "SYSTEM PROMPT",
				summary: () => `${p().systemPrompt.replace ? "replaced" : "default"}${p().systemPrompt.append.length ? ` + ${p().systemPrompt.append.length} appended` : ""}`,
				fields: () => [
					{
						label: "replace with file",
						value: p().systemPrompt.replace ?? "(default)",
						tag: "CLI",
						enter: () => this.text("SYSTEM PROMPT FILE (empty = default)", p().systemPrompt.replace ?? "", (v) => (p().systemPrompt.replace = v.trim() || null)),
					},
					this.pathListField("append files", "CLI", () => p().systemPrompt.append, (v) => (p().systemPrompt.append = v)),
				],
			},
			{
				name: "TOOLS",
				summary: () => {
					const t = p().tools;
					if (t.none) return "no tools";
					const bits = [t.noBuiltin ? "no built-in" : "", t.allow ? `only ${t.allow.length}` : "", t.add.length + t.remove.length ? `+${t.add.length} -${t.remove.length}` : "", t.exclude.length ? `${t.exclude.length} excluded` : ""].filter(Boolean);
					return bits.join(", ") || "default";
				},
				fields: () => {
					const t = p().tools;
					const fs: Field[] = [this.toggleField("no tools at all", () => t.none, (v) => (t.none = v), "YES", "NO")];
					if (t.none) return fs;
					fs.push(
						this.toggleField("no built-in tools", () => t.noBuiltin, (v) => (t.noBuiltin = v), "YES", "NO"),
						{
							label: "allow only",
							value: t.allow ? t.allow.join(", ") || "(empty list)" : "(default set)",
							tag: "CLI",
							enter: () => this.text("ALLOWED TOOLS (comma separated, empty = default set)", t.allow?.join(", ") ?? "", (v) => (t.allow = v.trim() ? splitList(v) : null)),
						},
					);
					if (!t.allow) {
						fs.push(
							this.pathListField("add to default", "CLI", () => t.add, (v) => (t.add = v)),
							this.pathListField("remove from default", "CLI", () => t.remove, (v) => (t.remove = v)),
						);
					}
					fs.push(this.pathListField("exclude (patterns)", "CLI", () => t.exclude, (v) => (t.exclude = v)));
					return fs;
				},
			},
			{
				name: "OTHER",
				summary: () => [p().trust !== "ask" ? `trust ${p().trust}` : "", p().offline ? "offline" : ""].filter(Boolean).join(", ") || "default",
				fields: () => [
					this.modeField("project trust", () => p().trust, (v) => (p().trust = v), [
						["ask (pi decides)", "ask"],
						["trust project (-a)", "trust"],
						["deny project (-na)", "deny"],
					]),
					this.toggleField("offline", () => p().offline, (v) => (p().offline = v)),
				],
			},
			{
				name: "FLAGS",
				summary: () => {
					const n = Object.keys(p().extensionFlags).length;
					return n ? count(n, n === 1 ? "flag" : "flags") : "none";
				},
				fields: () => {
					const flags = p().extensionFlags;
					const fs: Field[] = Object.entries(flags).map(([name, v]) => ({
						label: `--${name}`,
						value: typeof v === "string" ? v : v ? "ON" : "OFF",
						tag: "CLI" as const,
						enter: () =>
							this.text(`--${name} (true / false / text; empty removes)`, String(v), (s) => {
								const t = s.trim();
								if (t === "") delete flags[name];
								else flags[name] = t === "true" ? true : t === "false" ? false : t;
							}),
						space: () => {
							if (typeof v === "boolean") flags[name] = !v;
						},
					}));
					fs.push({
						label: "+ add flag",
						value: "name or name=value",
						tag: "CLI",
						enter: () =>
							this.text("ADD EXTENSION FLAG (name or name=value)", "", (s) => {
								const m = s.trim().replace(/^--/, "").match(/^([^=\s]+)(?:=(.*))?$/);
								if (!m) return;
								flags[m[1]!] = m[2] === undefined ? true : m[2] === "true" ? true : m[2] === "false" ? false : m[2];
							}),
					});
					return fs;
				},
			},
		];
	}

	// ── actions ─────────────────────────────────────────────────────────

	private launch(): void {
		const args = composeArgs(this.target, this.p, argsEnv(this.target.cwd), () => writeProfileFile(this.p));
		this.app.launch({ cwd: this.target.cwd, args });
	}

	private saved(): Profile | null {
		return isEmptyProfile(this.p) ? null : structuredClone(this.p);
	}

	private saveDefault(scope: "project" | "global"): void {
		const prof = this.saved();
		const cfg = this.app.config;
		if (scope === "project") {
			if (prof) cfg.projectDefaults[this.target.cwd] = prof;
			else delete cfg.projectDefaults[this.target.cwd];
		} else cfg.globalDefault = prof;
		this.app.saveConfig();
		this.app.toast(prof ? `saved as ${scope} default` : `${scope} default cleared`);
	}

	private savePreset(): void {
		this.app.modal(
			new PromptModal("SAVE PRESET AS", "", (name) => {
				const n = name.trim();
				if (!n) return;
				const exists = n in this.app.config.presets;
				this.app.config.presets[n] = structuredClone(this.p);
				this.app.saveConfig();
				this.app.toast(`preset "${n}" ${exists ? "overwritten" : "saved"}`);
			}),
		);
	}

	private loadPreset(): void {
		const names = Object.keys(this.app.config.presets);
		if (names.length === 0) return this.app.toast("no presets saved yet");
		this.app.modal(
			new MenuModal(
				"LOAD PRESET",
				names.map((n) => ({
					label: n,
					run: () => {
						const loaded = normalizeProfile(this.app.config.presets[n]);
						if (loaded) {
							this.p = loaded;
							this.app.toast(`loaded preset "${n}"`);
						} else this.app.toast(`preset "${n}" is not valid`, "error");
					},
				})),
			),
		);
	}

	// ── input ───────────────────────────────────────────────────────────

	private currentFields(): Field[] {
		return this.groups[this.groupList.selected]?.fields() ?? [];
	}

	key(data: string): boolean {
		if (matchesKey(data, "ctrl+s")) return this.launch(), true;
		if (this.focus === "header") {
			if (matchesKey(data, "enter")) return this.launch(), true;
			if (matchesKey(data, "down")) return (this.focus = "groups"), true;
		} else if (this.focus === "groups") {
			if (matchesKey(data, "up") && this.groupList.selected === 0) return (this.focus = "header"), true;
			if (matchesKey(data, "right") || matchesKey(data, "enter")) {
				this.fieldList.selected = 0;
				this.fieldList.scroll = 0;
				this.focus = "fields";
				return true;
			}
			if (this.groupList.key(data, this.groups.length)) {
				this.fieldList.selected = 0;
				this.fieldList.scroll = 0;
				return true;
			}
		} else {
			const fields = this.currentFields();
			if (matchesKey(data, "left")) return (this.focus = "groups"), true;
			if (matchesKey(data, "enter")) return fields[this.fieldList.selected]?.enter(), true;
			if (data === " ") {
				const f = fields[this.fieldList.selected];
				return f?.space ? (f.space(), true) : true;
			}
			if (["up", "down", "pageUp", "pageDown", "home", "end"].some((k) => matchesKey(data, k as "up"))) {
				return this.fieldList.key(data, fields.length), true;
			}
		}
		if (data === "d") return this.saveDefault("project"), true;
		if (data === "g") return this.saveDefault("global"), true;
		if (data === "p") return this.savePreset(), true;
		if (data === "l") return this.loadPreset(), true;
		if (data === "x") {
			this.p = emptyProfile();
			this.app.toast("profile reset to empty");
			return true;
		}
		return false;
	}

	// ── drawing ─────────────────────────────────────────────────────────

	private targetLine(): string {
		const t = this.target;
		const title = this.rec ? sessionTitle(this.rec) : "";
		if (t.kind === "new") return `NEW SESSION in ${tildify(t.cwd)}`;
		if (t.kind === "continue") return `CONTINUE LAST SESSION in ${tildify(t.cwd)}`;
		return `${t.kind === "resume" ? "RESUME" : "FORK"} ${title}`;
	}

	private preview(): string {
		const env = argsEnv(this.target.cwd);
		const args = composeArgs(this.target, this.p, env, () => "<file>");
		return `pi ${args.map(quote).join(" ")}`;
	}

	draw(s: Surface, app: App): void {
		const pal = app.pal;
		const head = s.sub(0, 0, s.w, 1);
		if (this.focus === "header") selectRow(head, pal);
		const hs = this.focus === "header" ? pal.sel : pal.strong;
		head.text(1, 0, truncate(this.targetLine(), s.w - 30), hs);
		head.textIn(0, 0, s.w - 1, `profile: ${this.origin}${this.focus === "header" ? "   enter = launch" : ""}`, this.focus === "header" ? pal.sel : pal.dim, "right");
		head.hit(0, 0, s.w, 1, { onClick: () => (this.focus = "header") });
		s.hline(0, 1, s.w, pal.faint, pal.caps.unicode ? "─" : "-");

		const previewH = 4;
		const bodyY = 2;
		const bodyH = Math.max(1, s.h - bodyY - previewH - 1);
		const leftW = Math.floor(s.w * 0.4);
		const left = s.sub(0, bodyY, leftW, bodyH);
		const right = s.sub(leftW + 1, bodyY, s.w - leftW - 1, bodyH);
		s.vline(leftW, bodyY, bodyH, pal.faint, pal.caps.unicode ? "│" : "|");

		// Left: groups with a one-line summary each.
		this.groupList.onActivate = () => {
			this.focus = "fields";
		};
		this.groupList.draw(left.inset(1, 0, 0, 0), this.groups.length, (i, row, sel) => {
			const g = this.groups[i]!;
			const active = sel && this.focus === "groups";
			if (active) selectRow(row, pal);
			row.text(0, 0, `${sel ? ">" : " "} ${g.name}`, active ? pal.sel : sel ? pal.strong : pal.text);
			row.text(2, 1, truncate(g.summary(), row.w - 3), active ? pal.sel : pal.dim);
		});

		// Right: fields of the selected group.
		const group = this.groups[this.groupList.selected];
		const fields = this.currentFields();
		const inner = right.inset(1, 0, 0, 0);
		const y0 = section(inner, 0, 0, inner.w, group?.name ?? "", pal);
		const labelW = Math.max(0, ...fields.map((f) => strWidth(f.label)));
		this.fieldList.draw(inner.sub(0, y0, inner.w, inner.h - y0), fields.length, (i, row, sel) => {
			const f = fields[i]!;
			const active = sel && this.focus === "fields";
			if (active) selectRow(row, pal);
			row.text(0, 0, `${sel ? ">" : " "} ${f.label}`, active ? pal.sel : pal.text);
			const vx = 3 + labelW;
			row.text(vx, 0, truncate(f.value, Math.max(4, row.w - vx - 7)), active ? pal.sel : pal.strong);
			row.textIn(0, 0, row.w - 1, `[${f.tag}]`, active ? pal.sel : pal.faint, "right");
		});

		// Bottom: live command preview.
		const py = s.h - previewH;
		s.hline(0, py - 1, s.w, pal.faint, pal.caps.unicode ? "─" : "-");
		s.text(1, py, "[ COMMAND_PREVIEW ]", pal.title);
		const text = this.preview();
		const w = s.w - 2;
		const lines = wrap(text, w, previewH - 1);
		lines.forEach((l, i) => s.text(1, py + 1 + i, l, pal.text));
	}
}

/** Hard-wrap `text` to `w` columns, at most `max` lines; the last line is truncated with an ellipsis. */
function wrap(text: string, w: number, max: number): string[] {
	const out: string[] = [];
	let rest = text;
	while (rest.length > 0 && out.length < max) {
		if (out.length === max - 1 && rest.length > w) {
			out.push(truncate(rest, w));
			break;
		}
		out.push(rest.slice(0, w));
		rest = rest.slice(w);
	}
	return out;
}
