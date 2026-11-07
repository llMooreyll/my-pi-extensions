import { ScrollView, Text, View } from "react-native";
import { F, usePalette } from "../ds/tokens";

export function PatchView({ patch, maxLines = 400 }: { patch: string; maxLines?: number }) {
  const p = usePalette();
  const lines = patch.split("\n").slice(0, maxLines);
  return (
    <ScrollView horizontal accessibilityLabel="patch-view" style={{ backgroundColor: p.tint }}>
      <View style={{ paddingVertical: 6 }}>
        {lines.map((l, i) => {
          const add = l.startsWith("+") && !l.startsWith("+++");
          const del = l.startsWith("-") && !l.startsWith("---");
          const hunk = l.startsWith("@@");
          return (
            <Text key={i} style={{ fontFamily: F.mono, fontSize: 12, lineHeight: 17, paddingHorizontal: 8, backgroundColor: add ? p.addBg : del ? p.delBg : "transparent", color: hunk ? p.blue : p.ink }}>
              {l || " "}
            </Text>
          );
        })}
      </View>
    </ScrollView>
  );
}
