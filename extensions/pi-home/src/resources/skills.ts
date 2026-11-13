import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	activeScopes,
	collectSkillEntries,
	enabledByOverrides,
	isOverride,
	listPackages,
	readFrontmatter,
	readSettings,
	resolveIn,
	scopeBase,
	stringArray,
} from "./packages.ts";
import type { Scope } from "./packages.ts";
import type { ResourceItem } from "./types.ts";

/** `.agents/skills` from cwd up to the repository root (docs/skills.md "Add it to Pi"). */
function ancestorAgentsDirs(cwd: string): string[] {
	const dirs: string[] = [];
	let dir = resolve(cwd);
	let repoRoot: string | null = null;
	for (let d = dir; ; d = dirname(d)) {
		try {
			statSync(join(d, ".git"));
			repoRoot = d;
			break;
		} catch {
			if (dirname(d) === d) break;
		}
	}
	while (true) {
		dirs.push(join(dir, ".agents", "skills"));
		if (dir === repoRoot || dirname(dir) === dir) break;
		dir = dirname(dir);
	}
	return dirs;
}

/** Skills pi would load with no CLI flags; `-`/`!` entries in settings.skills clear enabledByDefault. */
export function listSkills(cwd: string, trusted: boolean): ResourceItem[] {
	const items: ResourceItem[] = [];
	const names = new Set<string>();
	const overridesFor = (scope: Scope) => stringArray(readSettings(scope, cwd).skills).filter(isOverride);
	const add = (file: string, source: ResourceItem["source"], scope: Scope, packageSource?: string) => {
		const fm = readFrontmatter(file);
		// Skills without a description are not loaded; the first of a name collision wins (docs/skills.md).
		if (!fm.description?.trim()) return;
		const name = fm.name?.trim() || (basename(file) === "SKILL.md" ? basename(dirname(file)) : basename(file, ".md"));
		if (names.has(name)) return;
		names.add(name);
		const enabled = packageSource === undefined ? enabledByOverrides(file, overridesFor(scope), scopeBase(scope, cwd)) : true;
		items.push({
			kind: "skill",
			name,
			arg: file,
			source,
			enabledByDefault: enabled,
			...(packageSource === undefined ? {} : { packageSource }),
			description: fm.description.trim(),
		});
	};

	for (const scope of activeScopes(trusted)) {
		const base = scopeBase(scope, cwd);
		const dirSource = `${scope}-dir` as const;
		collectSkillEntries(join(base, "skills"), "pi").forEach((f) => add(f, dirSource, scope));
		if (scope === "global") collectSkillEntries(join(homedir(), ".agents", "skills"), "agents").forEach((f) => add(f, dirSource, scope));
		else ancestorAgentsDirs(cwd).forEach((d) => collectSkillEntries(d, "agents").forEach((f) => add(f, dirSource, scope)));
		for (const e of stringArray(readSettings(scope, cwd).skills)) {
			if (isOverride(e)) continue;
			const path = resolveIn(e, base);
			try {
				(statSync(path).isFile() ? [path] : collectSkillEntries(path, "pi")).forEach((f) => add(f, `${scope}-settings`, scope));
			} catch {
				// configured path does not exist
			}
		}
	}
	for (const pkg of listPackages(cwd, trusted).packages) {
		for (const f of pkg.skills) add(f, pkg.scope === "global" ? "global-package" : "project-package", pkg.scope, pkg.source);
	}
	return items;
}
