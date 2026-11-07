import { router } from "expo-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Animated, Easing, KeyboardAvoidingView, Modal, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions,
  type StyleProp, type TextInputProps, type TextStyle, type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TEST_HOOKS, useTestAction, useTestInput } from "../lib/test-hooks";
import { CJK_ROLE, childText, hasCJK } from "./cjk";
import { F, GUTTER, MARGIN, STATUS_WORD, statusColor, usePalette, type Status } from "./tokens";

/* ───────────────────────────── type ───────────────────────────── */

export type TxtVariant = "display" | "headline" | "title" | "em" | "lead" | "body" | "bodyBold" | "label" | "mono" | "small";

const VARIANT: Record<TxtVariant, TextStyle> = {
  display: { fontFamily: F.serif, fontSize: 52, lineHeight: 52, letterSpacing: -1.5 },
  headline: { fontFamily: F.serif, fontSize: 34, lineHeight: 36, letterSpacing: -0.6 },
  title: { fontFamily: F.serif, fontSize: 25, lineHeight: 28, letterSpacing: -0.3 },
  em: { fontFamily: F.serifItalic, fontSize: 21, lineHeight: 25 },
  lead: { fontFamily: F.sansMed, fontSize: 17, lineHeight: 23 },
  body: { fontFamily: F.sans, fontSize: 15.5, lineHeight: 23 },
  bodyBold: { fontFamily: F.sansBold, fontSize: 15.5, lineHeight: 22 },
  label: { fontFamily: F.mono, fontSize: 10.5, lineHeight: 14, letterSpacing: 1.4, textTransform: "uppercase" },
  mono: { fontFamily: F.mono, fontSize: 12.5, lineHeight: 18 },
  small: { fontFamily: F.sans, fontSize: 13, lineHeight: 18 },
};

export function Txt(props: {
  children: ReactNode; v?: TxtVariant; color?: string; soft?: boolean; faint?: boolean; style?: StyleProp<TextStyle>;
  lines?: number; a11y?: string; selectable?: boolean; center?: boolean; cjk?: TextStyle; fit?: number;
}) {
  const p = usePalette();
  const color = props.color ?? (props.faint ? p.faint : props.soft ? p.soft : p.ink);
  const v = props.v ?? "body";
  const cjk = v !== "mono" && hasCJK(childText(props.children)) ? { ...CJK_ROLE[v], ...props.cjk } : null;
  return (
    <Text accessibilityLabel={props.a11y} numberOfLines={props.lines} selectable={props.selectable}
      adjustsFontSizeToFit={props.fit !== undefined} minimumFontScale={props.fit}
      style={[VARIANT[v], { color }, props.center ? { textAlign: "center" } : null, props.style, cjk]}>
      {props.children}
    </Text>
  );
}

/* ───────────────────────────── structure ───────────────────────────── */

export function Rule(props: { color?: string; weight?: number; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  return <View style={[{ height: props.weight ?? 1, backgroundColor: props.color ?? p.ink }, props.style]} />;
}

/**
 * A line of the page: optional index in the margin column, content, optional trailing text.
 * Rows are separated by hairlines; there are no boxes anywhere.
 */
export function Row(props: {
  children: ReactNode; a11y?: string; onPress?: () => void; index?: string; indexColor?: string; trailing?: ReactNode;
  disabled?: boolean; first?: boolean; accent?: string; style?: StyleProp<ViewStyle>; dense?: boolean; indexStyle?: StyleProp<TextStyle>;
}) {
  const p = usePalette();
  useTestAction(props.a11y, props.onPress, !props.disabled);
  const content = (pressed: boolean) => (
    <View style={[{
      flexDirection: "row", alignItems: "baseline", paddingVertical: props.dense ? 10 : 15, paddingRight: MARGIN,
      borderTopWidth: props.first ? 1 : 0, borderBottomWidth: 1, borderColor: p.faint,
      backgroundColor: pressed ? p.tint : "transparent", opacity: props.disabled ? 0.4 : 1,
    }, props.style]}>
      <View style={{ width: GUTTER + MARGIN, paddingLeft: MARGIN }}>
        {props.accent ? <View style={{ position: "absolute", left: 0, top: -15, bottom: -15, width: 3, backgroundColor: props.accent }} /> : null}
        {props.index ? <Txt v="label" color={props.indexColor ?? p.soft} style={props.indexStyle}>{props.index}</Txt> : null}
      </View>
      <View style={{ flex: 1, gap: 3 }}>{props.children}</View>
      {props.trailing ? <View style={{ paddingLeft: 10, alignItems: "flex-end" }}>{props.trailing}</View> : null}
    </View>
  );
  if (!props.onPress) return <View accessibilityLabel={props.a11y}>{content(false)}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.a11y} onPress={props.onPress} disabled={props.disabled}>
      {({ pressed }) => content(pressed)}
    </Pressable>
  );
}

