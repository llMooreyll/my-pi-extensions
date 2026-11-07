import { Spinner } from "./Spinner";
import { type ReactNode } from "react";
import { Pressable, Text, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from "react-native";
import { useTestAction, useTestInput } from "../lib/test-hooks";
import { usePalette } from "./theme";

export function Btn(props: { label: string; onPress: () => void; a11y: string; kind?: "primary" | "plain" | "danger"; disabled?: boolean; busy?: boolean; small?: boolean; style?: StyleProp<ViewStyle> }) {
  const c = usePalette();
  const kind = props.kind ?? "plain";
  const bg = kind === "primary" ? c.accent : kind === "danger" ? c.danger : c.cardAlt;
  const fg = kind === "plain" ? c.text : c.accentText;
  useTestAction(props.a11y, props.onPress, !props.disabled && !props.busy);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.a11y}
      disabled={props.disabled || props.busy}
      onPress={props.onPress}
      style={({ pressed }) => [{
        backgroundColor: bg, opacity: props.disabled ? 0.45 : pressed ? 0.75 : 1,
        paddingHorizontal: props.small ? 10 : 14, paddingVertical: props.small ? 6 : 10, borderRadius: 8,
        flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
      }, props.style]}
    >
      {props.busy ? <Spinner size="small" color={fg} /> : null}
      <Text style={{ color: fg, fontWeight: "600", fontSize: props.small ? 13 : 15 }}>{props.label}</Text>
    </Pressable>
  );
}

export function Field(props: TextInputProps & { a11y: string; value: string; onChangeText: (t: string) => void }) {
  const c = usePalette();
  useTestInput(props.a11y, props.onChangeText);
  const { a11y, style, ...rest } = props;
  return (
    <TextInput
      accessibilityLabel={a11y}
      placeholderTextColor={c.dim}
      {...rest}
      style={[{ backgroundColor: c.cardAlt, color: c.text, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, borderWidth: 1, borderColor: c.border }, style]}
    />
  );
}

export function Card(props: { children: ReactNode; style?: StyleProp<ViewStyle>; a11y?: string; onPress?: () => void }) {
  const c = usePalette();
  useTestAction(props.a11y, props.onPress);
  const st = [{ backgroundColor: c.card, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: c.border }, props.style];
  if (props.onPress) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={props.a11y} onPress={props.onPress} style={({ pressed }) => [st, { opacity: pressed ? 0.8 : 1 }]}>
        {props.children}
      </Pressable>
    );
  }
  return <View accessibilityLabel={props.a11y} style={st}>{props.children}</View>;
}

export function T(props: { children: ReactNode; dim?: boolean; size?: number; bold?: boolean; color?: string; mono?: boolean; style?: StyleProp<TextStyle>; numberOfLines?: number; a11y?: string; selectable?: boolean }) {
  const c = usePalette();
  return (
    <Text
      accessibilityLabel={props.a11y}
      numberOfLines={props.numberOfLines}
      selectable={props.selectable}
      style={[{ color: props.color ?? (props.dim ? c.dim : c.text), fontSize: props.size ?? 15, fontWeight: props.bold ? "700" : "400", fontFamily: props.mono ? "monospace" : undefined }, props.style]}
    >
      {props.children}
    </Text>
  );
}

export function Badge(props: { label: string; color: string; a11y?: string }) {
  return (
    <View accessibilityLabel={props.a11y} style={{ borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, backgroundColor: props.color + "33", borderWidth: 1, borderColor: props.color }}>
      <Text style={{ color: props.color, fontSize: 11, fontWeight: "600" }}>{props.label}</Text>
    </View>
  );
}

export function Section(props: { title: string; children: ReactNode; right?: ReactNode }) {
  const c = usePalette();
  return (
    <View style={{ marginTop: 16, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 2 }}>
        <Text style={{ color: c.dim, fontSize: 13, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 }}>{props.title}</Text>
        {props.right}
      </View>
      {props.children}
    </View>
  );
}
