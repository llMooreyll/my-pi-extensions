import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { colorToRgb, parseColor } from "@earendil-works/pi-tui";
import { agentDir, settingsPath } from "./paths.ts";
import type { Style } from "./term/canvas.ts";
import { REVERSE } from "./term/canvas.ts";
import type { Caps } from "./term/caps.ts";
import { hex, mix, rgb, type RGB, scale } from "./term/color.ts";

/** Theme colours pi-home needs, resolved to RGB (see VISUAL.md §2). */
export interface ThemeColors {
	name: string;
	accent: RGB;
	success: RGB;
	warning: RGB;
	error: RGB;
	link: RGB;
	muted: RGB;
	text: RGB;
}

/**
 * Everything drawing code may use for colour. Pages and charts must take colours only from here,
 * never hard-code RGB values, so that tiers and themes keep working.
 */
export interface Palette {
	caps: Caps;
	theme: ThemeColors;
	/** Phosphor brightness levels. */
	p100: RGB;
	p70: RGB;
	p45: RGB;
	p25: RGB;
	screenBg: RGB;
	panelBg: RGB;
	/** Monitor housing, index 0 = next to the screen, 3 = outermost. */
	bezel: [RGB, RGB, RGB, RGB];
	ok: RGB;
	err: RGB;
	/** Distinct series colours, kept close to the phosphor hue. Index with series(i). */
	seriesColors: RGB[];
	series(i: number): RGB;
	/** Heat colour for t in 0..1 (quantised per tier). */
	ramp(t: number): RGB;
	/** Heat glyph for t in 0..1; "██" style cells in colour tiers, density glyphs in tier 0. */
	rampGlyph(t: number): string;
	/** Selected row: inverse video. */
	sel: Style;
	/** Plain body text. */
	text: Style;
	/** Secondary text. */
	dim: Style;
	/** Rules, borders, axis lines. */
	faint: Style;
	/** Section titles "[ NAME ]". */
	title: Style;
	/** Emphasis (numbers, active items). */
	strong: Style;
}

const FALLBACK: ThemeColors = {
	name: "builtin-amber",
	accent: hex("#ffb000"),
	success: hex("#d5c965"),
	warning: hex("#efbbac"),
	error: hex("#ff6e5a"),
	link: hex("#efbbac"),
	muted: hex("#b08a50"),
	text: hex("#ffd38a"),
};

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function builtinThemeDir(): string | undefined {
	try {
		const req = createRequire(import.meta.url);
		// pi-coding-agent ships dark.json / light.json next to its theme module.
		const main = req.resolve("@earendil-works/pi-coding-agent");
		let dir = dirname(main);
		for (let i = 0; i < 4; i++) {
			const cand = join(dir, "modes", "interactive", "theme");
			if (existsSync(cand)) return cand;
			dir = dirname(dir);
		}
	} catch {
		/* not installed next to us */
	}
	const global = "/usr/lib/node_modules/pi/packages/coding-agent/dist/modes/interactive/theme";
	return existsSync(global) ? global : undefined;
}

function findThemeFile(name: string, cwd: string): string | undefined {
	const candidates = [join(cwd, ".pi", "themes", `${name}.json`), join(agentDir(), "themes", `${name}.json`)];
	const builtin = builtinThemeDir();
	if (builtin) candidates.push(join(builtin, `${name}.json`));
	return candidates.find((p) => existsSync(p));
}

interface ThemeJson {
	name?: string;
	vars?: Record<string, string | number>;
	colors?: Record<string, string | number>;
}

function resolveColor(theme: ThemeJson, key: string, seen = new Set<string>()): RGB | undefined {
	const raw = theme.colors?.[key];
	return resolveValue(theme, raw, seen);
}

function resolveValue(theme: ThemeJson, raw: string | number | undefined, seen: Set<string>): RGB | undefined {
	if (raw === undefined || raw === "") return undefined;
	if (typeof raw === "string" && theme.vars && raw in theme.vars) {
		if (seen.has(raw)) return undefined;
		seen.add(raw);
		return resolveValue(theme, theme.vars[raw], seen);
	}
	try {
		const c = colorToRgb(parseColor(raw));
		return rgb(c.r, c.g, c.b);
	} catch {
		return undefined;
	}
}

/** Load the pi theme named in settings.json (default "dark"), resolving vars and colour syntaxes. */
export function loadThemeColors(cwd = process.cwd()): ThemeColors {
	const settings = readJson(settingsPath()) as { theme?: string } | undefined;
	const name = process.env.PI_HOME_THEME || settings?.theme || "dark";
	const file = findThemeFile(name, cwd);
	if (!file) return FALLBACK;
	const theme = readJson(file) as ThemeJson | undefined;
	if (!theme) return FALLBACK;
	const accent = resolveColor(theme, "accent") ?? FALLBACK.accent;
	const text = resolveColor(theme, "userMessageText") ?? resolveColor(theme, "text") ?? mix(accent, 0xffffff, 0.5);
	return {
		name: theme.name ?? name,
		accent,
		success: resolveColor(theme, "success") ?? FALLBACK.success,
		warning: resolveColor(theme, "warning") ?? FALLBACK.warning,
		error: resolveColor(theme, "error") ?? FALLBACK.error,
		link: resolveColor(theme, "mdLink") ?? resolveColor(theme, "accent") ?? FALLBACK.link,
		muted: resolveColor(theme, "muted") ?? FALLBACK.muted,
		text,
	};
}

const DENSITY = [" ", "·", "░", "▒", "▓", "█"];

export function makePalette(theme: ThemeColors, caps: Caps): Palette {
	const p = theme.accent;
	const black = 0x000000;
	const screenBg = mix(black, p, 0.06);
	const panelBg = mix(black, p, 0.09);
	const lv = (k: number): RGB => mix(screenBg, p, k);
	const p70 = lv(0.7);
	const p45 = lv(0.45);
	const p25 = lv(0.25);
	const steps = caps.tier >= 2 ? 9 : 3;
	const seriesColors = [theme.accent, theme.success, theme.warning, theme.link, theme.error, theme.muted].map((c, i) =>
		i === 0 ? c : mix(c, p, 0.3),
	);
	const plain = caps.tier === 0;
	return {
		caps,
		theme,
		p100: p,
		p70,
		p45,
		p25,
		screenBg,
		panelBg,
		bezel: [scale(panelBg, 1.6), scale(panelBg, 1.0), scale(panelBg, 0.6), scale(panelBg, 0.3)],
		ok: theme.success,
		err: theme.error,
		seriesColors,
		series: (i) => seriesColors[((i % seriesColors.length) + seriesColors.length) % seriesColors.length]!,
		ramp: (t) => {
			const q = Math.round(Math.max(0, Math.min(1, t)) * (steps - 1)) / (steps - 1);
			return q === 0 ? mix(screenBg, p, 0.1) : mix(screenBg, p, 0.18 + 0.82 * q);
		},
		rampGlyph: (t) => {
			if (!plain) return "█";
			const i = Math.round(Math.max(0, Math.min(1, t)) * (DENSITY.length - 1));
			return DENSITY[i]!;
		},
		sel: plain ? { attr: REVERSE } : { fg: screenBg, bg: p, attr: 1 },
		text: { fg: p },
		dim: { fg: p45 },
		faint: { fg: p25 },
		title: { fg: p70 },
		strong: { fg: mix(p, 0xffffff, 0.25), attr: 1 },
	};
}