/** "01  Live on computer ............ 4" — mono number, italic serif title, hairline. */
export function SectionHead(props: { n: string; title: string; right?: ReactNode; color?: string; a11y?: string }) {
  const p = usePalette();
  const col = props.color ?? p.ink;
  return (
    <View accessibilityLabel={props.a11y} style={{ marginTop: 34, paddingHorizontal: MARGIN }}>
      <View style={{ flexDirection: "row", alignItems: "baseline" }}>
        <Txt v="label" color={col} style={{ width: GUTTER }}>{props.n}</Txt>
        <Txt v="em" color={col} style={{ flex: 1 }}>{props.title}</Txt>
        {props.right}
      </View>
      <Rule color={col} style={{ marginTop: 8 }} />
    </View>
  );
}

export function StatusText(props: { status: Status; count?: number; a11y?: string }) {
  const p = usePalette();
  return (
    <Txt v="label" color={statusColor(p, props.status)} a11y={props.a11y} style={{ fontFamily: props.status === "idle" ? F.mono : F.monoBold, fontSize: 11.5 }}>
      {props.status === "idle" ? "○" : props.status === "running" ? "▶" : "◆"} {STATUS_WORD[props.status]}{props.count && props.count > 1 ? ` · ${props.count}` : ""}
    </Txt>
  );
}

/* ───────────────────────────── actions ───────────────────────────── */

/**
 * Four kinds of action, by weight:
 * "solid":   flat ink bar, label left, arrow right — the one primary thing on a screen.
 * "danger":  the same bar in red, for things that cannot be undone or that cut the connection.
 * "outline": a ruled box with a mono label — secondary actions that still need to look pressable.
 * "text":    an underlined mono word — tertiary, low-stakes actions.
 */
export function Button(props: {
  label: string; a11y: string; onPress: () => void; kind?: "solid" | "danger" | "outline" | "text"; color?: string; disabled?: boolean; busy?: boolean;
  arrow?: string; style?: StyleProp<ViewStyle>; compact?: boolean;
}) {
  const p = usePalette();
  const kind = props.kind ?? "text";
  useTestAction(props.a11y, props.onPress, !props.disabled && !props.busy);
  if (kind === "text") {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={props.a11y} onPress={props.onPress} disabled={props.disabled || props.busy} hitSlop={10} style={props.style}>
        {({ pressed }) => (
          <Txt v="label" color={props.color ?? p.ink} style={{ textDecorationLine: "underline", opacity: props.disabled ? 0.35 : pressed ? 0.5 : 1 }}>
            {props.busy ? "…" : props.label}
          </Txt>
        )}
      </Pressable>
    );
  }
  if (kind === "outline") {
    const col = props.color ?? p.ink;
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={props.a11y} onPress={props.onPress} disabled={props.disabled || props.busy} hitSlop={6} style={props.style}>
        {({ pressed }) => (
          <View style={{ borderWidth: 1.5, borderColor: col, paddingHorizontal: 11, paddingVertical: props.compact ? 5 : 8, backgroundColor: pressed ? p.tint : "transparent", opacity: props.disabled ? 0.35 : 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 }}>
            {props.busy ? <Spinner color={col} /> : null}
            <Txt v="label" color={col} style={{ fontFamily: F.monoBold }}>{props.label}</Txt>
          </View>
        )}
      </Pressable>
    );
  }
  const bg = kind === "danger" ? p.danger : props.color ?? p.ink;
  const fg = kind === "danger" ? "#FFFFFF" : p.invert;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.a11y} onPress={props.onPress} disabled={props.disabled || props.busy} style={props.style}>
      {({ pressed }) => (
        <View style={{ backgroundColor: bg, opacity: props.disabled ? 0.3 : pressed ? 0.82 : 1, flexDirection: "row", alignItems: "center", paddingHorizontal: 18, paddingVertical: props.compact ? 11 : 16 }}>
          <Txt v="bodyBold" color={fg} style={{ flex: 1, fontSize: props.compact ? 14.5 : 16 }}>{props.label}</Txt>
          {props.busy ? <Spinner color={fg} /> : <Txt v="lead" color={fg}>{props.arrow ?? "→"}</Txt>}
        </View>
      )}
    </Pressable>
  );
}

