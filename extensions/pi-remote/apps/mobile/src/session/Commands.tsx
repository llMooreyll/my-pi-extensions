import { Fragment } from "react";
import { Pressable, View } from "react-native";
import type { CommandInfo } from "@pi-remote/protocol";
import { Sheet, Txt } from "../ds/primitives";
import { F, GUTTER, usePalette } from "../ds/tokens";
import { useTestAction } from "../lib/test-hooks";

export type DeckAction = "model" | "thinking" | "outline" | "tree" | "fork" | "clone" | "new" | "resume" | "compact" | "rename" | "reload" | "copy" | "info" | "settings" | "restart" | "quit";

interface Entry { action: DeckAction; title: string; note: string; needsIdle?: boolean; mainOnly?: boolean; danger?: boolean }

const GROUPS: { title: string; entries: Entry[] }[] = [
  { title: "How pi thinks", entries: [
    { action: "model", title: "Model", note: "switch the model for this session" },
    { action: "thinking", title: "Thinking", note: "how long it may reason" },
  ] },
  { title: "Move through the conversation", entries: [
    { action: "outline", title: "Outline", note: "every turn at a glance; show, copy, redo or fork from one" },
    { action: "tree", title: "Session tree", note: "all branches; go back to any point" },
    { action: "fork", title: "Fork from a message", note: "new session before one of your messages", needsIdle: true },
    { action: "clone", title: "Clone this session", note: "new session with everything so far", needsIdle: true },
    { action: "compact", title: "Compact the context", note: "summarise older messages", needsIdle: true },
  ] },
  { title: "Sessions", entries: [
    { action: "new", title: "Start fresh", note: "new empty session in this pi", needsIdle: true },
    { action: "resume", title: "Open another session", note: "switch this pi to an older one", needsIdle: true },
    { action: "rename", title: "Rename", note: "give this session a name" },
  ] },
  { title: "This pi", entries: [
    { action: "restart", title: "Restart pi", note: "quit and reopen this conversation with current extensions and tools", mainOnly: true },
    { action: "quit", title: "Close pi", note: "quit pi on the computer; the conversation stays on disk", danger: true },
  ] },
  { title: "Utilities", entries: [
    { action: "copy", title: "Copy the last answer", note: "to the clipboard" },
    { action: "reload", title: "Reload pi", note: "extensions, skills, prompts" },
    { action: "info", title: "About this pi", note: "folder, file, pane" },
    { action: "settings", title: "Settings", note: "pi settings and connection" },
  ] },
];

function DeckRow({ e, n, disabled, onPress }: { e: Entry; n: string; disabled: boolean; onPress: () => void }) {
  const p = usePalette();
  useTestAction(`deck-${e.action}`, onPress, !disabled);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`deck-${e.action}`} onPress={onPress} disabled={disabled}
      style={({ pressed }) => ({ flexDirection: "row", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: p.faint, backgroundColor: pressed ? p.tint : "transparent", opacity: disabled ? 0.35 : 1 })}>
      <Txt v="label" soft style={{ width: GUTTER, paddingTop: 6 }}>{n}</Txt>
      <View style={{ flex: 1 }}>
        <Txt v="title" color={e.danger ? p.danger : undefined} style={{ fontSize: 22, lineHeight: 26 }}>{e.title}</Txt>
        <Txt v="small" soft>{e.note}{disabled ? " — wait until pi is idle" : ""}</Txt>
      </View>
    </Pressable>
  );
}

function ExtRow({ c, onPick }: { c: CommandInfo; onPick: () => void }) {
  const p = usePalette();
  useTestAction(`deck-ext-${c.name}`, onPick);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`deck-ext-${c.name}`} onPress={onPick}
      style={({ pressed }) => ({ flexDirection: "row", paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: p.faint, backgroundColor: pressed ? p.tint : "transparent" })}>
      <Txt v="mono" style={{ fontFamily: F.monoBold, width: 150 }} lines={1}>/{c.name}</Txt>
      <Txt v="small" soft lines={2} style={{ flex: 1 }}>{c.description ?? c.source}</Txt>
    </Pressable>
  );
}

/** Every session command, written out, so nothing depends on knowing slash commands. */
export function CommandsSheet(props: { visible: boolean; running: boolean; canRestart: boolean; commands: CommandInfo[]; onAction: (a: DeckAction) => void; onInsert: (text: string) => void; onClose: () => void }) {
  let n = 0;
  const ext = props.commands.filter((c) => c.source === "extension");
  const other = props.commands.filter((c) => c.source !== "extension");
  return (
    <Sheet visible={props.visible} a11y="deck" kicker="everything you can do here" title="Commands" onClose={props.onClose}>
      {GROUPS.map((g) => (
        <Fragment key={g.title}>
          <Txt v="em" style={{ marginTop: 22, marginBottom: 4 }}>{g.title}</Txt>
          {g.entries.filter((e) => !e.mainOnly || props.canRestart).map((e) => <DeckRow key={e.action} e={e} n={String(++n).padStart(2, "0")} disabled={!!e.needsIdle && props.running} onPress={() => props.onAction(e.action)} />)}
        </Fragment>
      ))}
      {ext.length ? <Txt v="em" style={{ marginTop: 22, marginBottom: 4 }}>From your extensions</Txt> : null}
      {ext.map((c) => <ExtRow key={c.name} c={c} onPick={() => props.onInsert(`/${c.name} `)} />)}
      {other.length ? <Txt v="em" style={{ marginTop: 22, marginBottom: 4 }}>Prompts and skills</Txt> : null}
      {other.map((c) => <ExtRow key={c.name} c={c} onPick={() => props.onInsert(`/${c.name} `)} />)}
    </Sheet>
  );
}
