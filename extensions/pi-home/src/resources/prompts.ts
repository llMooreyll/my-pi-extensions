import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
	activeScopes,
	collectPromptEntries,
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

/** `description` frontmatter, else the first non-empty body line (docs/prompt-templates.md). */
function describe(file: string): string {
	const fm = readFrontmatter(file);
	if (fm.description) return fm.description;
	try {
		const body = readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
		return body.split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? "";
	} catch {
		return "";
	}
}

export function listPrompts(cwd: string, trusted: boolean): ResourceItem[] {
	const items: ResourceItem[] = [];
	const names = new Set<string>();
	const add = (file: string, source: ResourceItem["source"], scope: Scope, packageSource?: string) => {
		const name = basename(file, ".md");
		if (names.has(name)) return;
		names.add(name);
		const overrides = stringArray(readSettings(scope, cwd).prompts).filter(isOverride);
		items.push({
			kind: "prompt",
			name,
			arg: file,
			source,
			enabledByDefault: packageSource === undefined ? enabledByOverrides(file, overrides, scopeBase(scope, cwd)) : true,
			...(packageSource === undefined ? {} : { packageSource }),
			description: describe(file),
		});
	};

	for (const scope of activeScopes(trusted)) {
		const base = scopeBase(scope, cwd);
		collectPromptEntries(join(base, "prompts")).forEach((f) => add(f, `${scope}-dir`, scope));
		for (const e of stringArray(readSettings(scope, cwd).prompts)) {
			if (isOverride(e)) continue;
			const path = resolveIn(e, base);
			try {
				(statSync(path).isFile() ? [path] : collectPromptEntries(path)).forEach((f) => add(f, `${scope}-settings`, scope));
			} catch {
				// configured path does not exist
			}
		}
	}
	for (const pkg of listPackages(cwd, trusted).packages) {
		for (const f of pkg.prompts) add(f, pkg.scope === "global" ? "global-package" : "project-package", pkg.scope, pkg.source);
	}
	return items;
}
