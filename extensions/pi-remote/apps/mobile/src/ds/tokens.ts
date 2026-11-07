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
  danger: string;
  addBg: string; delBg: string;
}

const light: Palette = {
  scheme: "light", paper: "#F3F0E9", tint: "#E7E2D7", ink: "#141413", soft: "#67625A", faint: "#C9C3B6", invert: "#F3F0E9",
  pink: "#F2287F", blue: "#2346F5", danger: "#E2381B", addBg: "#DCEFCB", delBg: "#F9D5DF",
};
const dark: Palette = {
  scheme: "dark", paper: "#0F0F0E", tint: "#1C1C1A", ink: "#EFEBE2", soft: "#97928A", faint: "#33322F", invert: "#0F0F0E",
  pink: "#FF4C9B", blue: "#7088FF", danger: "#FF6B47", addBg: "#1D3216", delBg: "#3E1424",
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
} as const;

export const FONT_FILES = {
  "InstrumentSerif-Regular": require("../../assets/fonts/InstrumentSerif-Regular.ttf"),
  "InstrumentSerif-Italic": require("../../assets/fonts/InstrumentSerif-Italic.ttf"),
  "SpaceGrotesk-Regular": require("../../assets/fonts/SpaceGrotesk-Regular.ttf"),
  "SpaceGrotesk-Medium": require("../../assets/fonts/SpaceGrotesk-Medium.ttf"),
  "SpaceGrotesk-Bold": require("../../assets/fonts/SpaceGrotesk-Bold.ttf"),
  "JetBrainsMono-Regular": require("../../assets/fonts/JetBrainsMono-Regular.ttf"),
  "JetBrainsMono-Bold": require("../../assets/fonts/JetBrainsMono-Bold.ttf"),
};

/** Left margin of the page grid; the index column sits inside it. */
export const MARGIN = 20;
export const GUTTER = 34;

export type Status = "running" | "waiting_ui" | "idle";
export const STATUS_WORD: Record<Status, string> = { running: "working", waiting_ui: "needs you", idle: "idle" };
export function statusColor(p: Palette, s: Status): string {
  return s === "waiting_ui" ? p.pink : s === "running" ? p.blue : p.soft;
}
