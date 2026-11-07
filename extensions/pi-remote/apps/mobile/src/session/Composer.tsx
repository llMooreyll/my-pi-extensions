import * as ImagePicker from "expo-image-picker";
import { useMemo, useState } from "react";
import { Image, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CommandInfo, DeliverAs, ImageInput } from "@pi-remote/protocol";
import { Spinner, Txt } from "../ds/primitives";
import { F, MARGIN, usePalette } from "../ds/tokens";
import { BUILTIN_COMMANDS } from "../lib/slash";
import { testLog, useTestAction, useTestInput } from "../lib/test-hooks";

export interface ComposerProps {
  disabled: boolean;
  disabledReason?: string;
  running: boolean;
  imagesAllowed: boolean;
  commands: CommandInfo[];
  text: string;
  setText: (t: string) => void;
  onSend: (text: string, images: ImageInput[], deliverAs?: DeliverAs) => Promise<boolean>;
  onAbort: () => void;
  onOpenCommands: () => void;
}

function Suggestion({ s, onPick }: { s: { name: string; description?: string; source: string }; onPick: () => void }) {
  const p = usePalette();
  useTestAction(`slash-${s.name}`, onPick);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`slash-${s.name}`} onPress={onPick}
      style={({ pressed }) => ({ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: p.faint, backgroundColor: pressed ? p.tint : "transparent", flexDirection: "row", gap: 10 })}>
      <Txt v="mono" style={{ fontFamily: F.monoBold, minWidth: 90 }}>/{s.name}</Txt>
      <Txt v="small" soft lines={1} style={{ flex: 1 }}>{s.description ?? s.source}</Txt>
    </Pressable>
  );
}

/** The input grows line by line up to MAX_LINES, then scrolls inside. */
const LINE = 24;
const PAD_V = 15;
const LINE_BOX = LINE + PAD_V * 2;
const MAX_LINES = 8;
const MAX_H = LINE_BOX + LINE * (MAX_LINES - 1);
const WEB = Platform.OS === "web";

