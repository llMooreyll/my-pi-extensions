import type { Profile } from "../../shared/profile.ts";

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

/**
 * Profile → pi CLI arguments. STUB: implemented by task B (docs/tasks/B-profile.md, step B3).
 * Must stay a pure function of its inputs.
 */
export function profileArgs(_profile: Profile, _target: LaunchTarget): string[] {
	return [];
}

/** Full argument list: target selection first, then profile flags. */
export function launchArgs(target: LaunchTarget, profile: Profile | null): string[] {
	return [...targetArgs(target), ...(profile ? profileArgs(profile, target) : [])];
}
