/**
 * Per-session profile (PLAN.md §2, §6). Shared by the launcher (src/) and the companion extension
 * (extension/). Must stay free of imports from either side.
 */

export const PROFILE_VERSION = 1;
export const PROFILE_ENTRY_TYPE = "pi-home/profile";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface Profile {
	version: 1;
	/** "provider/id"; null = pi default. */
	model: string | null;
	thinking: ThinkingLevel | null;
	/** --models scope patterns; empty = pi default. */
	modelsScope: string[];
	extensions: {
		mode: "default" | "exclude" | "only";
		/** Extension entry paths or "builtin:<name>" ids excluded in mode "exclude". */
		exclude: string[];
		/** Entries loaded in mode "only". */
		only: string[];
	};
	mcp: boolean;
	skills: {
		mode: "default" | "only" | "none";
		/** SKILL.md paths (or skill dirs) loaded in mode "only". */
		only: string[];
		/** Skill names removed from the system prompt at runtime (extension layer). */
		hideInPrompt: string[];
	};
	promptTemplates: {
		mode: "default" | "only" | "none";
		only: string[];
	};
	contextFiles: {
		/** default = pi's own discovery; none = -nc; pick = keep only `include` (+ extra). */
		mode: "default" | "none" | "pick";
		/** Absolute paths of discovered AGENTS.md/CLAUDE.md files to keep in mode "pick". */
		include: string[];
		/** Extra files appended as context (absolute paths), any mode except "none". */
		extra: string[];
	};
	systemPrompt: {
		/** File replacing the default system prompt; null = keep. */
		replace: string | null;
		/** Files appended to the system prompt. */
		append: string[];
	};
	tools: {
		/** Explicit allow-list (--tools a,b); null = default set. */
		allow: string[] | null;
		add: string[];
		remove: string[];
		/** --exclude-tools. */
		exclude: string[];
		/** -nbt */
		noBuiltin: boolean;
		/** -nt */
		none: boolean;
	};
	/** ask = pi decides/prompts; trust = -a; deny = -na. */
	trust: "ask" | "trust" | "deny";
	offline: boolean;
	/** Extension-defined flags, e.g. { "plan": true, "foo": "bar" } → --plan --foo bar. */
	extensionFlags: Record<string, boolean | string>;
	/** Session name (-n) for new sessions; null = none. */
	sessionName: string | null;
}

export function emptyProfile(): Profile {
	return {
		version: 1,
		model: null,
		thinking: null,
		modelsScope: [],
		extensions: { mode: "default", exclude: [], only: [] },
		mcp: true,
		skills: { mode: "default", only: [], hideInPrompt: [] },
		promptTemplates: { mode: "default", only: [] },
		contextFiles: { mode: "default", include: [], extra: [] },
		systemPrompt: { replace: null, append: [] },
		tools: { allow: null, add: [], remove: [], exclude: [], noBuiltin: false, none: false },
		trust: "ask",
		offline: false,
		extensionFlags: {},
		sessionName: null,
	};
}
