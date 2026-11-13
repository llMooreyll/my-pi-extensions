/**
 * Package and settings discovery shared by extensions.ts, skills.ts and prompts.ts.
 * Rules: docs/packages.md, docs/settings.md#resources, plus install roots and entry-point
 * discovery as implemented in pi's core/package-manager.js (read-only reference).
 */
import { existsSync, globSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, matchesGlob as pathMatchesGlob, relative, resolve } from "node:path";
import { agentDir } from "../paths.ts";

export type Scope = "global" | "project";

export interface PackageInfo {
	/** Source string exactly as written in settings.json. */
	source: string;
	scope: Scope;
	dir: string;
	name: string;
	description: string;
	/** Extension entry files (empty = the package provides no extension). */
	extensions: string[];
	/** SKILL.md files (or skill markdown files). */
	skills: string[];
	/** Prompt template .md files. */
	prompts: string[];
}

export interface PackageList {
	packages: PackageInfo[];
	/** Sources whose resolved directory does not exist. */
	missing: string[];
	/** Sources configured with a filter object; all their resources are listed. */
	filtersIgnored: string[];
}

export type Settings = Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Base directory for relative paths: the agent dir (user) or `<cwd>/.pi` (project). */
export const scopeBase = (scope: Scope, cwd: string): string => (scope === "global" ? agentDir() : join(cwd, ".pi"));

export function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

export function readSettings(scope: Scope, cwd: string): Settings {
	const raw = readJson(join(scopeBase(scope, cwd), "settings.json"));
	return isObj(raw) ? raw : {};
}

