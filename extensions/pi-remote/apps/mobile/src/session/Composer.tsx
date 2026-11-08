import * as ImagePicker from "expo-image-picker";
import { useMemo, useState } from "react";
import { Image, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formatBytes, type CommandInfo, type DeliverAs, type ImageInput, type TransferInfo } from "@pi-remote/protocol";
import { Choice, Sheet, Spinner, Txt } from "../ds/primitives";
import { withAttachments } from "../lib/attach";
import { pickFiles } from "../lib/pick";
import { cancel as cancelTransfer, uploadFiles, useTransfers } from "../state/transfers";
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
  /** File attachments (7.7.5): ids of uploads; undefined when hostd or the platform has no file support. */
  files?: { processId: string; ids: string[]; setIds: (ids: string[]) => void };
}

const MAX_FILES = 10;

/** An upload riding along with the message being written. */
function AttachmentChip({ id, onRemove }: { id: string; onRemove: () => void }) {
  const c = usePalette();
  const t = useTransfers((s) => s.items[id]) as TransferInfo | undefined;
  const pr = useTransfers((s) => s.progress[id]);
  const done = t?.state === "done";
  const failed = !t || t.state === "cancelled" || t.state === "expired" || t.state === "failed" || (!!pr?.final && !!pr.error);
  const pct = t && t.size ? Math.floor(((done ? t.size : pr?.bytes ?? 0) / t.size) * 100) : 100;
  const col = failed ? c.danger : done ? c.ink : c.blue;
  useTestAction(`composer-file-remove-${id}`, onRemove);
  return (
    <View accessibilityLabel={`composer-file-${id}`} style={{ borderWidth: 1, borderColor: failed ? c.danger : c.faint, paddingLeft: 8, paddingRight: 4, paddingVertical: 4, flexDirection: "row", alignItems: "center", gap: 8, maxWidth: 260 }}>
      <Txt v="mono" color={c.blue} style={{ fontFamily: F.monoBold }}>↑</Txt>
      <View style={{ flexShrink: 1 }}>
        <Txt v="mono" lines={1} style={{ fontSize: 12 }}>{t?.name ?? "file"}</Txt>
        <Txt v="label" color={col} style={{ fontSize: 9.5 }}>{failed ? (pr?.error ?? "failed") : done ? formatBytes(t!.size) : `uploading ${pct}%`}</Txt>
        {!done && !failed ? <View style={{ height: 2, backgroundColor: c.faint, marginTop: 2 }}><View style={{ height: 2, width: `${pct}%`, backgroundColor: c.blue }} /></View> : null}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={`composer-file-remove-${id}`} onPress={onRemove} hitSlop={10} style={{ width: 22, height: 22, alignItems: "center", justifyContent: "center" }}>
        <View style={{ position: "absolute", width: 12, height: 1.5, backgroundColor: c.soft, transform: [{ rotate: "45deg" }] }} />
        <View style={{ position: "absolute", width: 12, height: 1.5, backgroundColor: c.soft, transform: [{ rotate: "-45deg" }] }} />
      </Pressable>
    </View>
  );
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
  const [attachOpen, setAttachOpen] = useState(false);
  useTestInput("composer-input", p.setText);
  const fileIds = p.files?.ids ?? [];
  const items = useTransfers((s) => s.items);
  const progress = useTransfers((s) => s.progress);
  const attached = fileIds.map((id) => items[id]).filter((t): t is TransferInfo => !!t);
  const uploading = attached.filter((t) => t.state !== "done");
  const uploadPct = (() => {
    const total = uploading.reduce((n, t) => n + t.size, 0);
    const got = uploading.reduce((n, t) => n + (progress[t.id]?.bytes ?? 0), 0);
    return total ? Math.floor((got / total) * 100) : 0;
  })();
  const uploadsFailed = uploading.some((t) => t.state === "cancelled" || t.state === "expired" || t.state === "failed" || (progress[t.id]?.final && progress[t.id]?.error));

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

  const attachFiles = async () => {
    setAttachOpen(false);
    if (!p.files) return;
    try {
      const picked = await pickFiles();
      if (!picked?.length) return;
      const room = MAX_FILES - p.files.ids.length;
      if (picked.length > room) setHint(`Up to ${MAX_FILES} files per message.`);
      const made = await uploadFiles(picked.slice(0, Math.max(room, 0)), p.files.processId);
      p.files.setIds([...p.files.ids, ...made.map((t) => t.id)]);
    } catch (e) { setHint((e as { message?: string })?.message ?? String(e)); }
  };
  const removeFile = (id: string) => {
    if (!p.files) return;
    const t = items[id];
    if (t && t.state !== "done") void cancelTransfer(id);
    p.files.setIds(p.files.ids.filter((x) => x !== id));
  };
  const onPlus = () => {
    if (p.files) { setAttachOpen(true); return; }
    void pick();
  };

  const send = async () => {
    testLog("send", { sending, disabled: p.disabled, len: p.text.length, files: fileIds.length });
    if (sending || p.disabled) return;
    if (!p.text.trim() && !images.length && !attached.length) return;
    if (uploading.length) { setHint(uploadsFailed ? "An upload failed. Remove it to send." : `Uploading… ${uploadPct}%`); return; }
    if (attached.length && p.text.trimStart().startsWith("/")) { setHint("Files go with a message, not with a command."); return; }
    setSending(true);
    setHint(undefined);
    try {
      const ok = await p.onSend(withAttachments(p.text, attached), images.map(({ data, mimeType }) => ({ data, mimeType })), p.running ? mode : undefined);
      if (ok) { setImages([]); p.files?.setIds([]); }
    } finally { setSending(false); }
  };
  useTestAction("composer-send", p.disabled ? undefined : () => void send());
  useTestAction("composer-stop", p.running ? p.onAbort : undefined);
  useTestAction("composer-mode-steer", p.running ? () => setMode("steer") : undefined);
  useTestAction("composer-mode-followup", p.running ? () => setMode("followUp") : undefined);
  useTestAction("composer-commands", p.onOpenCommands);
  useTestAction("composer-image", p.disabled ? undefined : onPlus);

  const canSend = !p.disabled && (!!p.text.trim() || images.length > 0 || attached.length > 0) && !uploading.length;
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
      {fileIds.length ? (
        <ScrollView horizontal accessibilityLabel="composer-files" contentContainerStyle={{ gap: 8, paddingHorizontal: MARGIN, paddingTop: 10 }}>
          {fileIds.map((id) => <AttachmentChip key={id} id={id} onRemove={() => removeFile(id)} />)}
        </ScrollView>
      ) : null}
      {uploading.length && !hint ? <Txt v="small" color={uploadsFailed ? c.danger : c.blue} a11y="composer-upload-hint" style={{ paddingHorizontal: MARGIN, paddingTop: 6 }}>{uploadsFailed ? "An upload failed. Remove it to send." : `Uploading… ${uploadPct}% — send is ready when it finishes`}</Txt> : null}
      {hint || p.disabledReason ? <Txt v="small" color={c.pink} a11y="composer-hint" style={{ paddingHorizontal: MARGIN, paddingTop: 8 }}>{hint ?? p.disabledReason}</Txt> : null}
      {/* Icons sit in a box exactly one input line tall and stay at the bottom as the input grows. They are
          drawn shapes rather than glyphs, so font ascent/descent cannot push them off centre. */}
      <View style={{ flexDirection: "row", alignItems: "flex-end", paddingLeft: MARGIN }}>
        <View style={{ height: LINE_BOX, flexDirection: "row", alignItems: "center", gap: 18 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="composer-commands" onPress={p.onOpenCommands} hitSlop={12} style={{ width: 16, height: 20, alignItems: "center", justifyContent: "center" }}>
            <View style={{ width: 2, height: 21, backgroundColor: c.ink, transform: [{ rotate: "22deg" }] }} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="composer-image" onPress={onPlus} disabled={p.disabled} hitSlop={12} style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }}>
            <View style={{ position: "absolute", width: 16, height: 2, backgroundColor: (p.imagesAllowed || p.files) && !p.disabled ? c.ink : c.faint }} />
            <View style={{ position: "absolute", width: 2, height: 16, backgroundColor: (p.imagesAllowed || p.files) && !p.disabled ? c.ink : c.faint }} />
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
      <Sheet visible={attachOpen} a11y="attach-sheet" kicker="add to the message" title="Attach" onClose={() => setAttachOpen(false)}>
        <Choice a11y="composer-attach-image" label="Image for the model" strong
          sub={p.imagesAllowed ? "pi looks at the picture itself" : "this model cannot read images; switch the model first"}
          disabled={!p.imagesAllowed} onPress={() => { setAttachOpen(false); void pick(); }} />
        <Choice a11y="composer-attach-file" label="File to the computer" strong
          sub={`any file, saved on the computer; pi gets its path${fileIds.length ? ` · ${fileIds.length} attached` : ""}`}
          disabled={fileIds.length >= MAX_FILES} onPress={() => void attachFiles()} />
      </Sheet>
    </View>
  );
}
