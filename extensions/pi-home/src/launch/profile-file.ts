import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Profile } from "../../shared/profile.ts";
import { runDir } from "../paths.ts";

/** Write the profile for the companion extension (`--home-profile <file>`); the extension deletes it after reading. */
export function writeProfileFile(profile: Profile): string {
	mkdirSync(runDir(), { recursive: true });
	const path = join(runDir(), `${Date.now()}-${randomBytes(3).toString("hex")}.json`);
	writeFileSync(path, JSON.stringify(profile), { mode: 0o600 });
	chmodSync(path, 0o600);
	return path;
}

/** Delete profile files that were never picked up (pi failed to start, launch cancelled). */
export function cleanupProfileFiles(maxAgeMs = 86_400_000): void {
	let names: string[];
	try {
		names = readdirSync(runDir());
	} catch {
		return;
	}
	const cutoff = Date.now() - maxAgeMs;
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(runDir(), name);
		try {
			if (statSync(path).mtimeMs < cutoff) rmSync(path);
		} catch {
			// raced with the extension deleting it
		}
	}
}
