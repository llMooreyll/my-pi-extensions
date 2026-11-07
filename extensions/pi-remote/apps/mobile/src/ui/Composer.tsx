import * as ImagePicker from "expo-image-picker";
import { useMemo, useState } from "react";
import { Image, Pressable, ScrollView, TextInput, View } from "react-native";
import type { CommandInfo, DeliverAs, ImageInput } from "@pi-remote/protocol";
import { BUILTIN_COMMANDS } from "../lib/slash";
import { useTestInput } from "../lib/test-hooks";
import { Btn, T } from "./kit";
import { usePalette } from "./theme";

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
}

export function Composer(p: ComposerProps) {
  const c = usePalette();
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
    if (!p.imagesAllowed) { setHint("The current model does not accept images"); return; }
    const r = await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.7, allowsMultipleSelection: true, selectionLimit: 4 - images.length, mediaTypes: ["images"] });
    if (r.canceled) return;
    const add = r.assets.filter((a) => a.base64).map((a) => ({ uri: a.uri, data: a.base64!, mimeType: a.mimeType ?? "image/jpeg" }));
    setImages((prev) => [...prev, ...add].slice(0, 4));
  };

  const send = async () => {
    if (sending) return;
    const text = p.text;
    if (!text.trim() && !images.length) return;
    setSending(true);
    setHint(undefined);
    try {
      const ok = await p.onSend(text, images.map(({ data, mimeType }) => ({ data, mimeType })), p.running ? mode : undefined);
      if (ok) setImages([]);
    } finally { setSending(false); }
  };

  return (
    <View accessibilityLabel="composer" style={{ borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.card, padding: 8, gap: 6 }}>
      {suggestions.length ? (
        <ScrollView accessibilityLabel="slash-menu" style={{ maxHeight: 220 }} keyboardShouldPersistTaps="handled">
          {suggestions.map((s) => (
            <Pressable key={`${s.source}:${s.name}`} accessibilityRole="button" accessibilityLabel={`slash-${s.name}`} onPress={() => p.setText(`/${s.name} `)}
              style={({ pressed }) => ({ paddingVertical: 6, paddingHorizontal: 8, borderRadius: 6, backgroundColor: pressed ? c.cardAlt : "transparent" })}>
              <T size={14} bold>/{s.name} <T dim size={12}>{s.source === "builtin" ? "" : `[${s.source}]`}</T></T>
              {s.description ? <T dim size={12} numberOfLines={1}>{s.description}</T> : null}
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {images.length ? (
        <ScrollView horizontal contentContainerStyle={{ gap: 6 }}>
          {images.map((im, i) => (
            <Pressable key={i} accessibilityLabel={`composer-image-${i}`} onPress={() => setImages(images.filter((_, j) => j !== i))}>
              <Image source={{ uri: im.uri }} style={{ width: 56, height: 56, borderRadius: 6 }} />
              <T size={11} dim>Remove</T>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {p.running ? (
        <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
          <Btn small a11y="composer-mode-steer" kind={mode === "steer" ? "primary" : "plain"} label="Steer" onPress={() => setMode("steer")} />
          <Btn small a11y="composer-mode-followup" kind={mode === "followUp" ? "primary" : "plain"} label="Queue" onPress={() => setMode("followUp")} />
          <View style={{ flex: 1 }} />
          <Btn small a11y="composer-stop" kind="danger" label="Stop" onPress={p.onAbort} />
        </View>
      ) : null}
      {hint || p.disabledReason ? <T size={12} color={c.warn} a11y="composer-hint">{hint ?? p.disabledReason}</T> : null}
      <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-end" }}>
        <Btn small a11y="composer-image" label="＋" disabled={p.disabled || !p.imagesAllowed} onPress={() => void pick()} />
        <TextInput
          accessibilityLabel="composer-input"
          value={p.text}
          onChangeText={p.setText}
          editable={!p.disabled}
          multiline
          submitBehavior="newline"
          placeholder={p.disabled ? "Not connected" : p.running ? "Message (agent is running)" : "Message pi"}
          placeholderTextColor={c.dim}
          style={{ flex: 1, maxHeight: 160, minHeight: 40, color: c.text, backgroundColor: c.cardAlt, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 }}
        />
        <Btn small a11y="composer-send" kind="primary" label="Send" busy={sending} disabled={p.disabled || (!p.text.trim() && !images.length)} onPress={() => void send()} />
      </View>
    </View>
  );
}
