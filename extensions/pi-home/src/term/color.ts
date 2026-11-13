/** Packed 0xRRGGBB colour. DEFAULT means "terminal default" and is never transformed. */
export type RGB = number;
export const DEFAULT: RGB = -1;

const clamp8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

export const rgb = (r: number, g: number, b: number): RGB => (clamp8(r) << 16) | (clamp8(g) << 8) | clamp8(b);
export const red = (c: RGB): number => (c >> 16) & 255;
export const green = (c: RGB): number => (c >> 8) & 255;
export const blue = (c: RGB): number => c & 255;

export function hex(s: string): RGB {
	const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
	if (!m) throw new Error(`bad hex colour: ${s}`);
	return Number.parseInt(m[1]!, 16);
}

export const toHex = (c: RGB): string => `#${c.toString(16).padStart(6, "0")}`;

/** Linear blend from a (t=0) to b (t=1) in sRGB space. */
export function mix(a: RGB, b: RGB, t: number): RGB {
	if (a === DEFAULT || b === DEFAULT) return a;
	return rgb(red(a) + (red(b) - red(a)) * t, green(a) + (green(b) - green(a)) * t, blue(a) + (blue(b) - blue(a)) * t);
}

/** Multiply brightness by k (k<1 darkens). */
export function scale(c: RGB, k: number): RGB {
	if (c === DEFAULT) return c;
	return rgb(red(c) * k, green(c) * k, blue(c) * k);
}

/** Relative luminance 0..1 (sRGB approximation, good enough for contrast decisions). */
export function luminance(c: RGB): number {
	if (c === DEFAULT) return 0;
	return (0.2126 * red(c) + 0.7152 * green(c) + 0.0722 * blue(c)) / 255;
}

const CUBE = [0, 95, 135, 175, 215, 255];
const cache256 = new Map<RGB, number>();

/** Nearest xterm-256 palette index (cube 16..231 or grey ramp 232..255). */
export function nearest256(c: RGB): number {
	const hit = cache256.get(c);
	if (hit !== undefined) return hit;
	const r = red(c);
	const g = green(c);
	const b = blue(c);
	const idx = (v: number): number => {
		let best = 0;
		for (let i = 1; i < 6; i++) if (Math.abs(CUBE[i]! - v) < Math.abs(CUBE[best]! - v)) best = i;
		return best;
	};
	const ri = idx(r);
	const gi = idx(g);
	const bi = idx(b);
	const cubeDist = (CUBE[ri]! - r) ** 2 + (CUBE[gi]! - g) ** 2 + (CUBE[bi]! - b) ** 2;
	const grey = Math.round((r + g + b) / 3);
	const gIdx = Math.max(0, Math.min(23, Math.round((grey - 8) / 10)));
	const gv = 8 + gIdx * 10;
	const greyDist = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
	const out = greyDist < cubeDist ? 232 + gIdx : 16 + 36 * ri + 6 * gi + bi;
	cache256.set(c, out);
	return out;
}
