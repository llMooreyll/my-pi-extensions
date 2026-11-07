import * as ImagePicker from "expo-image-picker";
import { useMemo, useState } from "react";
import { Image, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CommandInfo, DeliverAs, ImageInput } from "@pi-remote/protocol";
import { Button, Spinner, Txt } from "../ds/primitives";
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

export function Composer(p: ComposerProps) {
  const c = usePalette();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<DeliverAs>("steer");
  const [images, setImages] = useState<(ImageInput & { uri: string })[]>([]);
  const [sending, setSending] = useState(false);
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
  useTestAction("composer-mode-steer", p.running ? () => setMode("steer") : undefined);
  useTestAction("composer-mode-followup", p.running ? () => setMode("followUp") : undefined);
  useTestAction("composer-commands", p.onOpenCommands);
  useTestAction("composer-image", p.disabled ? undefined : () => void pick());

  const canSend = !p.disabled && (!!p.text.trim() || images.length > 0);
  return (
    <View accessibilityLabel="composer" style={{ backgroundColor: c.paper, paddingBottom: insets.bottom }}>
      <View style={{ height: 2, backgroundColor: c.ink }} />
      {suggestions.length ? (
        <ScrollView accessibilityLabel="slash-menu" style={{ maxHeight: 230, paddingHorizontal: MARGIN }} keyboardShouldPersistTaps="handled">
          {suggestions.map((s) => <Suggestion key={`${s.source}:${s.name}`} s={s} onPick={() => p.setText(`/${s.name} `)} />)}
        </ScrollView>
      ) : null}
      {p.running ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: MARGIN, paddingTop: 10 }}>
          <Spinner color={c.blue} />
          <Txt v="label" color={c.blue}>working</Txt>
          <View style={{ flex: 1 }} />
          <Pressable accessibilityRole="button" accessibilityLabel="composer-mode-steer" onPress={() => setMode("steer")} hitSlop={8}>
            <Txt v="label" color={mode === "steer" ? c.ink : c.faint} style={{ textDecorationLine: mode === "steer" ? "underline" : "none" }}>send now</Txt>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="composer-mode-followup" onPress={() => setMode("followUp")} hitSlop={8}>
            <Txt v="label" color={mode === "followUp" ? c.ink : c.faint} style={{ textDecorationLine: mode === "followUp" ? "underline" : "none" }}>send after</Txt>
          </Pressable>
          <Button a11y="composer-stop" label="stop" color={c.danger} onPress={p.onAbort} />
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
      <View style={{ flexDirection: "row", alignItems: "flex-end", paddingLeft: MARGIN }}>
        <View style={{ paddingBottom: 15, flexDirection: "row", gap: 14 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="composer-commands" onPress={p.onOpenCommands} hitSlop={10}>
            <Txt v="title" style={{ lineHeight: 24 }}>/</Txt>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="composer-image" onPress={() => void pick()} disabled={p.disabled} hitSlop={10}>
            <Txt v="title" color={p.imagesAllowed && !p.disabled ? c.ink : c.faint} style={{ lineHeight: 24 }}>+</Txt>
          </Pressable>
        </View>
        <TextInput
          accessibilityLabel="composer-input"
          value={p.text}
          onChangeText={p.setText}
          editable={!p.disabled}
          multiline
          submitBehavior="newline"
          placeholder={p.disabled ? "not connected" : p.running ? (mode === "steer" ? "steer pi while it works…" : "queue a message for later…") : "write to pi…"}
          placeholderTextColor={c.faint}
          style={{ flex: 1, maxHeight: 170, minHeight: 54, color: c.ink, paddingHorizontal: 14, paddingTop: 16, paddingBottom: 14, fontFamily: F.sans, fontSize: 16.5 }}
        />
        <Pressable accessibilityRole="button" accessibilityLabel="composer-send" onPress={() => void send()} disabled={!canSend}
          style={({ pressed }) => ({ width: 58, alignSelf: "stretch", backgroundColor: canSend ? (p.running && mode === "steer" ? c.blue : c.ink) : c.tint, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.8 : 1 })}>
          {sending ? <Spinner color={c.invert} /> : <Txt v="title" color={canSend ? c.invert : c.faint}>→</Txt>}
        </Pressable>
      </View>
    </View>
  );
}
