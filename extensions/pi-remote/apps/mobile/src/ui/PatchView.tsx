import { ScrollView, Text, View } from "react-native";
import { usePalette } from "./theme";

export function PatchView({ patch, maxLines = 400 }: { patch: string; maxLines?: number }) {
  const c = usePalette();
  const lines = patch.split("\n").slice(0, maxLines);
  return (
    <ScrollView horizontal accessibilityLabel="patch-view" style={{ backgroundColor: c.code, borderRadius: 6 }}>
      <View style={{ padding: 6 }}>
        {lines.map((l, i) => {
          const bg = l.startsWith("+") && !l.startsWith("+++") ? c.diffAdd : l.startsWith("-") && !l.startsWith("---") ? c.diffDel : "transparent";
          const color = l.startsWith("@@") ? c.diffHunk : c.text;
          return <Text key={i} style={{ fontFamily: "monospace", fontSize: 12, backgroundColor: bg, color }}>{l || " "}</Text>;
        })}
      </View>
    </ScrollView>
  );
}
