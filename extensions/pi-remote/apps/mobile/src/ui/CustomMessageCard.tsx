import { useState } from "react";
import { View } from "react-native";
import type { WireMessage } from "@pi-remote/protocol";
import { textOf } from "../lib/format";
import { openSessionFile } from "../lib/nav";
import { Badge, Btn, T } from "./kit";
import { Markdown } from "./Markdown";
import { usePalette } from "./theme";

const KIND: Record<string, string> = { task: "Task", message: "Message", report: "Report", question: "Question", cc: "CC" };
const STATUS: Record<string, string> = { done: "Done", progress: "In progress", blocked: "Blocked", failed: "Failed" };

function Collapsible({ text, lines, a11y }: { text: string; lines: number; a11y: string }) {
  const [open, setOpen] = useState(false);
  const all = text.split("\n");
  const long = all.length > lines;
  return (
    <View>
      <Markdown text={open || !long ? text : all.slice(0, lines).join("\n")} />
      {long ? <Btn small a11y={a11y} label={open ? "Collapse" : `Show more (${all.length} lines)`} onPress={() => setOpen(!open)} style={{ alignSelf: "flex-start" }} /> : null}
    </View>
  );
}

export function CustomMessageCard({ m, idx }: { m: WireMessage; idx: number }) {
  const c = usePalette();
  const type = String(m.customType ?? "custom");
  const d = (m.details ?? {}) as Record<string, any>;
  const text = textOf(m.content);
  const box = { borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.cardAlt, padding: 10, gap: 6, marginVertical: 4 };
  const viewBtn = typeof d.sessionFile === "string"
    ? <Btn small a11y={`custom-open-child-${idx}`} label="View subagent session" onPress={() => openSessionFile(d.sessionFile)} style={{ alignSelf: "flex-start" }} />
    : null;
  switch (type) {
    case "subagent_result":
      return (
        <View accessibilityLabel={`custom-subagent_result-${idx}`} style={box}>
          <T bold>Subagent {d.name ?? ""}{d.agent ? ` (${d.agent})` : ""} finished</T>
          <T dim size={12}>{d.elapsed !== undefined ? `Elapsed ${d.elapsed}s` : ""}{d.exitCode !== undefined ? ` · exit code ${d.exitCode}` : ""}</T>
          {d.errorMessage || d.error ? <T color={c.danger} size={13}>{String(d.errorMessage ?? d.error)}</T> : null}
          <Collapsible text={text} lines={12} a11y={`custom-more-${idx}`} />
          {viewBtn}
        </View>
      );
    case "subagent_ping":
      return (
        <View accessibilityLabel={`custom-subagent_ping-${idx}`} style={{ ...box, borderColor: c.warn }}>
          <T bold color={c.warn}>Subagent {d.name ?? ""} asks for help</T>
          <Markdown text={String(d.message ?? text)} />
          {viewBtn}
        </View>
      );
    case "subagent_status":
      return (
        <View accessibilityLabel={`custom-subagent_status-${idx}`} style={{ marginVertical: 2 }}>
          {(Array.isArray(d.lines) ? d.lines : [text]).map((l: string, i: number) => <T key={i} dim size={12}>{l}</T>)}
          {d.overflow ? <T dim size={12}>…and {d.overflow} more</T> : null}
        </View>
      );
    case "subagent_model_fallback":
    case "team_notice":
      return <T a11y={`custom-${type}-${idx}`} dim size={12} style={{ marginVertical: 2 }}>{text}</T>;
    case "team_message": {
      const items = Array.isArray(d.items) ? d.items : undefined;
      if (!items) return <View accessibilityLabel={`custom-team_message-${idx}`} style={box}><Markdown text={text} /></View>;
      return (
        <View accessibilityLabel={`custom-team_message-${idx}`} style={box}>
          {items.map((it: Record<string, any>, i: number) => {
            const stColor = it.status === "done" ? c.ok : it.status === "failed" || it.status === "blocked" ? c.danger : c.accent;
            return (
              <View key={i} style={{ gap: 4, paddingVertical: 4 }}>
                <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                  <Badge label={String(it.from ?? "?")} color={c.accent} />
                  {it.kind ? <Badge label={KIND[it.kind] ?? String(it.kind)} color={c.dim} /> : null}
                  {it.status ? <Badge label={STATUS[it.status] ?? String(it.status)} color={stColor} /> : null}
                </View>
                <Collapsible text={String(it.body ?? "")} lines={8} a11y={`custom-more-${idx}-${i}`} />
              </View>
            );
          })}
        </View>
      );
    }
    default:
      return (
        <View accessibilityLabel={`custom-${type}-${idx}`} style={box}>
          <T dim size={12} bold>{type}</T>
          <Markdown text={text} />
        </View>
      );
  }
}
