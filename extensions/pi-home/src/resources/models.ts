import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig, saveJsonAtomic } from "../config.ts";
import { homeDataDir } from "../paths.ts";

export interface ModelEntry {
	id: string;
	provider: string;
	contextWindow?: string;
}

const MAX_AGE_MS = 24 * 3_600_000;
const run = promisify(execFile);
const cachePath = (): string => join(homeDataDir(), "models.json");

/** Parse the `--list-models` table: provider, model, context, max-out, thinking, images. */
function parseTable(text: string): ModelEntry[] {
	const out: ModelEntry[] = [];
	for (const line of text.split("\n")) {
		const cols = line.trim().split(/\s+/);
		if (cols.length < 6 || cols[0] === "provider") continue;
		const [provider, id, context] = cols;
		out.push(context ? { id, provider, contextWindow: context } : { id, provider });
	}
	return out;
}

function readCache(): { at: number; models: ModelEntry[] } | null {
	try {
		const raw = JSON.parse(readFileSync(cachePath(), "utf8")) as { at?: unknown; models?: unknown };
		if (typeof raw.at === "number" && Array.isArray(raw.models)) return { at: raw.at, models: raw.models as ModelEntry[] };
	} catch {
		// no usable cache
	}
	return null;
}

export async function loadModels(force = false): Promise<ModelEntry[]> {
	const cache = readCache();
	if (!force && cache && Date.now() - cache.at < MAX_AGE_MS) return cache.models;
	try {
		const { stdout } = await run(loadConfig().piBinary, ["--offline", "--list-models"], {
			maxBuffer: 8 * 1024 * 1024,
			timeout: 60_000,
		});
		const models = parseTable(stdout);
		if (models.length > 0) saveJsonAtomic(cachePath(), { at: Date.now(), models });
		return models;
	} catch {
		return cache?.models ?? [];
	}
}
