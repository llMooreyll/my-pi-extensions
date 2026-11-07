import { memo, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import type { WireMessage } from "@pi-remote/protocol";
import { textOf } from "../lib/format";
import { openSessionFile } from "../lib/nav";
import { Btn, T } from "./kit";
import { PatchView } from "./PatchView";
import { usePalette } from "./theme";
import { toolSummary } from "./toolSummary";

const MAX_LINES = 200;

function ToolCallCardInner(props: { id: string; name: string; args: unknown; result?: WireMessage; running?: { partialText: string }; pendingArgs?: boolean }) {
  const c = usePalette();
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const r = props.result as (WireMessage & { isError?: boolean; truncated?: boolean; details?: Record<string, unknown> }) | undefined;
  const isError = !!r?.isError;
  const text = r ? textOf(r.content) : "";
  const lines = text.split("\n");
  const shown = all ? lines : lines.slice(0, MAX_LINES);
  const patch = props.name === "edit" && typeof r?.details?.patch === "string" ? (r.details.patch as string) : undefined;
  const childFile = (props.name === "subagent" || props.name === "subagent_resume")
    ? ((r?.details?.sessionFile ?? r?.details?.sessionPath) as string | undefined) : undefined;
  const summary = toolSummary(props.name, props.args);
  return (
    <View accessibilityLabel={`tool-${props.id}`} style={{ borderWidth: 1, borderColor: isError ? c.danger : c.border, borderRadius: 8, backgroundColor: c.cardAlt, marginVertical: 3 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`tool-toggle-${props.id}`} onPress={() => setOpen(!open)} style={{ padding: 8, flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
        {props.running || props.pendingArgs ? <ActivityIndicator size="small" /> : <T dim size={12}>{open ? "▾" : "▸"}</T>}
        <T mono size={12} style={{ flex: 1 }} numberOfLines={open ? undefined : 3}>{summary}</T>
        {isError ? <T size={12} color={c.danger}>error</T> : null}
      </Pressable>
      {props.running && props.running.partialText ? (
        <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
          <T mono size={11} dim>{props.running.partialText.split("\n").slice(-20).join("\n")}</T>
        </View>
      ) : null}
      {open && r ? (
        <View style={{ paddingHorizontal: 8, paddingBottom: 8, gap: 6 }}>
          {patch ? <PatchView patch={patch} /> : text ? <T mono size={11} selectable>{shown.join("\n")}</T> : <T dim size={12}>(no output)</T>}
          {!patch && lines.length > MAX_LINES && !all ? <Btn small a11y={`tool-showall-${props.id}`} label={`Show all ${lines.length} lines`} onPress={() => setAll(true)} /> : null}
          {r.truncated ? <T dim size={11}>(output truncated)</T> : null}
        </View>
      ) : null}
      {childFile ? <Btn small a11y={`tool-open-child-${props.id}`} label="View subagent" onPress={() => openSessionFile(childFile)} style={{ margin: 8, marginTop: 0, alignSelf: "flex-start" }} /> : null}
    </View>
  );
}

export const ToolCallCard = memo(ToolCallCardInner);