export function Composer(p: ComposerProps) {
  const c = usePalette();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<DeliverAs>("steer");
  const [images, setImages] = useState<(ImageInput & { uri: string })[]>([]);
  const [sending, setSending] = useState(false);
  const [webH, setWebH] = useState(LINE_BOX);
  const [hint, setHint] = useState<string | undefined>();
  useTestInput("composer-input", p.setText);

  const slashQuery = p.text.startsWith("/") && !p.text.includes(" ") ? p.text.slice(1).toLowerCase() : undefined;
  const suggestions = useMemo(() => {
    if (slashQuery === undefined) return [];
    const all = [...BUILTIN_COMMANDS.map((b) => ({ name: b.name, description: b.description, source: "builtin" })), ...p.commands];
    return all.filter((x) => x.name.toLowerCase().startsWith(slashQuery)).slice(0, 30);
  }, [slashQuery, p.commands]);

  const pick = async () => {
    if (!p.imagesAllowed) { setHint("This model cannot read images. Switch the model first."); return; }
    const r = await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.7, allowsMultipleSelection: true, selectionLimit: 4 - images.length, mediaTypes: ["images"] });
    if (r.canceled) return;
    const add = r.assets.filter((a) => a.base64).map((a) => ({ uri: a.uri, data: a.base64!, mimeType: a.mimeType ?? "image/jpeg" }));
    setImages((prev) => [...prev, ...add].slice(0, 4));
  };

  const send = async () => {
    testLog("send", { sending, disabled: p.disabled, len: p.text.length });
    if (sending || p.disabled) return;
    if (!p.text.trim() && !images.length) return;
    setSending(true);
    setHint(undefined);
    try {
      const ok = await p.onSend(p.text, images.map(({ data, mimeType }) => ({ data, mimeType })), p.running ? mode : undefined);
      if (ok) setImages([]);
    } finally { setSending(false); }
  };
  useTestAction("composer-send", p.disabled ? undefined : () => void send());
  useTestAction("composer-stop", p.running ? p.onAbort : undefined);
  useTestAction("composer-mode-steer", p.running ? () => setMode("steer") : undefined);
  useTestAction("composer-mode-followup", p.running ? () => setMode("followUp") : undefined);
  useTestAction("composer-commands", p.onOpenCommands);
  useTestAction("composer-image", p.disabled ? undefined : () => void pick());

  const canSend = !p.disabled && (!!p.text.trim() || images.length > 0);
  return (
    <View accessibilityLabel="composer" style={{ backgroundColor: c.paper, paddingBottom: insets.bottom }}>
      {p.running ? (
        // The run's own status line. Stopping acts on the run, so it lives here, apart from the message being written.
        <View accessibilityLabel="run-bar" style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: MARGIN, paddingRight: MARGIN, paddingVertical: 7, borderTopWidth: 1, borderTopColor: c.faint }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.blue }} />
          <Txt v="label" color={c.blue} style={{ fontFamily: F.monoBold }}>pi is working</Txt>
          <Spinner color={c.blue} />
          <View style={{ flex: 1 }} />
          <Pressable accessibilityRole="button" accessibilityLabel="composer-stop" onPress={p.onAbort} hitSlop={8}
            style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 7, borderWidth: 1.5, borderColor: c.danger, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: pressed ? c.danger : "transparent" })}>
            {({ pressed }) => (
              <>
                <View style={{ width: 8, height: 8, backgroundColor: pressed ? "#FFFFFF" : c.danger }} />
                <Txt v="label" color={pressed ? "#FFFFFF" : c.danger} style={{ fontFamily: F.monoBold }}>stop</Txt>
              </>
            )}
          </Pressable>
        </View>
      ) : null}
      <View style={{ height: 2, backgroundColor: p.running ? c.blue : c.ink }} />
      {suggestions.length ? (
        <ScrollView accessibilityLabel="slash-menu" style={{ maxHeight: 230, paddingHorizontal: MARGIN }} keyboardShouldPersistTaps="handled">
          {suggestions.map((s) => <Suggestion key={`${s.source}:${s.name}`} s={s} onPick={() => p.setText(`/${s.name} `)} />)}
        </ScrollView>
      ) : null}
      {p.running ? (
        // How the message being written reaches pi: a property of the message, so it sits with the composer.
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: MARGIN, paddingTop: 10 }}>
          <Txt v="label" soft>deliver</Txt>
          <View style={{ flexDirection: "row", gap: 6 }}>
            {(["steer", "followUp"] as const).map((m) => {
              const on = mode === m;
              const col = m === "steer" ? c.blue : c.ink;
              return (
                <Pressable key={m} accessibilityRole="button" accessibilityLabel={m === "steer" ? "composer-mode-steer" : "composer-mode-followup"} onPress={() => setMode(m)} hitSlop={4}
                  style={{ paddingHorizontal: 9, paddingVertical: 3, borderWidth: 1, borderColor: on ? col : c.faint, backgroundColor: on ? col : "transparent" }}>
                  <Txt v="label" color={on ? c.invert : c.soft} style={{ fontFamily: on ? F.monoBold : F.mono }}>{m === "steer" ? "now" : "after"}</Txt>
                </Pressable>
              );
            })}
          </View>
          <Txt v="small" soft lines={1} style={{ flex: 1, fontSize: 12 }}>{mode === "steer" ? "read at pi's next break" : "read when this run ends"}</Txt>
        </View>
      ) : null}
      {images.length ? (
        <ScrollView horizontal contentContainerStyle={{ gap: 10, paddingHorizontal: MARGIN, paddingTop: 10 }}>
          {images.map((im, i) => (
            <Pressable key={i} accessibilityLabel={`composer-image-${i}`} onPress={() => setImages(images.filter((_, j) => j !== i))} style={{ alignItems: "center" }}>
              <Image source={{ uri: im.uri }} style={{ width: 54, height: 54 }} />
              <Txt v="label" soft>remove</Txt>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {hint || p.disabledReason ? <Txt v="small" color={c.pink} a11y="composer-hint" style={{ paddingHorizontal: MARGIN, paddingTop: 8 }}>{hint ?? p.disabledReason}</Txt> : null}
      {/* Icons sit in a box exactly one input line tall and stay at the bottom as the input grows. They are
          drawn shapes rather than glyphs, so font ascent/descent cannot push them off centre. */}
      <View style={{ flexDirection: "row", alignItems: "flex-end", paddingLeft: MARGIN }}>
        <View style={{ height: LINE_BOX, flexDirection: "row", alignItems: "center", gap: 18 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="composer-commands" onPress={p.onOpenCommands} hitSlop={12} style={{ width: 16, height: 20, alignItems: "center", justifyContent: "center" }}>
            <View style={{ width: 2, height: 21, backgroundColor: c.ink, transform: [{ rotate: "22deg" }] }} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="composer-image" onPress={() => void pick()} disabled={p.disabled} hitSlop={12} style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }}>
            <View style={{ position: "absolute", width: 16, height: 2, backgroundColor: p.imagesAllowed && !p.disabled ? c.ink : c.faint }} />
            <View style={{ position: "absolute", width: 2, height: 16, backgroundColor: p.imagesAllowed && !p.disabled ? c.ink : c.faint }} />
          </Pressable>
        </View>
        <TextInput
          accessibilityLabel="composer-input"
          value={p.text}
          onChangeText={p.setText}
          editable={!p.disabled}
          multiline
          scrollEnabled
          // Android grows a multiline input by itself; the web textarea needs its height set from the content.
          onContentSizeChange={WEB ? (e) => setWebH(Math.min(MAX_H, Math.max(LINE_BOX, Math.ceil(e.nativeEvent.contentSize.height)))) : undefined}
          submitBehavior="newline"
          placeholder={p.disabled ? "not connected" : p.running ? (mode === "steer" ? "steer pi while it works…" : "queue a message for later…") : "write to pi…"}
          placeholderTextColor={c.faint}
          style={{
            flex: 1, minHeight: LINE_BOX, maxHeight: MAX_H, ...(WEB ? { height: webH } : {}), color: c.ink,
            paddingHorizontal: 14, paddingTop: PAD_V, paddingBottom: PAD_V, fontFamily: F.cjkSans, fontSize: 16, lineHeight: LINE,
            textAlignVertical: "top", includeFontPadding: false,
          }}
        />
        <Pressable accessibilityRole="button" accessibilityLabel="composer-send" onPress={() => void send()} disabled={!canSend}
          style={({ pressed }) => ({ width: 58, minHeight: LINE_BOX, alignSelf: "stretch", backgroundColor: canSend ? (p.running && mode === "steer" ? c.blue : c.ink) : c.tint, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.8 : 1 })}>
          {sending ? <Spinner color={c.invert} /> : <Txt v="title" color={canSend ? c.invert : c.faint}>→</Txt>}
          {p.running && !sending ? <Txt v="label" color={canSend ? c.invert : c.faint} style={{ fontSize: 9 }}>{mode === "steer" ? "now" : "after"}</Txt> : null}
        </Pressable>
      </View>
    </View>
  );
}
