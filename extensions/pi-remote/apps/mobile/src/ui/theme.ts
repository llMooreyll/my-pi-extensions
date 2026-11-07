import { useColorScheme } from "react-native";

export interface Palette {
  bg: string; card: string; cardAlt: string; border: string; text: string; dim: string; accent: string; accentText: string;
  ok: string; warn: string; danger: string; userBubble: string; code: string; diffAdd: string; diffDel: string; diffHunk: string;
}

const dark: Palette = {
  bg: "#14161c", card: "#1e2129", cardAlt: "#262a34", border: "#333846", text: "#e6e8ee", dim: "#9097a6", accent: "#5b9cff", accentText: "#ffffff",
  ok: "#46c37b", warn: "#e6a23c", danger: "#ef5350", userBubble: "#2b3f66", code: "#191b22", diffAdd: "#1f3d2a", diffDel: "#4a2228", diffHunk: "#6ea8ff",
};
const light: Palette = {
  bg: "#f5f6f8", card: "#ffffff", cardAlt: "#eef0f4", border: "#d9dce3", text: "#1b1e25", dim: "#646b78", accent: "#2f6fe0", accentText: "#ffffff",
  ok: "#2e9d5f", warn: "#c27c0e", danger: "#d93a37", userBubble: "#dbe7ff", code: "#f0f2f6", diffAdd: "#dcf5e3", diffDel: "#fbe0e2", diffHunk: "#2f6fe0",
};

export function usePalette(): Palette {
  return useColorScheme() === "light" ? light : dark;
}

export const mono = "monospace";
