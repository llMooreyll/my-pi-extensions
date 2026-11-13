import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Profile } from "../shared/profile.ts";
import { configPath } from "./paths.ts";
import type { TierSetting } from "./term/caps.ts";

export interface HomeConfig {
	/** Command used to start pi (resolved through PATH when not absolute). */
	piBinary: string;
	/** Return to pi-home after pi exits (read by the zsh loop via `pi-home --config returnToHome`). */
	returnToHome: boolean;
	pinnedProjects: string[];
	/** Default profile per project cwd. */
	projectDefaults: Record<string, Profile>;
	presets: Record<string, Profile>;
	/** Global default profile applied under project defaults. */
	globalDefault: Profile | null;
	visual: {
		tier: TierSetting;
		motion: boolean;
		vignette: boolean;
		scanlines: boolean;
		flicker: boolean;
		bootAnimation: boolean;
	};
	analytics: {
		/** Monthly budget in USD for the budget gauge; 0 hides the gauge. */
		monthlyBudget: number;
		/** Words counted as polite / rushing in the behaviour page. */
		politeWords: string[];
		rushWords: string[];
		/** Equivalence card bases. */
		coffeePrice: number;
		bookTokens: number;
	};
	/** Hide sessions whose name starts with "<subagent:" in lists by default. */
	hideSubagents: boolean;
}

export const DEFAULT_CONFIG: HomeConfig = {
	piBinary: "pi",
	returnToHome: true,
	pinnedProjects: [],
	projectDefaults: {},
	presets: {},
	globalDefault: null,
	visual: { tier: "auto", motion: true, vignette: true, scanlines: false, flicker: true, bootAnimation: true },
	analytics: {
		monthlyBudget: 0,
		politeWords: ["谢谢", "麻烦", "请", "辛苦", "thanks", "thank you", "please"],
		rushWords: ["继续", "快点", "快", "赶紧", "直接", "hurry", "asap", "continue"],
		coffeePrice: 4,
		bookTokens: 120_000,
	},
	hideSubagents: true,
};

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge known keys of `src` over `base`; unknown keys and wrong types are ignored. */
function merge<T>(base: T, src: unknown): T {
	if (!isObj(base) || !isObj(src)) return (src !== undefined && typeof src === typeof base ? src : base) as T;
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(base)) {
		if (!(k in src)) continue;
		const sv = src[k];
		if (isObj(v) && Object.keys(v).length > 0) out[k] = merge(v, sv);
		else if (v === null || isObj(v)) out[k] = isObj(sv) || sv === null ? sv : v;
		else if (Array.isArray(v)) out[k] = Array.isArray(sv) ? sv : v;
		else if (typeof sv === typeof v) out[k] = sv;
	}
	return out as T;
}

export function loadConfig(): HomeConfig {
	try {
		return merge(structuredClone(DEFAULT_CONFIG), JSON.parse(readFileSync(configPath(), "utf8")));
	} catch {
		return structuredClone(DEFAULT_CONFIG);
	}
}

/** Atomic write (tmp + rename) so a crash never leaves a half-written config. */
export function saveJsonAtomic(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

export function saveConfig(cfg: HomeConfig): void {
	saveJsonAtomic(configPath(), cfg);
}
