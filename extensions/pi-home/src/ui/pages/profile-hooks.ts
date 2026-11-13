import { realpathSync } from "node:fs";
import { join } from "node:path";
import { isEmptyProfile } from "../../../shared/profile.ts";
import type { Profile } from "../../../shared/profile.ts";
import { type LaunchTarget, launchArgs, type ProfileArgsEnv } from "../../launch/args.ts";
import { cleanupProfileFiles, writeProfileFile } from "../../launch/profile-file.ts";
import { resolveProfile } from "../../launch/resolve.ts";
import { packageRoot } from "../../paths.ts";
import { listContextFiles, type ContextFile } from "../../resources/context-files.ts";
import { listExtensions } from "../../resources/extensions.ts";
import { listPrompts } from "../../resources/prompts.ts";
import { listSkills } from "../../resources/skills.ts";
import { isProjectTrusted } from "../../resources/trust.ts";
import type { ResourceItem } from "../../resources/types.ts";
import type { SessionRecord } from "../../index/types.ts";
import type { App } from "../app.ts";
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
export function composeArgs(target: LaunchTarget, profile: Profile | null, env: ProfileArgsEnv, profileFile: () => string): string[] {
	const active = profile && !isEmptyProfile(profile) ? profile : null;
	const args = launchArgs(target, active, env);
	return active ? companionArgs(args, env, profileFile()) : args;
}

export function installProfileHooks(_app: App): void {
	cleanupProfileFiles();
	homeHooks.buildArgs = (a, target, rec) => {
		const { profile } = resolveProfile(a.config, target, rec);
		return composeArgs(target, profile, argsEnv(target.cwd), () => writeProfileFile(profile!));
	};
	homeHooks.editProfile = (a, target, rec: SessionRecord | null) => a.push(new ProfileEditorPage(a, target, rec));
}
