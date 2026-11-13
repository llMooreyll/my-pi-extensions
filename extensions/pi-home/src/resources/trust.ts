import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentDir } from "../paths.ts";

function canonical(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

/**
 * Saved project-trust decision for `cwd` or its nearest parent (docs/security.md "How Pi chooses a
 * trust decision"; file format per pi's trust-manager.js: `{ "<canonical dir>": true | false }`).
 * Missing file or no matching entry means not trusted; `defaultProjectTrust` is ignored.
 */
export function isProjectTrusted(cwd: string): boolean {
	let entries: Record<string, unknown>;
	try {
		const raw: unknown = JSON.parse(readFileSync(join(agentDir(), "trust.json"), "utf8"));
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
		entries = raw as Record<string, unknown>;
	} catch {
		return false;
	}
	let dir = canonical(cwd);
	while (true) {
		const v = entries[dir];
		if (typeof v === "boolean") return v;
		const parent = dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}