/* ───────────────────────────── inputs ───────────────────────────── */

/** Underline-only input; the label sits above in mono. */
export function Field(props: TextInputProps & { a11y: string; value: string; onChangeText: (t: string) => void; mono?: boolean; label?: string }) {
  const p = usePalette();
  const [focus, setFocus] = useState(false);
  useTestInput(props.a11y, props.onChangeText);
  const { a11y, style, mono, label, ...rest } = props;
  return (
    <View style={{ gap: 4 }}>
      {label ? <Txt v="label" soft>{label}</Txt> : null}
      <TextInput
        accessibilityLabel={a11y}
        placeholderTextColor={p.faint}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        {...rest}
        style={[{
          color: p.ink, borderBottomWidth: focus ? 2 : 1, borderBottomColor: focus ? p.ink : p.soft, paddingVertical: 8, paddingHorizontal: 0,
          fontFamily: mono ? F.mono : F.cjkSans, fontSize: mono ? 13.5 : 16,
        }, style]}
      />
    </View>
  );
}

/** A labelled switch: two ruled cells, the active one filled with ink. */
export function Toggle(props: { value: boolean; onChange: (v: boolean) => void; a11y: string; label: string; hint?: string; unset?: boolean }) {
  const p = usePalette();
  const flip = () => props.onChange(!props.value);
  useTestAction(props.a11y, flip);
  const cell = (on: boolean, text: string) => (
    <View style={{ paddingHorizontal: 9, paddingVertical: 4, backgroundColor: on && !props.unset ? (props.value ? p.ok : p.ink) : "transparent" }}>
      <Txt v="label" color={props.unset ? p.soft : on ? "#FFFFFF" : p.faint} style={{ fontFamily: on && !props.unset ? F.monoBold : F.mono }}>{text}</Txt>
    </View>
  );
  return (
    <Pressable accessibilityRole="switch" accessibilityState={{ checked: props.value }} accessibilityLabel={props.a11y} onPress={flip}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: p.faint, gap: 14, backgroundColor: pressed ? p.tint : "transparent" })}>
      <View style={{ flex: 1 }}>
        <Txt v="body">{props.label}</Txt>
        {props.hint ? <Txt v="small" soft>{props.hint}</Txt> : null}
      </View>
      {props.unset ? <Txt v="label" soft>default</Txt> : null}
      <View style={{ flexDirection: "row", borderWidth: 1, borderColor: props.unset ? p.faint : p.ink }}>
        {cell(props.value, "on")}
        {cell(!props.value, "off")}
      </View>
    </Pressable>
  );
}

