import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { agentDir } from "../paths.ts";
import {
	activeScopes,
	collectExtensionEntries,
	enabledByOverrides,
	isOverride,
	listPackages,
	readJson,
	readSettings,
	resolveIn,
	scopeBase,
	stringArray,
} from "./packages.ts";
import type { ResourceItem } from "./types.ts";

/** Built-in extensions named in docs/settings.md:164. */
export const BUILTIN_EXTENSIONS = ["mcp", "llama.cpp", "codemode", "tool-search"];

function entryName(entry: string): string {
	const file = basename(entry);
	return file === "index.ts" || file === "index.js" ? basename(dirname(entry)) : file.replace(/\.(ts|js)$/, "");
}

function entryDescription(entry: string): string {
	const pkg = readJson(join(dirname(entry), "package.json")) as { description?: unknown } | null;
	return pkg && typeof pkg.description === "string" ? pkg.description : "";
}

/** Extensions pi would load with no CLI flags: packages, settings paths, conventional dirs, built-ins. */
export function listExtensions(cwd: string, trusted: boolean): ResourceItem[] {
	const items: ResourceItem[] = [];
	const seen = new Set<string>();
	const add = (item: ResourceItem) => {
		if (seen.has(item.arg)) return;
		seen.add(item.arg);
		items.push(item);
	};

	// A later scope (project) overrides the user setting for built-ins (settings.md:164).
	const builtinOn = new Map<string, boolean>();
	for (const scope of activeScopes(trusted)) {
		for (const e of stringArray(readSettings(scope, cwd).extensions)) {
			const m = e.match(/^([+-])builtin:(.+)$/);
			if (m) builtinOn.set(m[2], m[1] === "+");
		}
	}
	for (const name of BUILTIN_EXTENSIONS) {
		add({
			kind: "extension",
			name,
			arg: `builtin:${name}`,
			source: "builtin",
			enabledByDefault: builtinOn.get(name) ?? true,
			description: "Built-in pi extension",
		});
	}

	for (const pkg of listPackages(cwd, trusted).packages) {
		if (pkg.extensions.length === 0) continue;
		add({
			kind: "extension",
			name: pkg.name,
			arg: pkg.dir,
			source: pkg.scope === "global" ? "global-package" : "project-package",
			enabledByDefault: true,
			packageSource: pkg.source,
			description: pkg.description,
		});
	}

	for (const scope of activeScopes(trusted)) {
		const base = scopeBase(scope, cwd);
		const entries = stringArray(readSettings(scope, cwd).extensions);
		const overrides = entries.filter(isOverride);
		const push = (file: string, source: ResourceItem["source"]) =>
			add({
				kind: "extension",
				name: entryName(file),
				arg: file,
				source,
				enabledByDefault: enabledByOverrides(file, overrides, base),
				description: entryDescription(file),
			});
		for (const e of entries) {
			if (isOverride(e) || e.startsWith("builtin:")) continue;
			const path = resolveIn(e, base);
			try {
				if (statSync(path).isFile()) push(path, `${scope}-settings`);
				else collectExtensionEntries(path).forEach((f) => push(f, `${scope}-settings`));
			} catch {
				// configured path does not exist: pi skips it too
			}
		}
		const dir = scope === "global" ? join(agentDir(), "extensions") : join(cwd, ".pi", "extensions");
		collectExtensionEntries(dir).forEach((f) => push(f, `${scope}-dir`));
	}
	return items;
}
