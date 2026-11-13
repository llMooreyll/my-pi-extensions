import type { Profile } from "../../shared/profile.ts";
import type { ResourceItem } from "../resources/types.ts";

/** What to open in pi. */
export interface LaunchTarget {
	kind: "new" | "resume" | "continue" | "fork";
	cwd: string;
	/** Session file for resume / fork. */
	sessionFile?: string;
}

/** Session-selection arguments for a target (PLAN.md §2 "会话" rows). */
export function targetArgs(t: LaunchTarget): string[] {
	switch (t.kind) {
		case "new":
			return [];
		case "continue":
			return ["-c"];
		case "resume":
			return ["--session", t.sessionFile!];
		case "fork":
			return ["--fork", t.sessionFile!];
	}
}

/** Inputs from outside the profile that the argument mapping needs. */
export interface ProfileArgsEnv {
	/** Extensions pi loads without flags (needed to express "exclude" as -ne + -e list). */
	defaultExtensions: ResourceItem[];
	/** Absolute path of extension/index.ts, always re-added after -ne. */
	companionEntry: string;
}

/** Profile → pi CLI arguments (docs/tasks/B-profile.md B3 table, in table order). Pure. */
export function profileArgs(p: Profile, target: LaunchTarget, env: ProfileArgsEnv): string[] {
	const a: string[] = [];
	const isNew = target.kind === "new";
	if (isNew && p.model) a.push("--model", p.model);
	if (isNew && p.thinking) a.push("--thinking", p.thinking);
	if (p.modelsScope.length > 0) a.push("--models", p.modelsScope.join(","));
	if (p.extensions.mode === "exclude") {
		a.push("-ne");
		for (const e of env.defaultExtensions) if (!p.extensions.exclude.includes(e.arg)) a.push("-e", e.arg);
		a.push("-e", env.companionEntry);
	} else if (p.extensions.mode === "only") {
		a.push("-ne");
		for (const e of p.extensions.only) a.push("-e", e);
		a.push("-e", env.companionEntry);
	}
	if (!p.mcp) a.push("--no-mcp");
	if (p.skills.mode === "none") a.push("-ns");
	else if (p.skills.mode === "only") {
		a.push("-ns");
		for (const s of p.skills.only) a.push("--skill", s);
	}
	if (p.promptTemplates.mode === "none") a.push("-np");
	else if (p.promptTemplates.mode === "only") {
		a.push("-np");
		for (const t of p.promptTemplates.only) a.push("--prompt-template", t);
	}
	if (p.contextFiles.mode === "none") a.push("-nc");
	if (p.systemPrompt.replace) a.push("--system-prompt", p.systemPrompt.replace);
	for (const f of p.systemPrompt.append) a.push("--append-system-prompt", f);
	if (p.tools.none) a.push("-nt");
	else {
		if (p.tools.noBuiltin) a.push("-nbt");
		if (p.tools.allow) a.push("--tools", p.tools.allow.join(","));
		else if (p.tools.add.length + p.tools.remove.length > 0) {
			a.push("--tools", [...p.tools.add.map((t) => `+${t}`), ...p.tools.remove.map((t) => `-${t}`)].join(","));
		}
		if (p.tools.exclude.length > 0) a.push("-xt", p.tools.exclude.join(","));
	}
	if (p.trust === "trust") a.push("-a");
	else if (p.trust === "deny") a.push("-na");
	if (p.offline) a.push("--offline");
	for (const [name, v] of Object.entries(p.extensionFlags)) {
		if (v === true) a.push(`--${name}`);
		else if (typeof v === "string") a.push(`--${name}`, v);
	}
	if (isNew && p.sessionName) a.push("-n", p.sessionName);
	return a;
}

/** Full argument list: target selection first, then profile flags. */
export function launchArgs(target: LaunchTarget, profile: Profile | null, env: ProfileArgsEnv): string[] {
	return [...targetArgs(target), ...(profile ? profileArgs(profile, target, env) : [])];
}
