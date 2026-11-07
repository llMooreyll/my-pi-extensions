import { useState } from "react";
import { View } from "react-native";
import type { WireMessage } from "@pi-remote/protocol";
import { Button, Txt } from "../ds/primitives";
import { usePalette } from "../ds/tokens";
import { textOf } from "../lib/format";
import { openSessionFile } from "../lib/nav";
import { FoldBar, useAnchor } from "./anchor";
import { Markdown } from "./Markdown";

function Folded({ text, lines, a11y }: { text: string; lines: number; a11y: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useAnchor();
  const all = text.split("\n");
  const long = all.length > lines;
  return (
    <View>
      <Markdown text={open || !long ? text : all.slice(0, lines).join("\n")} />
      {long && !open ? <Button a11y={a11y} label={`read all ${all.length} lines`} onPress={() => { anchor("top"); setOpen(true); }} /> : null}
      {long && open ? <FoldBar a11y={a11y} onFold={() => setOpen(false)} /> : null}
    </View>
  );
}

/** Messages that extensions inject (subagents, team mail), set as dispatches with a small-caps dateline. */
export function CustomCard({ m, idx }: { m: WireMessage; idx: number }) {
  const p = usePalette();
  const type = String(m.customType ?? "custom");
  const d = (m.details ?? {}) as Record<string, any>;
  const text = textOf(m.content);
  const open = typeof d.sessionFile === "string"
    ? <Button a11y={`custom-open-child-${idx}`} label="open the subagent session →" color={p.blue} onPress={() => openSessionFile(d.sessionFile)} />
    : null;
  const dateline = (s: string, color?: string) => <Txt v="label" color={color ?? p.soft}>{s}</Txt>;
  switch (type) {
    case "subagent_result":
      return (
        <View accessibilityLabel={`custom-subagent_result-${idx}`} style={{ gap: 6, marginVertical: 6 }}>
          {dateline(`dispatch — subagent ${d.name ?? ""}${d.agent ? ` (${d.agent})` : ""} finished${d.elapsed !== undefined ? ` · ${d.elapsed}s` : ""}${d.exitCode ? ` · exit ${d.exitCode}` : ""}`, d.exitCode ? p.danger : p.blue)}
          {d.errorMessage || d.error ? <Txt v="small" color={p.danger}>{String(d.errorMessage ?? d.error)}</Txt> : null}
          <Folded text={text} lines={12} a11y={`custom-more-${idx}`} />
          {open}
        </View>
      );
    case "subagent_ping":
      return (
        <View accessibilityLabel={`custom-subagent_ping-${idx}`} style={{ gap: 6, marginVertical: 6 }}>
          {dateline(`subagent ${d.name ?? ""} asks for help`, p.pink)}
          <Txt v="em">{String(d.message ?? text)}</Txt>
          {open}
        </View>
      );
    case "subagent_status":
      return (
        <View accessibilityLabel={`custom-subagent_status-${idx}`} style={{ marginVertical: 3 }}>
          {(Array.isArray(d.lines) ? d.lines : [text]).map((l: string, i: number) => <Txt key={i} v="mono" soft style={{ fontSize: 11 }}>{l}</Txt>)}
          {d.overflow ? <Txt v="mono" soft style={{ fontSize: 11 }}>…{d.overflow} more</Txt> : null}
        </View>
      );
    case "subagent_model_fallback":
    case "team_notice":
      return <Txt a11y={`custom-${type}-${idx}`} v="mono" soft style={{ fontSize: 11, marginVertical: 3 }}>— {text}</Txt>;
    case "team_message": {
      const items = Array.isArray(d.items) ? d.items : undefined;
      if (!items) return <View accessibilityLabel={`custom-team_message-${idx}`}><Markdown text={text} /></View>;
      return (
        <View accessibilityLabel={`custom-team_message-${idx}`} style={{ marginVertical: 6, gap: 10 }}>
          {items.map((it: Record<string, any>, i: number) => {
            const st = it.status === "failed" || it.status === "blocked" ? p.danger : it.status === "done" ? p.soft : p.blue;
            return (
              <View key={i} style={{ gap: 4 }}>
                {dateline(`team mail — from ${it.from ?? "?"}${it.kind ? ` · ${it.kind}` : ""}${it.status ? ` · ${it.status}` : ""}`, st)}
                <Folded text={String(it.body ?? "")} lines={8} a11y={`custom-more-${idx}-${i}`} />
              </View>
            );
          })}
        </View>
      );
    }
    default:
      return (
        <View accessibilityLabel={`custom-${type}-${idx}`} style={{ gap: 4, marginVertical: 6 }}>
          {dateline(type)}
          <Markdown text={text} />
        </View>
      );
  }
}
