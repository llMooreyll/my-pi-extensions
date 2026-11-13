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

// ---------------------------------------------------------------------------------------------
// Validation and display helpers

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strList = (v: unknown, fallback: string[]): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : fallback;
const strOrNull = (v: unknown, fallback: string | null): string | null => (typeof v === "string" ? v : v === null ? null : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
	typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
const THINKING: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Full Profile from untrusted input (a version-1 object); invalid fields fall back to defaults, unknown fields are dropped. */
export function normalizeProfile(x: unknown): Profile | null {
	if (!isObj(x) || x.version !== PROFILE_VERSION) return null;
	const d = emptyProfile();
	const sub = (k: string): Record<string, unknown> => (isObj(x[k]) ? (x[k] as Record<string, unknown>) : {});
	const ext = sub("extensions");
	const skills = sub("skills");
	const prompts = sub("promptTemplates");
	const ctx = sub("contextFiles");
	const sys = sub("systemPrompt");
	const tools = sub("tools");
	const flags: Record<string, boolean | string> = {};
	if (isObj(x.extensionFlags)) {
		for (const [k, v] of Object.entries(x.extensionFlags)) if (typeof v === "boolean" || typeof v === "string") flags[k] = v;
	}
	return {
		version: 1,
		model: strOrNull(x.model, d.model),
		thinking: x.thinking === null ? null : (THINKING.find((t) => t === x.thinking) ?? d.thinking),
		modelsScope: strList(x.modelsScope, d.modelsScope),
		extensions: {
			mode: oneOf(ext.mode, ["default", "exclude", "only"], d.extensions.mode),
			exclude: strList(ext.exclude, d.extensions.exclude),
			only: strList(ext.only, d.extensions.only),
		},
		mcp: bool(x.mcp, d.mcp),
		skills: {
			mode: oneOf(skills.mode, ["default", "only", "none"], d.skills.mode),
			only: strList(skills.only, d.skills.only),
			hideInPrompt: strList(skills.hideInPrompt, d.skills.hideInPrompt),
		},
		promptTemplates: {
			mode: oneOf(prompts.mode, ["default", "only", "none"], d.promptTemplates.mode),
			only: strList(prompts.only, d.promptTemplates.only),
		},
		contextFiles: {
			mode: oneOf(ctx.mode, ["default", "none", "pick"], d.contextFiles.mode),
			include: strList(ctx.include, d.contextFiles.include),
			extra: strList(ctx.extra, d.contextFiles.extra),
		},
		systemPrompt: {
			replace: strOrNull(sys.replace, d.systemPrompt.replace),
			append: strList(sys.append, d.systemPrompt.append),
		},
		tools: {
			allow: Array.isArray(tools.allow) ? strList(tools.allow, []) : null,
			add: strList(tools.add, d.tools.add),
			remove: strList(tools.remove, d.tools.remove),
			exclude: strList(tools.exclude, d.tools.exclude),
			noBuiltin: bool(tools.noBuiltin, d.tools.noBuiltin),
			none: bool(tools.none, d.tools.none),
		},
		trust: oneOf(x.trust, ["ask", "trust", "deny"], d.trust),
		offline: bool(x.offline, d.offline),
		extensionFlags: flags,
		sessionName: strOrNull(x.sessionName, d.sessionName),
	};
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
	if (isObj(a) && isObj(b)) {
		const ka = Object.keys(a);
		return ka.length === Object.keys(b).length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
	}
	return false;
}

export function isEmptyProfile(p: Profile): boolean {
	return deepEqual(p, emptyProfile());
}

/** Short English lines for the non-default settings only, for lists. */
export function describeProfile(p: Profile): string[] {
	const out: string[] = [];
	if (p.model) out.push(`model ${p.model}`);
	if (p.thinking) out.push(`thinking ${p.thinking}`);
	if (p.modelsScope.length > 0) out.push(`model scope: ${p.modelsScope.length}`);
	if (p.extensions.mode === "only") out.push(`extensions: only ${p.extensions.only.length}`);
	if (p.extensions.mode === "exclude") out.push(`extensions: ${p.extensions.exclude.length} excluded`);
	if (!p.mcp) out.push("no MCP");
	if (p.skills.mode === "none") out.push("no skills");
	if (p.skills.mode === "only") out.push(`skills: only ${p.skills.only.length}`);
	if (p.skills.hideInPrompt.length > 0) out.push(`skills hidden in prompt: ${p.skills.hideInPrompt.length}`);
	if (p.promptTemplates.mode === "none") out.push("no prompt templates");
	if (p.promptTemplates.mode === "only") out.push(`prompt templates: only ${p.promptTemplates.only.length}`);
	if (p.contextFiles.mode === "none") out.push("no context files");
	if (p.contextFiles.mode === "pick") {
		const extra = p.contextFiles.extra.length;
		out.push(`context files: pick ${p.contextFiles.include.length}${extra > 0 ? ` + ${extra} extra` : ""}`);
	} else if (p.contextFiles.mode === "default" && p.contextFiles.extra.length > 0) {
		out.push(`context files: ${p.contextFiles.extra.length} extra`);
	}
	if (p.systemPrompt.replace) out.push("system prompt replaced");
	if (p.systemPrompt.append.length > 0) out.push(`system prompt: ${p.systemPrompt.append.length} appended`);
	if (p.tools.none) out.push("no tools");
	else {
		if (p.tools.noBuiltin) out.push("no built-in tools");
		if (p.tools.allow) out.push(`tools: only ${p.tools.allow.length}`);
		else if (p.tools.add.length + p.tools.remove.length > 0) out.push(`tools: +${p.tools.add.length} -${p.tools.remove.length}`);
		if (p.tools.exclude.length > 0) out.push(`tools: ${p.tools.exclude.length} excluded`);
	}
	if (p.trust === "trust") out.push("trust project");
	if (p.trust === "deny") out.push("deny project trust");
	if (p.offline) out.push("offline");
	const flagCount = Object.keys(p.extensionFlags).length;
	if (flagCount > 0) out.push(`extension flags: ${flagCount}`);
	if (p.sessionName) out.push(`name ${p.sessionName}`);
	return out;
}
