import { Pressable, ScrollView, View } from "react-native";
import type { ProcessInfo } from "@pi-remote/protocol";
import { openProcess } from "../lib/nav";
import { useTestAction } from "../lib/test-hooks";
import { T } from "./kit";
import { usePalette } from "./theme";

export function ChildStrip({ children }: { children: ProcessInfo[] }) {
  if (!children.length) return null;
  return (
    <ScrollView horizontal accessibilityLabel="child-strip" contentContainerStyle={{ gap: 6, paddingHorizontal: 10, paddingVertical: 6 }} style={{ flexGrow: 0 }}>
      {children.map((p) => <ChildChip key={p.processId} p={p} />)}
    </ScrollView>
  );
}

function ChildChip({ p }: { p: ProcessInfo }) {
  const c = usePalette();
  const open = () => openProcess(p.processId);
  useTestAction(`child-${p.processId}`, open);
  const dot = p.status === "running" ? c.accent : p.status === "waiting_ui" ? c.warn : c.dim;
  const name = p.role.kind === "main" ? "pi" : p.role.name;
  const kind = p.role.kind === "subagent" ? "Subagent" : p.role.kind === "team_member" ? "Member" : "Process";
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`child-${p.processId}`} onPress={open}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: c.cardAlt, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: c.border }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
      <T size={13} bold>{name}</T>
      <T size={11} dim>{kind}</T>
    </Pressable>
  );
}
