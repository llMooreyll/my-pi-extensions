import { createContext, useContext } from "react";
import { Pressable, View } from "react-native";
import { Txt } from "../ds/primitives";
import { usePalette } from "../ds/tokens";
import { useTestAction } from "../lib/test-hooks";

/**
 * Which edge of a transcript row must stay put on screen when the row changes size.
 * The transcript reads top to bottom, so a row that changes size keeps its top edge by itself:
 * - "top": nothing to do; the row opens and closes downward (taps on a header, "show all").
 * - "bottom": the row's bottom edge stays; used by the fold control at the end of an opened row,
 *   so the reader is left looking at the folded row instead of the content that slid up under them.
 */
export type Anchor = "top" | "bottom";

export const AnchorContext = createContext<(a: Anchor) => void>(() => {});

/** Call before changing a row's size. */
export const useAnchor = () => useContext(AnchorContext);

/** The fold control printed at the end of anything opened in the transcript. */
export function FoldBar({ a11y, onFold, label = "fold" }: { a11y: string; onFold: () => void; label?: string }) {
  const p = usePalette();
  const anchor = useAnchor();
  const fold = () => { anchor("bottom"); onFold(); };
  useTestAction(a11y, fold);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={fold} hitSlop={8}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, opacity: pressed ? 0.5 : 1 })}>
      <View style={{ width: 14, height: 1, backgroundColor: p.soft }} />
      <Txt v="label" soft>− {label}</Txt>
    </Pressable>
  );
}
