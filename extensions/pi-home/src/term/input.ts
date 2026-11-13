import { decodeKittyPrintable } from "@earendil-works/pi-tui";

export interface KeyInput {
	type: "key";
	/** Raw sequence; match with pi-tui's matchesKey(). */
	data: string;
}

export interface MouseInput {
	type: "mouse";
	/** 0-based cell coordinates. */
	x: number;
	y: number;
	/** 0 left, 1 middle, 2 right; 3 = release in legacy encoding. */
	button: number;
	action: "down" | "up" | "move" | "wheel";
	/** -1 wheel up, +1 wheel down (only for action "wheel"). */
	wheel: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
}

export interface PasteInput {
	type: "paste";
	text: string;
}

export type InputEvent = KeyInput | MouseInput | PasteInput;

const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
const PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

export function parseInput(data: string): InputEvent {
	const m = SGR_MOUSE.exec(data);
	if (m) {
		const b = Number(m[1]);
		const x = Number(m[2]) - 1;
		const y = Number(m[3]) - 1;
		const mods = { shift: (b & 4) !== 0, alt: (b & 8) !== 0, ctrl: (b & 16) !== 0 };
		if (b & 64) return { type: "mouse", x, y, button: 0, action: "wheel", wheel: b & 1 ? 1 : -1, ...mods };
		const action = b & 32 ? "move" : m[4] === "M" ? "down" : "up";
		return { type: "mouse", x, y, button: b & 3, action, wheel: 0, ...mods };
	}
	const p = PASTE.exec(data);
	if (p) return { type: "paste", text: p[1]! };
	return { type: "key", data };
}

/** Printable text carried by a key event, or undefined for control/navigation keys. */
export function printable(data: string): string | undefined {
	if (data.length === 0) return undefined;
	// Kitty CSI-u / modifyOtherKeys encodings of printable keys.
	if (data.startsWith("\x1b")) return decodeKittyPrintable(data);
	for (const ch of data) {
		const c = ch.codePointAt(0)!;
		if (c < 32 || c === 127) return undefined;
	}
	return data;
}
