import type { TextStyle } from "react-native";
import { F } from "./tokens";

const CJK = /[\u2E80-\u2FFF\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

export const hasCJK = (s: string): boolean => CJK.test(s);

/** Plain text of simple children (strings, numbers, arrays of those); nested elements are ignored. */
export function childText(children: unknown): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(childText).join("");
  return "";
}

/**
 * Chinese counterpart of each Latin role. Chinese needs more leading (~1.65–1.75), no letter-spacing,
 * no italics and no all-caps; contrast comes from Song (serif) against Hei (sans) and from weight.
 */
export const CJK_ROLE: Record<string, TextStyle> = {
  display: { fontFamily: F.cjkSerifBold, fontSize: 38, lineHeight: 50, letterSpacing: 0 },
  headline: { fontFamily: F.cjkSerifBold, fontSize: 26, lineHeight: 36, letterSpacing: 0 },
  title: { fontFamily: F.cjkSerifBold, fontSize: 19.5, lineHeight: 29, letterSpacing: 0.2 },
  em: { fontFamily: F.cjkSerif, fontSize: 17.5, lineHeight: 30, letterSpacing: 0.3 },
  lead: { fontFamily: F.cjkSansMed, fontSize: 16, lineHeight: 26 },
  body: { fontFamily: F.cjkSans, fontSize: 15.5, lineHeight: 27, letterSpacing: 0.2 },
  bodyBold: { fontFamily: F.cjkSansBold, fontSize: 15.5, lineHeight: 27, letterSpacing: 0.2 },
  label: { fontFamily: F.cjkSansMed, fontSize: 11.5, lineHeight: 16, letterSpacing: 0.4, textTransform: "none" },
  small: { fontFamily: F.cjkSans, fontSize: 13, lineHeight: 21 },
  mono: {},
};
