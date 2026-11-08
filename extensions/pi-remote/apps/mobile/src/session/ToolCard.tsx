import { memo, useState } from "react";
import { Pressable, View } from "react-native";
import type { WireMessage } from "@pi-remote/protocol";
import { Button, Spinner, Txt } from "../ds/primitives";
import { usePalette } from "../ds/tokens";
import { textOf } from "../lib/format";
import { openSessionFile } from "../lib/nav";
import { useTestAction } from "../lib/test-hooks";
import { FoldBar, useAnchor } from "./anchor";
import { FileRow } from "./FileRow";
import { PatchView } from "./PatchView";
import { toolSummary } from "./toolSummary";

const MAX_LINES = 200;

/** A tool call set as a line of mono: state mark, command, result folded beneath. */
function ToolCardInner(props: { id: string; name: string; args: unknown; result?: WireMessage; running?: { partialText: string }; pending?: boolean }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const r = props.result as (WireMessage & { isError?: boolean; truncated?: boolean; details?: Record<string, unknown> }) | undefined;
  const isError = !!r?.isError;
  const live = !!props.running || !!props.pending;
  const text = r ? textOf(r.content) : "";
  const lines = text.split("\n");
  const patch = props.name === "edit" && typeof r?.details?.patch === "string" ? (r.details.patch as string) : undefined;
  const childFile = (props.name === "subagent" || props.name === "subagent_resume") ? ((r?.details?.sessionFile ?? r?.details?.sessionPath) as string | undefined) : undefined;
  const sent = props.name === "send_to_phone" && !isError && Array.isArray(r?.details?.transfers)
    ? (r!.details!.transfers as { id: string; name: string; size: number }[]).filter((x) => x && typeof x.id === "string")
    : undefined;
  const color = isError ? p.danger : live ? p.blue : p.soft;
  const anchor = useAnchor();
  const toggle = () => { anchor("top"); setOpen((o) => !o); };
  useTestAction(`tool-toggle-${props.id}`, toggle);
  return (
    <View accessibilityLabel={`tool-${props.id}`} style={{ marginVertical: 3 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`tool-toggle-${props.id}`} onPress={toggle} style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ width: 16, minHeight: 18, justifyContent: live ? "center" : "flex-start", alignSelf: "flex-start" }}>{live ? <Spinner color={p.blue} /> : <Txt v="mono" color={color}>{isError ? "✕" : open ? "−" : "+"}</Txt>}</View>
        <Txt v="mono" color={isError ? p.danger : p.ink} style={{ flex: 1 }} lines={open ? undefined : 2}>{toolSummary(props.name, props.args)}</Txt>
      </Pressable>
      {props.running?.partialText ? (
        <Txt v="mono" soft style={{ marginLeft: 24, fontSize: 11 }}>{props.running.partialText.split("\n").slice(-20).join("\n")}</Txt>
      ) : null}
      {open && r ? (
        <View style={{ marginLeft: 24, marginTop: 6, gap: 6, borderLeftWidth: 1, borderLeftColor: p.faint, paddingLeft: 10 }}>
          {patch ? <PatchView patch={patch} /> : text ? (
            <Txt v="mono" selectable style={{ fontSize: 11.5 }}>{(all ? lines : lines.slice(0, MAX_LINES)).join("\n")}</Txt>
          ) : <Txt v="small" soft>no output</Txt>}
          {!patch && lines.length > MAX_LINES && !all ? <Button a11y={`tool-showall-${props.id}`} label={`show all ${lines.length} lines`} onPress={() => { anchor("top"); setAll(true); }} /> : null}
          {r.truncated ? <Txt v="label" soft>truncated for the phone</Txt> : null}
          <FoldBar a11y={`tool-fold-${props.id}`} onFold={() => { setOpen(false); setAll(false); }} />
        </View>
      ) : null}
      {sent?.length ? (
        // Files offered to the phone stay visible: they are something to act on, not a log to fold away.
        <View accessibilityLabel={`tool-files-${props.id}`} style={{ marginLeft: 24, marginTop: 4, borderLeftWidth: 2, borderLeftColor: p.pink, paddingLeft: 10 }}>
          {sent.map((f) => <FileRow key={f.id} id={f.id} known={{ name: f.name, size: f.size }} />)}
        </View>
      ) : null}
      {childFile ? <View style={{ marginLeft: 24, marginTop: 4 }}><Button a11y={`tool-open-child-${props.id}`} label="open the subagent →" color={p.blue} onPress={() => openSessionFile(childFile)} /></View> : null}
    </View>
  );
}

export const ToolCard = memo(ToolCardInner);