export function stringArray(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Expand `~` and resolve against `base`. */
export function resolveIn(input: string, base: string): string {
	const t = input.trim();
	return resolve(base, t === "~" ? homedir() : t.startsWith("~/") ? join(homedir(), t.slice(2)) : t);
}

/** Scopes to read, in precedence order of loading (global first). */
export function activeScopes(trusted: boolean): Scope[] {
	return trusted ? ["global", "project"] : ["global"];
}

// ---------------------------------------------------------------------------------------------
// +/-/! overrides (docs/packages.md "Select package resources", docs/settings.md#resources)

export function isOverride(entry: string): boolean {
	return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-");
}

function matchesExact(file: string, pattern: string, base: string): boolean {
	const p = resolveIn(pattern.replace(/^\.\//, ""), base);
	if (p === file) return true;
	return basename(file) === "SKILL.md" && p === dirname(file);
}

function matchesGlob(file: string, pattern: string, base: string): boolean {
	const names = [relative(base, file), basename(file), file];
	if (basename(file) === "SKILL.md") names.push(relative(base, dirname(file)), basename(dirname(file)), dirname(file));
	return names.some((n) => n === pattern || pathMatchesGlob(n, pattern));
}

/** `!glob` excludes, `+path` force-includes, `-path` force-excludes (applied in that order). */
export function enabledByOverrides(file: string, entries: string[], base: string): boolean {
	let enabled = true;
	const pick = (c: string) => entries.filter((e) => e.startsWith(c)).map((e) => e.slice(1));
	if (pick("!").some((p) => matchesGlob(file, p, base))) enabled = false;
	if (pick("+").some((p) => matchesExact(file, p, base))) enabled = true;
	if (pick("-").some((p) => matchesExact(file, p, base))) enabled = false;
	return enabled;
}

// ---------------------------------------------------------------------------------------------
// Directory scanners (mirror collectAuto*Entries in package-manager.js, without .gitignore rules)

function statKind(path: string, e: import("node:fs").Dirent): { isDir: boolean; isFile: boolean } {
	if (!e.isSymbolicLink()) return { isDir: e.isDirectory(), isFile: e.isFile() };
	try {
		const s = statSync(path);
		return { isDir: s.isDirectory(), isFile: s.isFile() };
	} catch {
		return { isDir: false, isFile: false };
	}
}

function safeReaddir(dir: string) {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** True the first time a directory (by realpath) is seen; guards the recursive scanners against symlink cycles. */
function firstVisit(dir: string, visited: Set<string>): boolean {
	let real = dir;
	try {
		real = realpathSync(dir);
	} catch {
		// unreadable: let the caller's own error handling deal with it
	}
	if (visited.has(real)) return false;
	visited.add(real);
	return true;
}

/** Entry points declared by a directory: package.json `pi.extensions`, else index.ts/index.js. */
export function resolveExtensionEntries(dir: string): string[] | null {
	const pkg = readJson(join(dir, "package.json"));
	const declared = isObj(pkg) && isObj(pkg.pi) ? stringArray(pkg.pi.extensions) : [];
	const entries = declared.map((p) => resolve(dir, p)).filter((p) => existsSync(p));
	if (entries.length > 0) return entries;
	for (const name of ["index.ts", "index.js"]) if (existsSync(join(dir, name))) return [join(dir, name)];
	return null;
}

/** Extension entries under a conventional extensions directory. */
export function collectExtensionEntries(dir: string, visited = new Set<string>()): string[] {
	if (!existsSync(dir) || !firstVisit(dir, visited)) return [];
	const root = resolveExtensionEntries(dir);
	if (root) return root;
	const out: string[] = [];
	for (const e of safeReaddir(dir)) {
		if (e.name.startsWith(".") || e.name === "node_modules") continue;
		const full = join(dir, e.name);
		const { isDir, isFile } = statKind(full, e);
		if (isFile && (e.name.endsWith(".ts") || e.name.endsWith(".js"))) out.push(full);
		else if (isDir) out.push(...(resolveExtensionEntries(full) ?? []));
	}
	return out;
}

/**
 * Skill entries: a directory holding SKILL.md is one skill (no further descent); "pi" mode also
 * takes loose .md files directly in the root, "agents" mode takes .md files in sub-directories.
 */
export function collectSkillEntries(dir: string, mode: "pi" | "agents", root = dir, visited = new Set<string>()): string[] {
	if (!existsSync(dir) || !firstVisit(dir, visited)) return [];
	const entries = safeReaddir(dir);
	const own = entries.find((e) => e.name === "SKILL.md" && statKind(join(dir, e.name), e).isFile);
	if (own) return [join(dir, own.name)];
	const out: string[] = [];
	for (const e of entries) {
		if (e.name.startsWith(".") || e.name === "node_modules") continue;
		const full = join(dir, e.name);
		const { isDir, isFile } = statKind(full, e);
		if (isFile && e.name.endsWith(".md") && ((mode === "pi" && dir === root) || (mode === "agents" && dir !== root))) {
			out.push(full);
		} else if (isDir) out.push(...collectSkillEntries(full, mode, root, visited));
	}
	return out;
}

/** Prompt templates: direct .md children only (docs/prompt-templates.md). */
export function collectPromptEntries(dir: string): string[] {
	const out: string[] = [];
	for (const e of safeReaddir(dir)) {
		if (e.name.startsWith(".") || e.name === "node_modules") continue;
		const full = join(dir, e.name);
		if (statKind(full, e).isFile && e.name.endsWith(".md")) out.push(full);
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// Frontmatter

/** Minimal YAML front matter reader: scalar `key: value` lines and `>`/`|` block scalars. */
export function readFrontmatter(path: string): Record<string, string> {
	let text: string;
	try {
		text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
	} catch {
		return {};
	}
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return {};
	const out: Record<string, string> = {};
	const lines = m[1].split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!kv) continue;
		let value = kv[2].trim();
		if (/^[>|][+-]?$/.test(value)) {
			const parts: string[] = [];
			while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
			value = parts.join(" ");
		} else if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
		out[kv[1]] = value;
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// Packages

type ParsedSource =
	| { type: "npm"; name: string }
	| { type: "git"; host: string; path: string }
	| { type: "local"; path: string };

function parseSource(source: string): ParsedSource {
	if (source.startsWith("npm:")) {
		const spec = source.slice(4).trim();
		const at = spec.lastIndexOf("@");
		return { type: "npm", name: at > 0 ? spec.slice(0, at) : spec };
	}
	if (/^(\.|\/|~)/.test(source)) return { type: "local", path: source };
	let rest = source.replace(/^git:/, "");
	let host = "";
	const scp = rest.match(/^git@([^:]+):(.+)$/);
	if (scp) {
		host = scp[1];
		rest = scp[2];
	} else {
		const url = rest.match(/^[a-z+]+:\/\/([^/]+)\/(.+)$/);
		if (url) {
			host = url[1];
			rest = url[2];
		} else {
			const slash = rest.indexOf("/");
			if (slash < 0) return { type: "local", path: source };
			host = rest.slice(0, slash);
			rest = rest.slice(slash + 1);
		}
	}
	const path = rest.replace(/@[^/@]+$/, "").replace(/\.git$/, "").replace(/^\/+/, "");
	return path.split("/").length >= 2 ? { type: "git", host, path } : { type: "local", path: source };
}

function identity(p: ParsedSource, base: string): string {
	if (p.type === "npm") return `npm:${p.name}`;
	if (p.type === "git") return `git:${p.host}/${p.path}`;
	return `local:${resolveIn(p.path, base)}`;
}

function installDir(p: ParsedSource, scope: Scope, cwd: string): string {
	const base = scopeBase(scope, cwd);
	if (p.type === "npm") return join(base, "npm", "node_modules", p.name);
	if (p.type === "git") return join(base, "git", p.host, p.path);
	return resolveIn(p.path, base);
}

/** Expand manifest globs (relative to the package root); `!pattern` entries exclude. */
function expandManifest(dir: string, patterns: string[]): string[] {
	const excludes = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1).replace(/^\.\//, ""));
	const out: string[] = [];
	for (const raw of patterns) {
		if (isOverride(raw)) continue;
		const pattern = raw.replace(/^\.\//, "");
		let hits: string[];
		try {
			hits = existsSync(join(dir, pattern)) ? [pattern] : globSync(pattern, { cwd: dir });
		} catch {
			hits = [];
		}
		for (const h of hits) {
			const abs = resolve(dir, h);
			if (!excludes.some((x) => pathMatchesGlob(h, x)) && !out.includes(abs)) out.push(abs);
		}
	}
	return out;
}

function packageResources(dir: string): Pick<PackageInfo, "extensions" | "skills" | "prompts"> {
	// A local package source may be a single extension file (docs/packages.md "Choose a source").
	if (statSync(dir).isFile()) return { extensions: [dir], skills: [], prompts: [] };
	const pkg = readJson(join(dir, "package.json"));
	const manifest = isObj(pkg) && isObj(pkg.pi) ? pkg.pi : null;
	const explicit = (["extensions", "skills", "prompts", "themes"] as const).some(
		(k) => manifest && Array.isArray(manifest[k]),
	);
	const isDir = (p: string) => {
		try {
			return statSync(p).isDirectory();
		} catch {
			return false;
		}
	};
	if (explicit && manifest) {
		const extensions = expandManifest(dir, stringArray(manifest.extensions)).flatMap((p) =>
			isDir(p) ? collectExtensionEntries(p) : [p],
		);
		const skills = expandManifest(dir, stringArray(manifest.skills)).flatMap((p) =>
			isDir(p) ? collectSkillEntries(p, "pi") : [p],
		);
		const prompts = expandManifest(dir, stringArray(manifest.prompts)).flatMap((p) =>
			isDir(p) ? collectPromptEntries(p) : [p],
		);
		return { extensions, skills, prompts };
	}
	return {
		extensions: collectExtensionEntries(join(dir, "extensions")),
		skills: collectSkillEntries(join(dir, "skills"), "pi"),
		prompts: collectPromptEntries(join(dir, "prompts")),
	};
}

/**
 * Packages from `<agentDir>/settings.json` and (when trusted) `<cwd>/.pi/settings.json`.
 * A project entry replaces a user entry of the same identity (docs/packages.md "scope and identity").
 * Filter objects are not interpreted: every resource of the package is listed.
 */
export function listPackages(cwd: string, trusted: boolean): PackageList {
	const byId = new Map<string, PackageInfo>();
	const missing: string[] = [];
	const filtersIgnored: string[] = [];
	for (const scope of activeScopes(trusted)) {
		const base = scopeBase(scope, cwd);
		const entries = Array.isArray(readSettings(scope, cwd).packages) ? (readSettings(scope, cwd).packages as unknown[]) : [];
		for (const entry of entries) {
			const source = typeof entry === "string" ? entry : isObj(entry) && typeof entry.source === "string" ? entry.source : null;
			if (!source) continue;
			if (isObj(entry) && ["extensions", "skills", "prompts", "themes"].some((k) => k in entry)) filtersIgnored.push(source);
			const parsed = parseSource(source);
			const dir = installDir(parsed, scope, cwd);
			if (!existsSync(dir)) {
				missing.push(source);
				continue;
			}
			const pkg = readJson(join(dir, "package.json"));
			const name = isObj(pkg) && typeof pkg.name === "string" ? pkg.name : basename(dir);
			const description = isObj(pkg) && typeof pkg.description === "string" ? pkg.description : "";
			byId.set(identity(parsed, base), { source, scope, dir, name, description, ...packageResources(dir) });
		}
	}
	return { packages: [...byId.values()], missing, filtersIgnored };
}
