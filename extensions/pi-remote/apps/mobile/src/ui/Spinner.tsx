import { ActivityIndicator, Text, type StyleProp, type ViewStyle } from "react-native";
import { TEST_HOOKS } from "../lib/test-hooks";

/**
 * ActivityIndicator, except in test builds: uiautomator cannot dump a window while an endless animation runs,
 * so test builds show a static marker instead.
 */
export function Spinner(props: { size?: "small" | "large"; color?: string; style?: StyleProp<ViewStyle> }) {
  if (TEST_HOOKS) return <Text accessibilityLabel="spinner" style={{ color: props.color ?? "#888" }}>…</Text>;
  return <ActivityIndicator size={props.size} color={props.color} style={props.style} />;
}