/** A choice in a list: pink arrow marks the current one. */
export function Choice(props: { label: string; sub?: string; selected?: boolean; onPress: () => void; a11y: string; disabled?: boolean; indent?: number; strong?: boolean }) {
  const p = usePalette();
  useTestAction(props.a11y, props.onPress, !props.disabled);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.a11y} disabled={props.disabled} onPress={props.onPress}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "baseline", paddingVertical: 12, paddingLeft: (props.indent ?? 0) * 14, borderBottomWidth: 1, borderBottomColor: p.faint, backgroundColor: pressed ? p.tint : "transparent", opacity: props.disabled ? 0.4 : 1 })}>
      <Txt v="lead" color={props.selected ? p.pink : p.faint} style={{ width: 24 }}>{props.selected ? "→" : "·"}</Txt>
      <View style={{ flex: 1 }}>
        <Txt v={props.selected || props.strong ? "bodyBold" : "body"} lines={3}>{props.label}</Txt>
        {props.sub ? <Txt v="mono" soft lines={2} style={{ fontSize: 11 }}>{props.sub}</Txt> : null}
      </View>
    </Pressable>
  );
}

/* ───────────────────────────── feedback ───────────────────────────── */

/**
 * Three dots that light in turn, drawn as fixed-size views. A text spinner changed width from frame to frame,
 * wrapped in narrow columns and made whole lists jump; this one never changes its box.
 * Test builds keep it still: uiautomator cannot dump a window that animates forever.
 */
export function Spinner(props: { color?: string }) {
  const p = usePalette();
  const [i, setI] = useState(0);
  useEffect(() => {
    if (TEST_HOOKS) return;
    const t = setInterval(() => setI((x) => (x + 1) % 4), 220);
    return () => clearInterval(t);
  }, []);
  const color = props.color ?? p.ink;
  return (
    <View accessibilityLabel="spinner" style={{ width: 16, height: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      {[0, 1, 2].map((k) => (
        <View key={k} style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: color, opacity: TEST_HOOKS || i === k ? 1 : 0.25 }} />
      ))}
    </View>
  );
}

/* ───────────────────────────── pages ───────────────────────────── */

export function Screen(props: {
  children: ReactNode; title?: string; kicker?: string; back?: boolean; right?: ReactNode; scroll?: boolean;
  footer?: ReactNode; titleNode?: ReactNode; onTitlePress?: () => void; a11yTitle?: string; ruleColor?: string;
}) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const goBack = () => (router.canGoBack() ? router.back() : router.replace("/"));
  useTestAction("nav-back", props.back ? goBack : undefined);
  useTestAction(props.a11yTitle, props.onTitlePress);
  return (
    <View style={{ flex: 1, backgroundColor: p.paper }}>
      <View style={{ paddingTop: insets.top + 10, paddingHorizontal: MARGIN, paddingBottom: 12, flexDirection: "row", alignItems: "center", gap: 12 }}>
        {props.back ? (
          <Pressable accessibilityRole="button" accessibilityLabel="nav-back" hitSlop={14} onPress={goBack} style={{ width: GUTTER - 12 }}>
            <Txt v="title">←</Txt>
          </Pressable>
        ) : null}
        <Pressable style={{ flex: 1 }} accessibilityRole={props.onTitlePress ? "button" : undefined} accessibilityLabel={props.a11yTitle} onPress={props.onTitlePress} disabled={!props.onTitlePress}>
          {props.titleNode ?? (
            <>
              {props.kicker ? <Txt v="label" soft>{props.kicker}</Txt> : null}
              {props.title ? <Txt v="title" lines={2}>{props.title}</Txt> : null}
            </>
          )}
        </Pressable>
        {props.right}
      </View>
      <Rule weight={props.ruleColor ? 4 : 2} color={props.ruleColor} />
      {props.scroll === false ? <View style={{ flex: 1 }}>{props.children}</View> : (
        <ScrollView contentContainerStyle={{ paddingBottom: 48 + insets.bottom }} keyboardShouldPersistTaps="handled">{props.children}</ScrollView>
      )}
      {props.footer ? <View style={{ paddingBottom: insets.bottom, backgroundColor: p.paper }}>{props.footer}</View> : null}
    </View>
  );
}

