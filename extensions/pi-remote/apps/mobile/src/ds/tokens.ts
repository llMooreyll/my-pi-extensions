import { useColorScheme } from "react-native";

/**
 * "FOLIO" — the app set like an editorial broadsheet.
 * No cards, boxes or shadows: hierarchy comes from type (a high-contrast serif against a grotesk and a mono),
 * hairline rules, a strict left margin and generous white space. Two inks carry meaning and nothing else:
 * pink = this needs you, blue = working.
 */
export interface Palette {
  scheme: "light" | "dark";
  paper: string;
  tint: string;       // pressed rows, code background
  ink: string;
  soft: string;       // secondary text
  faint: string;      // hairlines, tertiary text
  invert: string;     // text on solid ink
  pink: string;
  blue: string;
  ok: string;         // connected / healthy
  danger: string;
  addBg: string; delBg: string;
}

const light: Palette = {
  scheme: "light", paper: "#F3F0E9", tint: "#E7E2D7", ink: "#141413", soft: "#67625A", faint: "#C9C3B6", invert: "#F3F0E9",
  pink: "#F2287F", blue: "#2346F5", ok: "#178A4C", danger: "#D8341A", addBg: "#DCEFCB", delBg: "#F9D5DF",
};
const dark: Palette = {
  scheme: "dark", paper: "#0F0F0E", tint: "#1C1C1A", ink: "#EFEBE2", soft: "#97928A", faint: "#33322F", invert: "#0F0F0E",
  pink: "#FF4C9B", blue: "#7088FF", ok: "#4CC584", danger: "#FF6B47", addBg: "#1D3216", delBg: "#3E1424",
};

export function usePalette(): Palette {
  return useColorScheme() === "light" ? light : dark;
}

export const F = {
  serif: "InstrumentSerif-Regular",
  serifItalic: "InstrumentSerif-Italic",
  sans: "SpaceGrotesk-Regular",
  sansMed: "SpaceGrotesk-Medium",
  sansBold: "SpaceGrotesk-Bold",
  mono: "JetBrainsMono-Regular",
  monoBold: "JetBrainsMono-Bold",
  // Chinese: Source Han / Noto CJK subset to GB2312 (assets/fonts). The Latin faces above have no CJK glyphs,
  // so any text containing Chinese switches to these families as a whole (see cjk.ts).
  cjkSerif: "NotoSerifSC-Regular",
  cjkSerifBold: "NotoSerifSC-Bold",
  cjkSans: "NotoSansSC-Regular",
  cjkSansMed: "NotoSansSC-Medium",
  cjkSansBold: "NotoSansSC-Bold",
} as const;

export const FONT_FILES = {
  "InstrumentSerif-Regular": require("../../assets/fonts/InstrumentSerif-Regular.ttf"),
  "InstrumentSerif-Italic": require("../../assets/fonts/InstrumentSerif-Italic.ttf"),
  "SpaceGrotesk-Regular": require("../../assets/fonts/SpaceGrotesk-Regular.ttf"),
  "SpaceGrotesk-Medium": require("../../assets/fonts/SpaceGrotesk-Medium.ttf"),
  "SpaceGrotesk-Bold": require("../../assets/fonts/SpaceGrotesk-Bold.ttf"),
  "JetBrainsMono-Regular": require("../../assets/fonts/JetBrainsMono-Regular.ttf"),
  "JetBrainsMono-Bold": require("../../assets/fonts/JetBrainsMono-Bold.ttf"),
  "NotoSerifSC-Regular": require("../../assets/fonts/NotoSerifSC-Regular.otf"),
  "NotoSerifSC-Bold": require("../../assets/fonts/NotoSerifSC-Bold.otf"),
  "NotoSansSC-Regular": require("../../assets/fonts/NotoSansSC-Regular.otf"),
  "NotoSansSC-Medium": require("../../assets/fonts/NotoSansSC-Medium.otf"),
  "NotoSansSC-Bold": require("../../assets/fonts/NotoSansSC-Bold.otf"),
};

/** Left margin of the page grid; the index column sits inside it. */
export const MARGIN = 20;
export const GUTTER = 34;

export type Status = "running" | "waiting_ui" | "idle";
export const STATUS_WORD: Record<Status, string> = { running: "working", waiting_ui: "needs you", idle: "idle" };
export function statusColor(p: Palette, s: Status): string {
  return s === "waiting_ui" ? p.pink : s === "running" ? p.blue : p.soft;
}

/** Thinking levels from none to maximum; each has its own colour so the setting reads at a glance. */
export const THINK_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const THINK_LIGHT = ["#8A857B", "#2B8FA8", "#178A4C", "#2346F5", "#7B3FE4", "#E5700F"];
const THINK_DARK = ["#8A857B", "#4CBAD6", "#4CC584", "#7088FF", "#A98BFF", "#FF9A3D"];
export function thinkIndex(level: string): number {
  const i = THINK_LEVELS.indexOf(level as (typeof THINK_LEVELS)[number]);
  return i < 0 ? 0 : i;
}
export function thinkColor(p: Palette, level: string): string {
  return (p.scheme === "light" ? THINK_LIGHT : THINK_DARK)[thinkIndex(level)]!;
}
