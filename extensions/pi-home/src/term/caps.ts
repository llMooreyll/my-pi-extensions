import type { ColorMode } from "./renderer.ts";

/** VISUAL.md §1. 3 = shader CRT, 2 = truecolor character CRT, 1 = 256 colours, 0 = plain. */
export type Tier = 0 | 1 | 2 | 3;
export type TierSetting = "auto" | "crt" | "truecolor" | "256" | "plain";

export interface Caps {
	tier: Tier;
	colorMode: ColorMode;
	/** Unicode block/braille glyphs are safe to use. */
	unicode: boolean;
	motion: boolean;
	/** Why this tier was chosen (shown in the status line and journal when debugging). */
	reason: string;
}

function utf8Locale(env: NodeJS.ProcessEnv): boolean {
	const loc = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
	return loc === "" || /utf-?8/i.test(loc);
}

export function detectCaps(env: NodeJS.ProcessEnv, setting: TierSetting, motionSetting: boolean): Caps {
	const forced = (env.PI_HOME_TIER as TierSetting | undefined) || setting;
	const motion = motionSetting && env.PI_HOME_REDUCED_MOTION !== "1";
	const unicode = utf8Locale(env);
	const truecolor = /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "");
	const c256 = /256/.test(env.TERM ?? "");
	// The shader is only ever loaded by `pi-home --crt-window`, which sets this variable.
	const shader = env.PI_HOME_CRT_SHADER === "1";

	const make = (tier: Tier, reason: string): Caps => ({
		tier,
		colorMode: tier >= 2 ? "truecolor" : tier === 1 ? "256" : "none",
		unicode: tier === 0 ? unicode && forced !== "plain" : unicode,
		motion: tier === 0 ? false : motion,
		reason,
	});

	switch (forced) {
		case "crt":
			return make(3, "forced crt");
		case "truecolor":
			return make(2, "forced truecolor");
		case "256":
			return make(1, "forced 256");
		case "plain":
			return make(0, "forced plain");
	}
	if (env.NO_COLOR) return make(0, "NO_COLOR");
	if (!unicode) return make(0, "non-UTF-8 locale");
	if (env.TERM === "dumb") return make(0, "TERM=dumb");
	if (truecolor) return make(shader ? 3 : 2, shader ? "shader window" : "COLORTERM truecolor");
	if (c256) return make(1, "TERM 256color");
	return make(0, "16 colours");
}