/** Padding wrapper aligned to the page grid. */
export function Pad(props: { children: ReactNode; style?: StyleProp<ViewStyle>; indent?: boolean }) {
  return <View style={[{ paddingHorizontal: MARGIN, paddingLeft: props.indent ? MARGIN + GUTTER : MARGIN }, props.style]}>{props.children}</View>;
}

/**
 * A page that slides up over the current one. The dimmed backdrop fades in place; only the paper moves.
 * Thick top rule, serif title, "close" as a word.
 */
export function Sheet(props: { visible: boolean; title: string; kicker?: string; onClose: () => void; children: ReactNode; a11y: string; footer?: ReactNode; scroll?: boolean }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [mounted, setMounted] = useState(props.visible);
  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(height)).current;
  useTestAction(`${props.a11y}-close`, props.visible ? props.onClose : undefined);
  useEffect(() => {
    if (props.visible) {
      setMounted(true);
      Animated.parallel([
        Animated.timing(fade, { toValue: 1, duration: 180, useNativeDriver: true }),
        Animated.timing(slide, { toValue: 0, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]).start();
    } else if (mounted) {
      Animated.parallel([
        Animated.timing(fade, { toValue: 0, duration: 160, useNativeDriver: true }),
        Animated.timing(slide, { toValue: height, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
      ]).start(() => setMounted(false));
    }
  }, [props.visible]);
  if (!mounted) return null;
  return (
    <Modal transparent visible animationType="none" onRequestClose={props.onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior="height" style={{ flex: 1 }}>
        <Animated.View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, opacity: fade, backgroundColor: p.scheme === "light" ? "#14141355" : "#000000A0" }}>
          <Pressable accessibilityLabel={`${props.a11y}-backdrop`} style={{ flex: 1 }} onPress={props.onClose} />
        </Animated.View>
        <View style={{ flex: 1 }} pointerEvents="box-none" />
        <Animated.View accessibilityLabel={props.a11y} style={{ backgroundColor: p.paper, maxHeight: "90%", paddingBottom: 12 + insets.bottom, transform: [{ translateY: slide }] }}>
          <Rule weight={4} />
          <View style={{ flexDirection: "row", alignItems: "flex-end", paddingHorizontal: MARGIN, paddingTop: 16, paddingBottom: 12 }}>
            <View style={{ flex: 1 }}>
              {props.kicker ? <Txt v="label" soft>{props.kicker}</Txt> : null}
              <Txt v="headline">{props.title}</Txt>
            </View>
            <Button a11y={`${props.a11y}-close`} label="close" onPress={props.onClose} />
          </View>
          <Rule />
          {props.scroll === false ? props.children : (
            <ScrollView contentContainerStyle={{ paddingHorizontal: MARGIN, paddingBottom: 12 }} keyboardShouldPersistTaps="handled">{props.children}</ScrollView>
          )}
          {props.footer ? <View style={{ paddingHorizontal: MARGIN, paddingTop: 12 }}>{props.footer}</View> : null}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Centered notice: a sheet of paper between two heavy rules. */
export function Dialog(props: { visible: boolean; title: string; children?: ReactNode; onClose: () => void; a11y: string; color?: string; actions?: ReactNode }) {
  const p = usePalette();
  return (
    <Modal transparent visible={props.visible} animationType="fade" onRequestClose={props.onClose}>
      <Pressable style={{ flex: 1, backgroundColor: p.scheme === "light" ? "#14141366" : "#000000B8", justifyContent: "center" }} onPress={props.onClose}>
        <Pressable onPress={() => {}} accessibilityLabel={props.a11y} style={{ backgroundColor: p.paper }}>
          <Rule weight={4} color={props.color ?? p.ink} />
          <View style={{ paddingHorizontal: MARGIN, paddingVertical: 20, gap: 14 }}>
            <Txt v="headline" color={props.color ?? p.ink}>{props.title}</Txt>
            {props.children}
            {props.actions ? <View style={{ gap: 12 }}>{props.actions}</View> : null}
          </View>
          <Rule weight={4} color={props.color ?? p.ink} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
