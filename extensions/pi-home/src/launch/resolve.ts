import { isEmptyProfile, normalizeProfile } from "../../shared/profile.ts";
import type { Profile } from "../../shared/profile.ts";
import type { HomeConfig } from "../config.ts";
import type { SessionRecord } from "../index/types.ts";
import type { LaunchTarget } from "./args.ts";

export interface ResolvedProfile {
	profile: Profile | null;
	origin: "session" | "project" | "global" | "none";
}

/** Precedence: stored session profile (resume/fork only) → project default → global default. Empty profiles count as none. */
export function resolveProfile(config: HomeConfig, target: LaunchTarget, rec: SessionRecord | null): ResolvedProfile {
	const candidates: [ResolvedProfile["origin"], Profile | null][] = [
		["session", target.kind === "resume" || target.kind === "fork" ? normalizeProfile(rec?.profile) : null],
		["project", normalizeProfile(config.projectDefaults[target.cwd])],
		["global", normalizeProfile(config.globalDefault)],
	];
	for (const [origin, profile] of candidates) if (profile && !isEmptyProfile(profile)) return { profile, origin };
	return { profile: null, origin: "none" };
}
