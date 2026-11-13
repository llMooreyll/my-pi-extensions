import { realpathSync } from "node:fs";
import { join } from "node:path";
import { isEmptyProfile } from "../../../shared/profile.ts";
import type { Profile } from "../../../shared/profile.ts";
import { matchesKey } from "@earendil-works/pi-tui";
import type { Surface } from "../../term/canvas.ts";
import { truncate } from "../../term/width.ts";
import { ListView, selectRow } from "../widgets.ts";
import { type LaunchTarget, launchArgs, type ProfileArgsEnv } from "../../launch/args.ts";
import { cleanupProfileFiles, writeProfileFile } from "../../launch/profile-file.ts";
import { resolveProfile } from "../../launch/resolve.ts";
import { packageRoot, tildify } from "../../paths.ts";
import { listContextFiles, type ContextFile } from "../../resources/context-files.ts";
import { listExtensions } from "../../resources/extensions.ts";
import { listPrompts } from "../../resources/prompts.ts";
import { listSkills } from "../../resources/skills.ts";
import { isProjectTrusted } from "../../resources/trust.ts";
import type { ResourceItem } from "../../resources/types.ts";
import type { SessionRecord } from "../../index/types.ts";
import type { App, Modal } from "../app.ts";
import { homeHooks } from "./home.ts";
import { ProfileEditorPage } from "./profile-editor.ts";

export interface CwdResources {
	extensions: ResourceItem[];
	skills: ResourceItem[];
	prompts: ResourceItem[];
	contextFiles: ContextFile[];
	trusted: boolean;
}

const cache = new Map<string, CwdResources>();

/** Resource lists for a project, discovered once per cwd for the lifetime of the app. */
export function resourcesFor(cwd: string): CwdResources {
	let r = cache.get(cwd);
	if (!r) {
		const trusted = isProjectTrusted(cwd);
		r = {
			extensions: listExtensions(cwd, trusted),
			skills: listSkills(cwd, trusted),
			prompts: listPrompts(cwd, trusted),
			contextFiles: listContextFiles(cwd),
			trusted,
		};
		cache.set(cwd, r);
	}
	return r;
}

export const companionEntry = (): string => join(packageRoot(), "extension", "index.ts");

export function argsEnv(cwd: string): ProfileArgsEnv {
	return {
		defaultExtensions: resourcesFor(cwd).extensions.filter((e) => e.enabledByDefault),
		companionEntry: companionEntry(),
	};
}

function real(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/**
 * Add what is needed so pi accepts `--home-profile` (an unregistered flag is a startup error, see
 * agent-session-services.js applyExtensionFlagValues): nothing when the companion is already in the
 * args (-e) or loaded by default (a default extension equal to the package root or the entry file);
 * otherwise `-e <companionEntry>`. Then `--home-profile <file>`.
 */
export function companionArgs(args: string[], env: ProfileArgsEnv, profileFile: string): string[] {
	const entry = real(env.companionEntry);
	const root = real(packageRoot());
	const explicit = args.some((a, i) => a === "-e" && args[i + 1] !== undefined && real(args[i + 1]!) === entry);
	const byDefault = env.defaultExtensions.some((e) => {
		const p = real(e.arg);
		return p === root || p === entry;
	});
	return [...args, ...(explicit || byDefault ? [] : ["-e", env.companionEntry]), "--home-profile", profileFile];
}

/** Full pi arguments for a target and profile; `profileFile` yields the path passed to --home-profile. */
export function composeArgs(target: LaunchTarget, profile: Profile | null, env: ProfileArgsEnv, profileFile: () => string, keepEmpty = false): string[] {
	// keepEmpty: an empty profile is still passed so the companion stores it over an older stored profile.
	const active = profile && (keepEmpty || !isEmptyProfile(profile)) ? profile : null;
	const args = launchArgs(target, active, env);
	return active ? companionArgs(args, env, profileFile()) : args;
}

/** Shell-style quoting, for display only; the profile file placeholder stays literal. */
function quote(a: string): string {
	return a === "<file>" || /^[\w@%+=:,./~*-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

/** Short display name of an extension path: package directory for `<pkg>/extension/index.ts`, else the last segment. */
function extName(p: string): string {
	if (!p.includes("/")) return p;
	const parts = p.split("/").filter(Boolean);
	if (/^index\.[cm]?[jt]s$/.test(parts[parts.length - 1] ?? "")) parts.pop();
	if (parts[parts.length - 1] === "extension") parts.pop();
	return parts[parts.length - 1] ?? p;
}

/** Display form of the arguments: home prefix as `~`, runs of 3+ `-e <path>` pairs collapsed into one token. */
function compactArgs(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; ) {
		let n = 0;
		while (args[i + 2 * n] === "-e" && args[i + 2 * n + 1] !== undefined) n++;
		if (n >= 3) {
			const names = Array.from({ length: n }, (_, k) => extName(args[i + 2 * k + 1]!)).join(", ");
			out.push(`-e ×${n}[${names.length > 60 ? `${names.slice(0, 59)}…` : names}]`);
			i += 2 * n;
		} else {
			out.push(quote(tildify(args[i]!)));
			i++;
		}
	}
	return out;
}

const RESERVED_NAMES = ["__proto__", "constructor", "prototype"];

/** Why `name` cannot be a preset name (reserved or already used), or null when it is free. */
export function presetNameError(name: string, presets: Record<string, unknown>): string | null {
	if (RESERVED_NAMES.includes(name)) return `"${name}" is a reserved name`;
	if (Object.hasOwn(presets, name)) return `preset "${name}" already exists`;
	return null;
}

/** Real arguments of the preview command (no tilde, no collapsing). */
export function previewArgs(target: LaunchTarget, profile: Profile | null, env: ProfileArgsEnv, keepEmpty = false): string[] {
	return composeArgs(target, profile, env, () => "<file>", keepEmpty);
}

/** `pi <args>` as shown in the command preview: same builder as a real launch, without writing a profile file. */
export function previewCommand(target: LaunchTarget, profile: Profile | null, env: ProfileArgsEnv, keepEmpty = false): string {
	return `pi ${compactArgs(previewArgs(target, profile, env, keepEmpty)).join(" ")}`;
}

/** Scrollable list of the real arguments, one per line. */
export class FullCommandModal implements Modal {
	readonly width = 110;
	readonly height: number;
	private readonly list = new ListView();
	private readonly args: string[];

	constructor(args: string[]) {
		this.args = ["pi", ...args];
		this.height = Math.min(26, this.args.length + 5);
	}

	draw(s: Surface, app: App): void {
		const pal = app.pal;
		s.text(1, 0, "[ FULL_COMMAND ]", pal.title);
		s.textIn(0, 0, s.w - 1, "esc close", pal.dim, "right");
		this.list.draw(s.sub(0, 2, s.w, s.h - 2), this.args.length, (i, row, sel) => {
			if (sel) selectRow(row, pal);
			row.text(1, 0, truncate(this.args[i]!, row.w - 2), sel ? pal.sel : pal.text);
		});
	}

	key(data: string, app: App): void {
		if (matchesKey(data, "escape")) app.closeModal();
		else this.list.key(data, this.args.length);
	}
}

export function installProfileHooks(_app: App): void {
	cleanupProfileFiles();
	homeHooks.buildArgs = (a, target, rec) => {
		const { profile } = resolveProfile(a.config, target, rec);
		return composeArgs(target, profile, argsEnv(target.cwd), () => writeProfileFile(profile!));
	};
	homeHooks.editProfile = (a, target, rec: SessionRecord | null) => a.push(new ProfileEditorPage(a, target, rec));
}
