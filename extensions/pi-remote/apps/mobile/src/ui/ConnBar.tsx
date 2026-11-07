import { Pressable, View } from "react-native";
import { router } from "expo-router";
import { useStore } from "../state/store";
import { T } from "./kit";
import { usePalette } from "./theme";

export function ConnBar() {
  const c = usePalette();
  const conn = useStore((s) => s.conn);
  const via = useStore((s) => s.via);
  const lastError = useStore((s) => s.lastError);
  const hostName = useStore((s) => s.hostName ?? s.host?.endpoint.hostName);
  const color = conn === "ready" ? c.ok : conn === "no_credentials" ? c.danger : c.warn;
  const label = conn === "ready" ? `Connected to ${hostName ?? "computer"}` : conn === "connecting" ? "Connecting…" : conn === "backoff" ? "Reconnecting…" : "Not paired";
  return (
    <Pressable accessibilityLabel="conn-bar" onPress={() => conn === "no_credentials" && router.push("/pair")}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: color + "22", borderRadius: 8 }}>
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />
      <View style={{ flex: 1 }}>
        <T size={14} bold a11y="conn-state">{label}</T>
        {conn === "ready" ? <T size={12} dim a11y="conn-via">{via === "direct" ? "Direct" : "Via relay"}</T> : null}
        {conn !== "ready" && lastError ? <T size={12} dim numberOfLines={2} a11y="conn-error">{lastError}</T> : null}
      </View>
    </Pressable>
  );
}
