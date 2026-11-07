import { type ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, View } from "react-native";
import { T } from "./kit";
import { usePalette } from "./theme";

/** Bottom sheet built on RN's Modal. */
export function Sheet(props: { visible: boolean; title: string; onClose: () => void; children: ReactNode; a11y: string; scroll?: boolean; footer?: ReactNode }) {
  const c = usePalette();
  return (
    <Modal transparent visible={props.visible} animationType="slide" onRequestClose={props.onClose}>
      <KeyboardAvoidingView behavior="height" style={{ flex: 1 }}>
        <Pressable accessibilityLabel={`${props.a11y}-backdrop`} style={{ flex: 1, backgroundColor: "#0007" }} onPress={props.onClose} />
        <View accessibilityLabel={props.a11y} style={{ backgroundColor: c.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: "85%", paddingBottom: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14, borderBottomWidth: 1, borderBottomColor: c.border }}>
            <T bold size={17}>{props.title}</T>
            <Pressable accessibilityRole="button" accessibilityLabel={`${props.a11y}-close`} onPress={props.onClose} hitSlop={12}><T dim size={18}>✕</T></Pressable>
          </View>
          {props.scroll === false ? props.children : (
            <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }} keyboardShouldPersistTaps="handled">{props.children}</ScrollView>
          )}
          {props.footer ? <View style={{ paddingHorizontal: 14, paddingTop: 8 }}>{props.footer}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function Option(props: { label: string; sub?: string; selected?: boolean; onPress: () => void; a11y: string; disabled?: boolean; bold?: boolean; indent?: number }) {
  const c = usePalette();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.a11y} disabled={props.disabled} onPress={props.onPress}
      style={({ pressed }) => ({ padding: 10, marginLeft: (props.indent ?? 0) * 12, borderRadius: 8, backgroundColor: props.selected ? c.accent + "33" : pressed ? c.cardAlt : "transparent", opacity: props.disabled ? 0.5 : 1, flexDirection: "row", gap: 8 })}>
      <View style={{ flex: 1 }}>
        <T bold={props.bold || props.selected}>{props.label}</T>
        {props.sub ? <T dim size={12}>{props.sub}</T> : null}
      </View>
      {props.selected ? <T color={c.accent}>✓</T> : null}
    </Pressable>
  );
}
